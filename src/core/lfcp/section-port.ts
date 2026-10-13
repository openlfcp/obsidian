// The section engine's port (core/sections/port.ts) on the real SDK
// (@openlfcp/*): the snapshot of a section's replica, commits
// through the sync client with durable receipts, and the receipts' store.
// SDK errors become the port's refusals; nothing is retried here.

import type { Receipt as SdkReceipt } from "@openlfcp/client";
import {
  type Flushed,
  NotWritableError,
  OperationIdReusedError,
  receiptOf,
  releaseReceipt,
  type WriteAccess as SdkWriteAccess,
  TypingCoalescer,
} from "@openlfcp/client";
import { fromBase64url, type ResourceId, resourceId, toHex } from "@openlfcp/core";
import type { Task, TaskView } from "@openlfcp/shared-objects";
import {
  SectionIntentError,
  type SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  CommitRefused,
  type Receipt,
  type SectionIntent,
  type SectionPort,
  type SectionSnapshot,
  type WriteAccess,
} from "../sections/port";
import type { RecoveryModel } from "../sections/recovery";
import { fromSdkSnapshot } from "../sections/sdk-snapshot";
import { type StaleWorkStore, touchedNodes } from "../sections/stale-work";

/** What the port needs from the runtime: open section Resources and their session. */
export interface SectionResources {
  /** The open Resource's sections profile, or undefined (not open, or another profile). */
  profile(resource: ResourceId): SharedSectionsDataProfile | undefined;
  /** SyncClient.commit on the Resource's session. */
  commit(
    resource: ResourceId,
    intents: readonly unknown[],
    options: { readonly operationId: string },
  ): Promise<SdkReceipt>;
  readonly storage: Pick<LfcpStorage, "localMarks" | "commit">;
  /** Write access from the validated Control state (contract §6): SyncClient.canWrite. */
  canWrite(resource: ResourceId): Promise<SdkWriteAccess>;
  /** Where each committed own operation is recorded, for re-applying stale work (§19.1). */
  readonly ownWork?: Pick<StaleWorkStore, "recordOwn">;
  readonly now?: () => number;
}

const asResource = (b64: string): ResourceId => resourceId(fromBase64url(b64));

/** What the port reads of a section replica for its snapshot. */
type SectionReplicaLike = NonNullable<ReturnType<SectionResources["profile"]>>["replica"];

/** An SDK commit error in the port's terms: a refusal (nothing written), or as it is. */
export function portRefusal(e: unknown): unknown {
  if (e instanceof SectionIntentError) return new CommitRefused(e.code, e.nodeId, e.intentIndex);
  if (e instanceof OperationIdReusedError) return new CommitRefused("OPERATION_ID_REUSED");
  // §3.6, §6: nothing was written; the edit stays a candidate.
  if (e instanceof NotWritableError)
    return new CommitRefused("NOT_WRITABLE", undefined, undefined, e.access.reason ?? "unknown");
  return e;
}

/** The SDK's write access in the port's terms (the head as hex). */
export const portAccess = (a: SdkWriteAccess): WriteAccess => ({
  allowed: a.allowed,
  ...(a.reason === null ? {} : { reason: a.reason }),
  ...(a.controlHead === null ? {} : { controlHead: toHex(a.controlHead) }),
  ...(a.verifiedAt === null ? {} : { verifiedAt: a.verifiedAt }),
});

/** The SDK's receipt in the port's terms (unit IDs as hex). */
export const portReceipt = (r: SdkReceipt): Receipt => ({
  operationId: r.operationId,
  unitIds: r.unitIds.map((u) => toHex(u)),
  affectedNodeIds: [...r.affectedNodeIds],
  modelRevision: r.modelRevision,
  intentsHash: r.intentsHash,
  durable: true,
});

