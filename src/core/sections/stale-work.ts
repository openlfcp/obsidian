// Own work a Key Epoch cut off, re-applied in the current epoch
// (LFCP-WIRE-01 §19.1, G-EP5 for shared sections). Obsidian-free.
//
// A member who worked offline while someone else's access was removed
// (the Data Epoch rotated) comes back with units beyond the closed epoch's
// final frontier: the SDK quarantines them and rebuilds the replica
// without them. §19.1: that stale work is surfaced, and work the
// application keeps is re-applied as new units in the current epoch. Up
// to 0.4.0-beta.14 sections did neither. The next pass took the rebuilt
// model's older values for a remote change and wrote them over the note,
// so a title edit or a move was silently undone, and a new Task stayed in
// the note but in no model.
//
// - Every commit records its operation: units, intents, and a fingerprint
//   of each node it touches as the model was before it (recordOwn).
// - A cut (the units quarantined) marks those operations stale, "pending".
// - reapplyStale re-commits each pending operation's intents under a
//   fixed operation ID (`<id>:reapply`): a second run after a restart gets
//   the receipt back and writes nothing, so nothing is applied twice, and
//   a creation keeps its ID. It runs on the rebuilt model, after any
//   remote change the rebuild brought, so its units come causally after
//   them.
// - A node changed meanwhile (its fingerprint differs: someone else edited
//   or moved it), or a refused commit, is not re-sent: the operation goes
//   to "review" (Review conflicts: Keep re-sends it, Discard drops it).
// - While a section has pending or review work, its passes are skipped
//   (engine "stale-work"): the note keeps the user's text and is never
//   overwritten by the rebuilt model, and the section needs attention.

import type { SectionIntent, SectionPort } from "./port";
import { CommitRefused } from "./port";

/** One committed operation of this device, as recordOwn keeps it. */
export interface OwnOperation {
  readonly operationId: string;
  readonly resource: string;
  /** Its Data Units (hex). */
  readonly unitIds: readonly string[];
  readonly intents: readonly SectionIntent[];
  /** Each touched node's fingerprint before the commit ("" when it did not exist). */
  readonly before: Readonly<Record<string, string>>;
  /** Commit order. */
  readonly at: number;
}

export type StaleState = "pending" | "review" | "done" | "discarded";

/** An operation a Key Epoch cut off, and what became of it. */
export interface StaleOperation extends OwnOperation {
  readonly state: StaleState;
  /** Why it waits for review: "changed" (edited meanwhile) or the refusal's code. */
  readonly reason?: string;
}

/** The operation ID a re-apply commits under: fixed, so it is applied once. */
export const reapplyId = (operationId: string): string => `${operationId}:reapply`;

/** The nodes an intent touches (the section itself as "section"). */
export function touchedNodes(intents: readonly SectionIntent[]): string[] {
  const out = new Set<string>();
  for (const i of intents) {
    if (i.intent === "section.create" || i.intent === "section.set_title") out.add("section");
    else if (i.intent === "task.create_in_section") out.add(i.task.id);
    else if (i.intent === "structure.resolve") for (const m of i.moves) out.add(m.id);
    else if ("id" in i && typeof i.id === "string") out.add(i.id);
  }
  return [...out];
}

/** Durable store of own operations and stale ones (device-local state). */
export interface StaleWorkStore {
  /** A committed own operation (kept for the latest few hundred per Resource). */
  recordOwn(op: OwnOperation): Promise<void>;
  /** The own operations of `resource` whose units include any of `unitIds`, now stale (pending), once. */
  cut(resource: string, unitIds: readonly string[]): Promise<StaleOperation[]>;
  /** Own operations recorded for `resource` (for a scan of quarantined units at start). */
  own(resource: string): Promise<OwnOperation[]>;
  /** Stale operations still pending or waiting for review, oldest first. */
  open(resource?: string): Promise<StaleOperation[]>;
  /** Stale operations of `resource` re-applied or discarded (their own batches are settled). */
  settled(resource: string): Promise<string[]>;
  put(op: StaleOperation): Promise<void>;
}

interface KeyValue {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  update(key: string, change: (value: unknown) => unknown): Promise<void>;
}

