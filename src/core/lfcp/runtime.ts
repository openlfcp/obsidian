// The plugin's LFCP runtime (LFCP-059): this vault's install, one SyncClient
// per server endpoint, Resources opened on demand, and the local Resource
// registry. Obsidian-free: the adapter supplies storage, secrets, timers and
// the WebSocket. Everything protocol-related is the SDK's.
//
// Lifecycle: start() is local only (Automerge init, install, writer lock)
// and never waits for the network, so Resources stay usable offline.
// stop() stops every session and timer, flushes profile checkpoints, closes
// the database and releases the lock. Pending outbound objects are durable
// in storage and survive it.

import {
  DataUnitApplier,
  dekResolver,
  OutboundQueue,
  ProfileCheckpointer,
  type ResourcePhase,
  SyncClient,
  type SyncEvent,
  startSyncDriver,
  type WebSocketFactory,
} from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import {
  initializeAutomerge,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
} from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  createInstall,
  type Install,
  type InstallEnv,
  LOCK_MESSAGES,
  type LockReason,
  openInstall,
} from "./install";

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

/** A held writer lock (navigator.locks). */
export interface HeldLock {
  release(): void;
}

export interface RuntimeEnv extends InstallEnv {
  readonly timers: Timers;
  /** The WebSocket constructor (default: the platform's). */
  readonly webSocket?: WebSocketFactory;
  /** Takes the install's writer lock, or null when another instance holds it. */
  acquireLock?(name: string): Promise<HeldLock | null>;
  /** Initializes Automerge's wasm before any replica exists (default: the SDK's). */
  initializeAutomerge?(): Promise<void>;
  /** How often the sync driver ticks (default 250 ms). */
  readonly tickMs?: number;
}

export type RuntimeStatus =
  | {
      readonly kind: "ready";
      readonly principalId: PrincipalId;
      readonly persisted: boolean | null;
    }
  | {
      readonly kind: "locked";
      readonly reason: LockReason;
      readonly message: string;
      readonly principalId: PrincipalId | null;
    }
  | { readonly kind: "stopped" };

/** The registry's view of a Resource (OBSIDIAN-ARCHITECTURE-01 §27). */
export type RegistryState = "available" | "offline" | "locked" | "error" | "control_conflict";

export interface RegistryEntry {
  readonly resourceId: ResourceId;
  /** Local display name (a label; never sent). */
  readonly localName: string | null;
  readonly profile: string;
  /** Endpoint URLs from the stored route, by priority. */
  readonly routes: readonly string[];
  /** Hex of the stored, validated Control Head. */
  readonly lastKnownControlHead: string | null;
  readonly state: RegistryState;
}

/** An opened Resource: its Shared Objects state and session phase. */
export interface OpenResource {
  readonly resourceId: ResourceId;
  readonly profile: SharedObjectsDataProfile;
  readonly url: string;
}

interface Pooled {
  readonly client: SyncClient;
  readonly stopDriver: () => void;
  readonly unsubscribe: () => void;
}

interface Opened extends OpenResource {
  readonly checkpointer: ProfileCheckpointer;
}

export class LfcpRuntime {
  readonly #env: RuntimeEnv;
  #install: Install;
  #lock: HeldLock | null;
  #outbound: OutboundQueue | null = null;
  readonly #pool = new Map<string, Pooled>();
  readonly #opened = new Map<string, Opened>();
  readonly #phases = new Map<string, ResourcePhase>();
  readonly #errors = new Map<string, string>();
  readonly #listeners = new Set<(e: SyncEvent) => void>();
  #stopped = false;

  private constructor(env: RuntimeEnv, install: Install, lock: HeldLock | null) {
    this.#env = env;
    this.#install = install;
    this.#lock = lock;
  }