/** Typing coalescing (LFCP-02-025): the timer's clock and where background commits are reported. */
export interface Coalescing {
  readonly now: () => number;
  /** A waiting pass committed (or failed) on a tick or a flush, out of any engine pass. */
  readonly onFlushed: (resource: string, f: Flushed) => void;
  readonly idleMs?: number;
}

export class SdkSectionPort implements SectionPort {
  readonly #coalescers = new Map<string, TypingCoalescer>();
  /** The tail of each Resource's queue of exclusive runs. */
  readonly #queues = new Map<string, Promise<void>>();
  /**
   * LFCP-02-068: the replica's snapshot by its revision. Reading it walks and
   * validates the whole document (hundreds of ms at W200), and the status,
   * the card and a pass ask for it again and again at one revision. A change
   * moves the revision, a rebuild replaces the replica: neither reads a stale one.
   */
  readonly #snapshots = new WeakMap<
    object,
    { readonly revision: string; readonly snapshot: ReturnType<SectionReplicaLike["snapshot"]> }
  >();
  constructor(
    private readonly resources: SectionResources,
    /** With it, passes of Text edits only coalesce (025); without, every pass commits at once. */
    private readonly coalescing?: Coalescing,
  ) {}

  snapshot(resource: string, sectionId: string): SectionSnapshot | undefined {
    const profile = this.resources.profile(asResource(resource));
    return profile === undefined
      ? undefined
      : fromSdkSnapshot(this.#replicaSnapshot(profile.replica), sectionId);
  }

  #replicaSnapshot(replica: SectionReplicaLike): ReturnType<SectionReplicaLike["snapshot"]> {
    const revision = replica.revision();
    const cached = this.#snapshots.get(replica);
    if (cached !== undefined && cached.revision === revision) return cached.snapshot;
    const snapshot = replica.snapshot();
    this.#snapshots.set(replica, { revision, snapshot });
    return snapshot;
  }

  /** The model as recovery reads it (061): one read of the tree, the snapshot and Task titles. */
  recoveryModel(resource: string, sectionId: string): RecoveryModel | undefined {
    const replica = this.resources.profile(asResource(resource))?.replica;
    if (replica === undefined) return undefined;
    return {
      sectionId,
      tree: replica.tree(),
      snapshot: this.#replicaSnapshot(replica),
      taskTitle: (taskId) => replica.task(taskId)?.task?.title,
      document: () => replica.toJSON(),
    };
  }

  /** A section Task with its conflict metadata (SectionReplica.task, the SOP §99 form). */
  taskView(resource: string, taskId: string): TaskView | undefined {
    return this.resources.profile(asResource(resource))?.replica.task(taskId);
  }

  /** A section Task as the model holds it; undefined when a visible value is invalid. */
  task(resource: string, taskId: string): Task | undefined {
    return this.taskView(resource, taskId)?.task;
  }