const OWN = (resource: string) => `section-own-ops:${resource}`;
const STALE = (operationId: string) => `section-stale:${operationId}`;
const OPEN = "section-stale-open";
const SETTLED = (resource: string) => `section-stale-settled:${resource}`;
const KEEP = 500;

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export class KeyValueStaleWorkStore implements StaleWorkStore {
  constructor(private readonly kv: KeyValue) {}

  async recordOwn(op: OwnOperation): Promise<void> {
    await this.kv.update(OWN(op.resource), (v) => {
      const ops = (Array.isArray(v) ? (v as OwnOperation[]) : []).filter(
        (o) => o.operationId !== op.operationId,
      );
      ops.push(op);
      return ops.slice(-KEEP);
    });
  }

  async own(resource: string): Promise<OwnOperation[]> {
    const v = await this.kv.get(OWN(resource));
    return Array.isArray(v) ? (v as OwnOperation[]) : [];
  }

  async cut(resource: string, unitIds: readonly string[]): Promise<StaleOperation[]> {
    const units = new Set(unitIds);
    const out: StaleOperation[] = [];
    for (const op of await this.own(resource)) {
      if (!op.unitIds.some((u) => units.has(u))) continue;
      if ((await this.kv.get(STALE(op.operationId))) != null) continue;
      const stale: StaleOperation = { ...op, state: "pending" };
      await this.put(stale);
      out.push(stale);
    }
    return out;
  }

  async open(resource?: string): Promise<StaleOperation[]> {
    const out: StaleOperation[] = [];
    for (const id of list(await this.kv.get(OPEN))) {
      const op = (await this.kv.get(STALE(id))) as StaleOperation | null | undefined;
      if (op == null || (resource !== undefined && op.resource !== resource)) continue;
      if (op.state === "pending" || op.state === "review") out.push(op);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async settled(resource: string): Promise<string[]> {
    return list(await this.kv.get(SETTLED(resource)));
  }

  async put(op: StaleOperation): Promise<void> {
    await this.kv.put(STALE(op.operationId), op);
    if (op.state === "done" || op.state === "discarded")
      await this.kv.update(SETTLED(op.resource), (v) =>
        [...list(v).filter((x) => x !== op.operationId), op.operationId].slice(-KEEP),
      );
    const open = op.state === "pending" || op.state === "review";
    await this.kv.update(OPEN, (v) => {
      const ids = list(v).filter((x) => x !== op.operationId);
      return open ? [...ids, op.operationId] : ids;
    });
  }
}

/** The same store in memory (tests). */
export class MemoryStaleWorkStore extends KeyValueStaleWorkStore {
  constructor() {
    const m = new Map<string, unknown>();
    super({
      get: async (k) => m.get(k),
      put: async (k, v) => void m.set(k, v),
      update: async (k, f) => void m.set(k, f(m.get(k))),
    });
  }
}

export interface ReapplyDeps {
  readonly port: Pick<SectionPort, "commit" | "canWrite" | "receiptOf">;
  readonly store: StaleWorkStore;
  /** Each node's fingerprint in the model now ("" when absent). */
  readonly fingerprints: (resource: string, ids: readonly string[]) => Record<string, string>;
}

/** What a re-apply run did: "waiting" when it could not run (no write access, no answer). */
export interface ReapplyResult {
  readonly done: readonly string[];
  readonly review: readonly string[];
  readonly waiting: boolean;
  /** Why it waits, when it does (no write access, or the commit's unknown outcome). */
  readonly reason?: string;
}

/**
 * Re-applies `resource`'s pending stale operations in commit order, as new
 * units. `force` (Review conflicts: Keep) re-sends the listed operations
 * even when their nodes changed meanwhile.
 */
export async function reapplyStale(
  deps: ReapplyDeps,
  resource: string,
  force: ReadonlySet<string> = new Set(),
): Promise<ReapplyResult> {
  const done: string[] = [];
  const review: string[] = [];
  for (const op of await deps.store.open(resource)) {
    const forced = force.has(op.operationId);
    if (op.state !== "pending" && !forced) continue;
    const access = await deps.port.canWrite(resource);
    if (!access.allowed)
      return {
        done,
        review,
        waiting: true,
        reason: `no write access (${access.reason ?? "unknown"})`,
      };
    if (!forced) {
      const now = deps.fingerprints(resource, Object.keys(op.before));
      const changed = Object.entries(op.before).some(([id, fp]) => (now[id] ?? "") !== fp);
      if (changed) {
        await deps.store.put({ ...op, state: "review", reason: "changed" });
        review.push(op.operationId);
        continue;
      }
    }
    try {
      await deps.port.commit(resource, op.intents, { operationId: reapplyId(op.operationId) });
    } catch (error) {
      if (error instanceof CommitRefused) {
        await deps.store.put({ ...op, state: "review", reason: error.code });
        review.push(op.operationId);
        continue;
      }
      // Unknown outcome: the receipt decides; without one, it waits for the next run.
      if ((await deps.port.receiptOf(resource, reapplyId(op.operationId))) === undefined)
        return {
          done,
          review,
          waiting: true,
          reason: String((error as Error)?.message ?? error),
        };
    }
    const { reason: _reason, ...rest } = op;
    await deps.store.put({ ...rest, state: "done" });
    done.push(op.operationId);
  }
  return { done, review, waiting: false };
}

/** What an operation did, in a few words (Review conflicts). */
export function staleLabel(op: Pick<OwnOperation, "intents">): string {
  const words = op.intents.map((i) => {
    switch (i.intent) {
      case "task.create_in_section":
        return `new task "${i.task.title}"`;
      case "paragraph.create":
      case "item.create":
      case "raw.create":
        return `new text "${i.text.split("\n")[0]?.slice(0, 40) ?? ""}"`;
      case "node.move":
      case "structure.resolve":
      case "node.resolve_placement":
        return "a move";
      case "node.delete":
        return "a deletion";
      case "node.restore":
        return "a restore";
      case "text.edit":
        return "a text edit";
      case "section.set_title":
        return `section title "${i.title}"`;
      default: {
        const t = i as { intent: string; title?: unknown };
        return t.intent === "task.set_title" && typeof t.title === "string"
          ? `task title "${t.title}"`
          : "a task change";
      }
    }
  });
  const shown = [...new Set(words)];
  return shown.length <= 2 ? shown.join(", ") : `${shown.slice(0, 2).join(", ")} and more`;
}

/** Review conflicts: Discard. The operation is dropped; the shared version stays. */
export async function discardStale(store: StaleWorkStore, operationId: string): Promise<void> {
  for (const op of await store.open())
    if (op.operationId === operationId) await store.put({ ...op, state: "discarded" });
}

/** What the controller needs from the port: one run at a time per Resource, and fingerprints. */
export interface StalePort extends Pick<SectionPort, "commit" | "canWrite" | "receiptOf"> {
  exclusive<T>(resource: string, fn: () => Promise<T>): Promise<T>;
  fingerprints(resource: string, ids: readonly string[]): Record<string, string>;
}

/**
 * Stale work of every section Resource of this device: cut on a Key Epoch
 * (or found at start), guarded, re-applied, reviewed. The host feeds it the
 * runtime's events; `changed` is told when a Resource's notes should pass
 * again (their stale work done or discarded).
 */
/** How soon waiting stale work is tried again. */
const RETRY_MS = 3000;

export class StaleWorkController {
  readonly #open = new Map<string, readonly StaleOperation[]>();
  readonly #guard = new Set<string>();
  /**
   * Own units not known to be accepted yet, by Resource: only those can be
   * cut off by a Key Epoch (the cutoff is the accepted frontier). Few: the
   * work of an offline period.
   */
  readonly #unsettled = new Map<string, Set<string>>();
  readonly #running = new Map<string, Promise<ReapplyResult>>();
  readonly #settled = new Map<string, ReadonlySet<string>>();
  readonly #retry = new Set<string>();
  readonly #last = new Map<string, { readonly result?: ReapplyResult; readonly error?: string }>();

  constructor(
    private readonly o: {
      readonly store: StaleWorkStore;
      readonly port: StalePort;
      /** A stored own unit (hex): quarantined (cut off), and still queued to be sent. */
      readonly unit: (
        unitId: string,
      ) => Promise<{ readonly quarantined: boolean; readonly queued: boolean }>;
      readonly changed: (resource: string) => void;
      readonly failed?: (error: unknown) => void;
      /**
       * Whether the Resource is caught up with the server (live, current at
       * its checkpoint): re-applying waits for it, so the re-applied work
       * comes after every remote change the server has, and a node someone
       * else changed meanwhile is seen as changed (review), never overwritten.
       */
      readonly ready?: (resource: string) => boolean | Promise<boolean>;
      /** The timer for retries (the window's in Obsidian). */
      readonly setTimer: (fn: () => void, ms: number) => unknown;
      /** Units of work re-applied or discarded: their stale outbound items go. */
      readonly settle?: (unitIds: readonly string[]) => Promise<void>;
    },
  ) {}

  /** Where the port records each own operation: kept, and its units watched until settled. */
  readonly ownWork: Pick<StaleWorkStore, "recordOwn"> = {
    recordOwn: async (op) => {
      await this.o.store.recordOwn(op);
      const set = this.#unsettled.get(op.resource) ?? new Set<string>();
      for (const u of op.unitIds) set.add(u);
      this.#unsettled.set(op.resource, set);
    },
  };

  /** Whether `resource`'s passes wait (the engine's staleWork). */
  waiting(resource: string): boolean {
    return this.#guard.has(resource) || (this.#open.get(resource)?.length ?? 0) > 0;
  }

  /**
   * Before a pass: whether it must wait. Besides open work, an own unit
   * found quarantined that no cut announced yet (the rebuilt model can
   * reach a pass before the Key Epoch's event does) is cut now, and the
   * pass waits. Settled units are dropped from the watch.
   */
  async check(resource: string): Promise<boolean> {
    if (this.waiting(resource)) return true;
    const set = this.#unsettled.get(resource);
    if (set === undefined || set.size === 0) return false;
    const cut: string[] = [];
    for (const u of [...set]) {
      const s = await this.o.unit(u);
      if (s.quarantined) cut.push(u);
      else if (!s.queued) set.delete(u);
    }
    if (cut.length === 0) return this.waiting(resource);
    for (const u of cut) set.delete(u);
    this.epochReconciled(resource, cut);
    return true;
  }

  /** What the controller knows of `resource` (diagnostics, tests). */
  diagnostics(resource: string): Record<string, unknown> {
    return {
      guard: this.#guard.has(resource),
      open: (this.#open.get(resource) ?? []).map((op) => [
        op.operationId,
        op.state,
        op.reason ?? null,
      ]),
      unsettled: [...(this.#unsettled.get(resource) ?? [])].length,
      running: this.#running.has(resource),
      last: this.#last.get(resource) ?? null,
    };
  }

  /** Pending and review counts, for the status. */
  counts(resource: string): { readonly pending: number; readonly review: number } {
    const open = this.#open.get(resource) ?? [];
    return {
      pending:
        open.filter((op) => op.state === "pending").length + (this.#guard.has(resource) ? 1 : 0),
      review: open.filter((op) => op.state === "review").length,
    };
  }

  /** The operations waiting for review. */
  review(resource: string): readonly StaleOperation[] {
    return (this.#open.get(resource) ?? []).filter((op) => op.state === "review");
  }

  /**
   * A Key Epoch cut off these units of `resource`: the guard is set at once,
   * before any pass of the rebuilt model; then they are cut and re-applied.
   */
  epochReconciled(resource: string, units: readonly string[]): void {
    if (units.length === 0) return;
    this.#guard.add(resource);
    void this.#cut(resource, units).catch((e) => this.o.failed?.(e));
  }

  /** Something happened on the Resource (live again, access checked): pending work goes on. */
  live(resource: string): void {
    if ((this.#open.get(resource) ?? []).some((op) => op.state === "pending"))
      void this.reapply(resource).catch((e) => this.o.failed?.(e));
  }

  /** At start: own units already quarantined are cut, queued ones watched; open work goes on. */
  async scan(resource: string): Promise<void> {
    const cut: string[] = [];
    const set = this.#unsettled.get(resource) ?? new Set<string>();
    for (const op of await this.o.store.own(resource))
      for (const u of op.unitIds) {
        const s = await this.o.unit(u);
        if (s.quarantined) cut.push(u);
        else if (s.queued) set.add(u);
      }
    if (set.size > 0) this.#unsettled.set(resource, set);
    if (cut.length > 0) await this.o.store.cut(resource, cut);
    await this.#refresh(resource);
    // Re-applied or discarded before the restart, their stale units not
    // discarded yet: settled now (else an update waits for good).
    const settled = this.settled(resource);
    const left: string[] = [];
    for (const op of await this.o.store.own(resource))
      if (settled.has(op.operationId))
        for (const u of op.unitIds) if ((await this.o.unit(u)).queued) left.push(u);
    if (left.length > 0 && this.o.settle !== undefined)
      await this.o.settle(left).catch((e) => this.o.failed?.(e));
    if ((this.#open.get(resource)?.length ?? 0) > 0) await this.reapply(resource);
  }

  async #cut(resource: string, units: readonly string[]): Promise<void> {
    try {
      await this.o.store.cut(resource, units);
      await this.#refresh(resource);
    } finally {
      this.#guard.delete(resource);
    }
    await this.reapply(resource);
  }

  /**
   * Own operations re-applied or discarded: the SDK keeps their original
   * batches pending (their units are quarantined), so the status leaves
   * them out.
   */
  settled(resource: string): ReadonlySet<string> {
    return this.#settled.get(resource) ?? new Set();
  }

  async #refresh(resource: string): Promise<void> {
    this.#settled.set(resource, new Set(await this.o.store.settled(resource)));
    const open = await this.o.store.open(resource);
    if (open.length === 0) this.#open.delete(resource);
    else this.#open.set(resource, open);
  }

  /** Re-applies pending work (and `force`: these under review, Keep), alone as a pass; one run at a time. */
  async reapply(resource: string, force: ReadonlySet<string> = new Set()): Promise<ReapplyResult> {
    const running = this.#running.get(resource);
    if (running !== undefined) {
      await running.catch(() => undefined);
      if (force.size === 0) return running;
    }
    const run = this.#reapply(resource, force);
    this.#running.set(resource, run);
    try {
      const result = await run;
      this.#last.set(resource, { result });
      // Waiting (no access yet, catching up): tried again soon, while work is pending.
      if (result.waiting && !this.#retry.has(resource)) {
        this.#retry.add(resource);
        this.o.setTimer(() => {
          this.#retry.delete(resource);
          this.live(resource);
        }, RETRY_MS);
      }
      return result;
    } catch (error) {
      this.#last.set(resource, { error: String((error as Error)?.message ?? error) });
      throw error;
    } finally {
      if (this.#running.get(resource) === run) this.#running.delete(resource);
    }
  }

  async #reapply(resource: string, force: ReadonlySet<string>): Promise<ReapplyResult> {
    const port = this.o.port;
    if (this.o.ready !== undefined && !(await this.o.ready(resource)))
      return { done: [], review: [], waiting: true, reason: "catching up with the server" };
    const result = await port.exclusive(resource, () =>
      reapplyStale(
        { port, store: this.o.store, fingerprints: (r, ids) => port.fingerprints(r, ids) },
        resource,
        force,
      ),
    );
    await this.#refresh(resource);
    await this.#settle(resource, result.done);
    if (result.done.length > 0 || !this.#open.has(resource)) this.o.changed(resource);
    return result;
  }

  async #settle(resource: string, operationIds: readonly string[]): Promise<void> {
    if (this.o.settle === undefined || operationIds.length === 0) return;
    const ids = new Set(operationIds);
    const units = (await this.o.store.own(resource))
      .filter((op) => ids.has(op.operationId))
      .flatMap((op) => op.unitIds);
    await this.o.settle(units).catch((e) => this.o.failed?.(e));
  }

  /** Review conflicts: Keep (send again as it was) or Discard. Returns what to tell the user. */
  async resolve(resource: string, operationId: string, keep: boolean): Promise<string> {
    if (keep) {
      await this.reapply(resource, new Set([operationId]));
      return (this.#open.get(resource) ?? []).some((op) => op.operationId === operationId)
        ? "It could not be sent yet; it stays here."
        : "Sent again.";
    }
    await discardStale(this.o.store, operationId);
    await this.#refresh(resource);
    await this.#settle(resource, [operationId]);
    this.o.changed(resource);
    return "Discarded: your note shows the shared version.";
  }
}