  /** Local startup only: Automerge, the install, the writer lock. Never waits for the network. */
  static async start(env: RuntimeEnv): Promise<LfcpRuntime> {
    // Before any replica exists (the slim Automerge build needs it; a no-op otherwise).
    await (env.initializeAutomerge ?? initializeAutomerge)();
    const install = await openInstall(env);
    const lock = await LfcpRuntime.#takeLock(env, install.installId);
    if (lock === undefined) {
      install.storage?.close();
      return new LfcpRuntime(
        env,
        {
          kind: "locked",
          installId: install.installId,
          reason: "lock-held",
          principalId: install.kind === "ready" ? install.principal.id : install.principalId,
          storage: null,
        },
        null,
      );
    }
    return new LfcpRuntime(env, install, lock);
  }

  /** The lock, null when the runtime has no lock support, undefined when another instance holds it. */
  static async #takeLock(env: RuntimeEnv, installId: string): Promise<HeldLock | null | undefined> {
    if (env.acquireLock === undefined) return null;
    return (await env.acquireLock(`openlfcp-${installId}`)) ?? undefined;
  }

  get status(): RuntimeStatus {
    if (this.#stopped) return { kind: "stopped" };
    const i = this.#install;
    return i.kind === "ready"
      ? { kind: "ready", principalId: i.principal.id, persisted: i.persisted }
      : {
          kind: "locked",
          reason: i.reason,
          message: LOCK_MESSAGES[i.reason],
          principalId: i.principalId,
        };
  }

  /** This vault's LFCP storage (public objects and local state; never secrets), or null while unavailable. */
  get storage(): LfcpStorage | null {
    return this.#stopped ? null : this.#install.storage;
  }

  /** Session events of every pooled client. */
  on(listener: (e: SyncEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The number of live server sessions (one per endpoint in use). */
  get sessions(): number {
    return this.#pool.size;
  }

  /**
   * Local Resource metadata. Head, conflict and routes always come from the
   * stored, signed Control state; only the local name is the plugin's own.
   */
  async registry(): Promise<RegistryEntry[]> {
    const storage = this.#install.storage;
    if (storage === null) return [];
    const out: RegistryEntry[] = [];
    for (const row of await storage.resources.list()) {
      const R = row.resourceId;
      const key = toHex(R);
      const route = await storage.resources.route(R);
      const head = await storage.control.head(R);
      const conflict = await storage.control.conflict(R);
      const phase = this.#phases.get(key);
      const state: RegistryState =
        conflict !== undefined || phase === "CONTROL_CONFLICT"
          ? "control_conflict"
          : this.#install.kind === "locked"
            ? "locked"
            : this.#errors.has(key)
              ? "error"
              : phase === "LIVE"
                ? "available"
                : "offline";
      out.push(
        Object.freeze({
          resourceId: R,
          localName: row.labels.name ?? null,
          profile: row.dataProfile,
          routes: [...(route?.endpoints ?? [])]
            .sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0))
            .map((e) => e.url),
          lastKnownControlHead: head === undefined ? null : toHex(head.head),
          state,
        }),
      );
    }
    return out;
  }

  /** Sets a Resource's local display name (a label; the signed state is untouched). */
  async setLocalName(resource: ResourceId, name: string | null): Promise<void> {
    const storage = this.#install.storage;
    const row = await storage?.resources.get(resource);
    if (storage === null || row === undefined) throw new Error("unknown Resource");
    const { name: _old, ...rest } = row.labels;
    const labels = name === null ? rest : { ...rest, name };
    const r = await storage.commit([{ op: "put-resource", row: { ...row, labels } }]);
    if (!r.ok) throw new Error(r.reason);
  }

  /**
   * Opens a stored Resource on demand: its Shared Objects state restored
   * from its checkpoint, and a session on its coordinator's endpoint (one
   * SyncClient per endpoint, shared). Returns at once; syncing continues in
   * the background.
   */
  async openResource(resource: ResourceId): Promise<OpenResource> {
    const key = toHex(resource);
    const existing = this.#opened.get(key);
    if (existing !== undefined) return existing;
    const i = this.#install;
    if (this.#stopped || i.kind !== "ready") throw new Error("OpenLFCP is not ready");
    const { storage, secrets, principal } = i;
    if ((await storage.resources.get(resource)) === undefined) throw new Error("unknown Resource");
    const route = await storage.resources.route(resource);
    const url = route?.coordinatorUrl;
    if (url === undefined) throw new Error("no known route for this Resource");

    const options = { resource, principal: principal.id };
    const checkpoint = await storage.profileState.checkpoint(resource);
    const profile =
      checkpoint === undefined
        ? new SharedObjectsDataProfile(SharedObjectsReplica.empty(options))
        : SharedObjectsDataProfile.restore(checkpoint, options);
    const applier = new DataUnitApplier({
      storage,
      dek: dekResolver(storage, secrets, resource),
      handlers: [
        {
          dataProfile: profile.dataProfile,
          codecFor: (u) => profile.codecFor(u),
          apply: (u, v) => profile.apply(u, v as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    });
    const checkpointer = new ProfileCheckpointer(storage, profile, { minIntervalMs: 2000 });
    const { client } = this.#session(url);
    client.open({
      resourceId: resource,
      applier,
      checkpointer,
      snapshot: {
        codec: profile.snapshotCodec(),
        load: (s) => void profile.loadSnapshot(s as Uint8Array),
        current: () => profile.snapshotState(),
      },
    });
    const opened: Opened = { resourceId: resource, profile, url, checkpointer };
    this.#opened.set(key, opened);
    return opened;
  }

  #session(url: string): Pooled {
    const pooled = this.#pool.get(url);
    if (pooled !== undefined) return pooled;
    const i = this.#install;
    if (i.kind !== "ready") throw new Error("OpenLFCP is not ready");
    this.#outbound ??= new OutboundQueue({ storage: i.storage });
    const client = new SyncClient({
      url,
      signer: i.principal.signer,
      agreement: i.principal.agreement,
      storage: i.storage,
      secrets: i.secrets,
      outbound: this.#outbound,
      now: () => this.#env.timers.now(),
      ...(this.#env.webSocket === undefined ? {} : { webSocket: this.#env.webSocket }),
    });
    const unsubscribe = client.on((e) => this.#onEvent(e));
    client.start();
    const stopDriver = startSyncDriver(client, this.#env.timers, this.#env.tickMs ?? 250);
    const created: Pooled = { client, stopDriver, unsubscribe };
    this.#pool.set(url, created);
    return created;
  }

  #onEvent(e: SyncEvent): void {
    if (e.type === "resource-state") {
      this.#phases.set(toHex(e.resourceId), e.state);
      if (e.state === "LIVE") this.#errors.delete(toHex(e.resourceId));
    } else if (e.type === "error" && e.resourceId !== undefined) {
      this.#errors.set(toHex(e.resourceId), e.code);
    }
    for (const l of this.#listeners) l(e);
  }

  /** The session phase of an opened Resource ("CLOSED" when not open). */
  phase(resource: ResourceId): ResourcePhase {
    return this.#phases.get(toHex(resource)) ?? "CLOSED";
  }

  /**
   * Stops every session and timer, flushes checkpoints, closes the database
   * and releases the lock. Pending outbound objects stay stored.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const p of this.#pool.values()) {
      p.stopDriver();
      p.unsubscribe();
    }
    await Promise.allSettled([...this.#pool.values()].map((p) => p.client.stop()));
    this.#pool.clear();
    const now = this.#env.timers.now();
    await Promise.allSettled(
      [...this.#opened.values()]
        .filter((o) => o.checkpointer.dirty)
        .map((o) => o.checkpointer.flush(now)),
    );
    this.#opened.clear();
    this.#install.storage?.close();
    this.#lock?.release();
    this.#lock = null;
    this.#listeners.clear();
  }

  /**
   * After a lock: a new install with a new Principal. The old namespace is
   * left as it is, never reused. Only allowed while locked.
   */
  async createNewPrincipal(): Promise<void> {
    if (this.#install.kind !== "locked" || this.#install.reason === "lock-held")
      throw new Error("a new Principal is only offered when this vault's state is locked");
    this.#install.storage?.close();
    this.#lock?.release();
    const install = await createInstall(this.#env);
    const lock = await LfcpRuntime.#takeLock(this.#env, install.installId);
    if (lock === undefined) throw new Error("the new install's lock is held");
    this.#install = install;
    this.#lock = lock;
  }
}