  async commit(
    resource: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<Receipt> {
    try {
      return portReceipt(await this.#commit(resource, intents, options));
    } catch (e) {
      throw portRefusal(e);
    }
  }

  /**
   * Every commit, direct or coalesced: recorded as an own operation, with
   * its nodes' fingerprints from before it (stale-work.ts), so that a Key
   * Epoch that cuts it off can have it re-applied.
   */
  async #commit(
    resource: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<SdkReceipt> {
    const own = this.resources.ownWork;
    const before = own === undefined ? {} : this.fingerprints(resource, touchedNodes(intents));
    const receipt = await this.resources.commit(asResource(resource), intents, options);
    if (own !== undefined && receipt.unitIds.length > 0)
      await own
        .recordOwn({
          operationId: receipt.operationId,
          resource,
          unitIds: receipt.unitIds.map((u) => toHex(u)),
          intents,
          before,
          at: (this.resources.now ?? Date.now)(),
        })
        .catch(() => undefined);
    return receipt;
  }

  /**
   * Each node's state in the model now, as one string: the node, its place
   * (parent and previous sibling) and its Task's fields; "" when absent.
   * "section" is the section's title.
   */
  fingerprints(resource: string, ids: readonly string[]): Record<string, string> {
    const replica = this.resources.profile(asResource(resource))?.replica;
    const out: Record<string, string> = {};
    if (replica === undefined) {
      for (const id of ids) out[id] = "";
      return out;
    }
    const snap = this.#replicaSnapshot(replica);
    for (const id of ids) {
      if (id === "section") {
        out[id] = JSON.stringify(snap.title);
        continue;
      }
      const node = snap.nodes[id];
      if (node === undefined) {
        out[id] = "";
        continue;
      }
      const at = snap.order.findIndex((e) => e.id === id);
      let after: string | null = null;
      for (let i = at - 1; i >= 0; i--) {
        const e = snap.order[i];
        if (e !== undefined && e.parent === node.parent) {
          after = e.id;
          break;
        }
      }
      const task = node.taskId === undefined ? null : (replica.task(node.taskId)?.task ?? null);
      out[id] = JSON.stringify({ node, after: at < 0 ? null : after, task });
    }
    return out;
  }

  #coalescer(resource: string): TypingCoalescer | undefined {
    const c = this.coalescing;
    if (c === undefined) return undefined;
    let t = this.#coalescers.get(resource);
    if (t === undefined) {
      t = new TypingCoalescer({
        commit: (intents, o) => this.#commit(resource, intents as readonly SectionIntent[], o),
        onFlushed: (f) => c.onFlushed(resource, f),
        now: c.now,
        ...(c.idleMs === undefined ? {} : { idleMs: c.idleMs }),
      });
      this.#coalescers.set(resource, t);
    }
    return t;
  }

  submit = async (
    resource: string,
    key: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<
    | { readonly kind: "committed"; readonly receipt: Receipt; readonly replaced: string | null }
    | { readonly kind: "deferred"; readonly replaced: string | null }
  > => {
    const t = this.#coalescer(resource);
    if (t === undefined)
      return {
        kind: "committed",
        receipt: await this.commit(resource, intents, options),
        replaced: null,
      };
    try {
      const r = await t.submit(key, intents, options);
      return r.kind === "committed"
        ? { kind: "committed", receipt: portReceipt(r.receipt), replaced: r.replaced }
        : { kind: "deferred", replaced: r.replaced };
    } catch (e) {
      throw portRefusal(e);
    }
  };

  waiting(resource: string, key: string): string | undefined {
    return this.#coalescers.get(resource)?.waiting(key);
  }

  async flush(resource: string, key: string): Promise<void> {
    await this.#coalescers.get(resource)?.flush(key);
  }

  /** The coalescers' timer: commits what waited long enough, never during a pass. */
  async tick(now: number): Promise<void> {
    for (const [resource, t] of this.#coalescers) await this.exclusive(resource, () => t.tick(now));
  }

  /** Commits everything that waits (closing, unloading). */
  async flushAll(): Promise<void> {
    for (const [resource, t] of this.#coalescers) await this.exclusive(resource, () => t.flush());
  }

  /** One run at a time per Resource: a pass, a tick, a flushAll (SectionPort.exclusive). */
  exclusive<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(resource) ?? Promise.resolve();
    const run = before.then(fn);
    const after = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(resource, after);
    void after.then(() => {
      if (this.#queues.get(resource) === after) this.#queues.delete(resource);
    });
    return run;
  }

  async receiptOf(resource: string, operationId: string): Promise<Receipt | undefined> {
    const r = await receiptOf(this.resources.storage, asResource(resource), operationId);
    return r === undefined ? undefined : portReceipt(r);
  }

  releaseReceipt(resource: string, operationId: string): Promise<void> {
    return releaseReceipt(this.resources.storage, asResource(resource), operationId);
  }

  async canWrite(resource: string): Promise<WriteAccess> {
    return portAccess(await this.resources.canWrite(asResource(resource)));
  }
}
