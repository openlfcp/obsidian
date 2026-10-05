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
  createQueuedDataUnit,
  DataUnitApplier,
  dekResolver,
  loadControlChain,
  OutboundQueue,
  ProfileCheckpointer,
  type ResourcePhase,
  SyncClient,
  type SyncEvent,
  saveControlChain,
  startSyncDriver,
  type WebSocketFactory,
} from "@openlfcp/client";
import {
  type DataUnitId,
  dataEpoch,
  dataUnitId,
  fromHex,
  generateResourceId,
  hash32,
  type PrincipalId,
  type ResourceId,
  toHex,
} from "@openlfcp/core";
import { dekCommitment, exportSecretKeyBytes, generateResourceDEK } from "@openlfcp/crypto";
import {
  checkChange,
  initializeAutomerge,
  type ObjectChange,
  PROFILE_ID,
  type ReplicaIntent,
  SharedObjectsDataProfile,
  SharedObjectsReplica,
} from "@openlfcp/shared-objects";
import {
  dekSecretRef,
  type LfcpStorage,
  principalKeySecretRef,
  type SecretStore,
} from "@openlfcp/storage";
import { signControlRecord, validateControlChain } from "@openlfcp/wire";
import {
  createInstall,
  type Install,
  type InstallEnv,
  LOCK_MESSAGES,
  type LocalPrincipal,
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

/**
 * What the collaboration flows (LFCP-065: hosting, invitations, joining)
 * hand to the SDK. Never shown in the UI.
 */
export interface CollaborationContext {
  readonly storage: LfcpStorage;
  readonly secrets: SecretStore;
  readonly principal: LocalPrincipal;
  readonly now: () => number;
  readonly webSocket?: WebSocketFactory;
  /** The pooled session for an endpoint (started on first use). */
  session(url: string): SyncClient;
}

/** An opened Resource: its Shared Objects state and session phase. */
export interface OpenResource {
  readonly resourceId: ResourceId;
  readonly profile: SharedObjectsDataProfile;
  /** The endpoint of its session (null: local only so far). */
  readonly url: string | null;
}

interface Pooled {
  readonly client: SyncClient;
  readonly stopDriver: () => void;
  readonly unsubscribe: () => void;
}

interface Opened {
  readonly resourceId: ResourceId;
  readonly profile: SharedObjectsDataProfile;
  url: string | null;
  readonly checkpointer: ProfileCheckpointer;
  /** Set once a session serves the Resource. */
  applier: DataUnitApplier | null;
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
  #writes: Promise<void> = Promise.resolve();
  readonly #staleToDiscard = new Set<string>();
  readonly #objectListeners = new Set<(resource: ResourceId, change: ObjectChange) => void>();

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

  /**
   * Shared Object changes of every local profile: remote merges and G-EP7
   * rebuilds (origin "rebuild") as the profile reports them, and this
   * runtime's own writes (origin "local") once they are durable.
   */
  onObjectChanged(listener: (resource: ResourceId, change: ObjectChange) => void): () => void {
    this.#objectListeners.add(listener);
    return () => this.#objectListeners.delete(listener);
  }

  #emitObject(resource: ResourceId, change: ObjectChange): void {
    for (const l of this.#objectListeners) l(resource, change);
  }

  #watch(resource: ResourceId, profile: SharedObjectsDataProfile): void {
    profile.onObjectChanged((c) => this.#emitObject(resource, c));
  }

  /**
   * Small local, device-only state of the plugin (e.g. projection bases),
   * kept in this install's database next to the LFCP state. Never secrets.
   */
  readonly localState = {
    get: async (key: string): Promise<unknown> =>
      this.#stopped ? undefined : this.#install.storage?.meta.get(`plugin:${key}`),
    put: async (key: string, value: unknown): Promise<void> => {
      if (this.#stopped) return;
      await this.#install.storage?.meta.put(`plugin:${key}`, value);
    },
    /**
     * Read-modify-write of one key, one at a time per key: `change` sees
     * the value the previous update left, so concurrent updates never lose
     * each other's changes. The install lock makes this runtime the only
     * writer. Every read-modify-write of a key goes through here.
     */
    update: (key: string, change: (value: unknown) => unknown): Promise<void> => {
      const run = async () => {
        await this.localState.put(key, change(await this.localState.get(key)));
      };
      const done = (this.#updates.get(key) ?? Promise.resolve()).then(run, run);
      const tail = done.then(
        () => undefined,
        () => undefined,
      );
      this.#updates.set(key, tail);
      void tail.then(() => {
        if (this.#updates.get(key) === tail) this.#updates.delete(key);
      });
      return done;
    },
  };
  readonly #updates = new Map<string, Promise<void>>();

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
    const local = await this.#local(resource);
    if (local.applier !== null) return local;
    const i = this.#ready();
    const route = await i.storage.resources.route(resource);
    const url = route?.coordinatorUrl;
    if (url === undefined) throw new Error("no known route for this Resource");
    const profile = local.profile;
    const applier = new DataUnitApplier({
      storage: i.storage,
      dek: dekResolver(i.storage, i.secrets, resource),
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
    const { client } = this.#session(url);
    client.open({
      resourceId: resource,
      applier,
      checkpointer: local.checkpointer,
      snapshot: {
        codec: profile.snapshotCodec(),
        load: (s) => void profile.loadSnapshot(s as Uint8Array),
        current: () => profile.snapshotState(),
      },
    });
    local.applier = applier;
    local.url = url;
    return local;
  }

  #ready(): Extract<Install, { kind: "ready" }> {
    const i = this.#install;
    if (this.#stopped || i.kind !== "ready") throw new Error("OpenLFCP is not ready");
    return i;
  }

  /** A stored Resource's Shared Objects state, local only (no session). */
  async #local(resource: ResourceId): Promise<Opened> {
    const key = toHex(resource);
    const existing = this.#opened.get(key);
    if (existing !== undefined) return existing;
    const { storage, principal } = this.#ready();
    if ((await storage.resources.get(resource)) === undefined) throw new Error("unknown Resource");
    const options = { resource, principal: principal.id };
    const checkpoint = await storage.profileState.checkpoint(resource);
    const profile =
      checkpoint === undefined
        ? new SharedObjectsDataProfile(SharedObjectsReplica.empty(options))
        : SharedObjectsDataProfile.restore(checkpoint, options);
    const opened: Opened = {
      resourceId: resource,
      profile,
      url: null,
      checkpointer: new ProfileCheckpointer(storage, profile, { minIntervalMs: 2000 }),
      applier: null,
    };
    this.#opened.set(key, opened);
    this.#watch(resource, profile);
    return opened;
  }

  /**
   * G-EP5 support: which objects each of this Principal's own units changed,
   * per Resource (device-local state, kept for the latest 1000 units). Not
   * atomic with the unit's commit: a crash in between only means that unit
   * cannot be re-applied automatically if a Key Epoch later cuts it off.
   */
  async #rememberOwnUnit(resource: ResourceId, unit: DataUnitId, objects: readonly string[]) {
    if (objects.length === 0) return;
    await this.localState.update(`own-units:${toHex(resource)}`, (value) => {
      const map = { ...((value ?? {}) as Record<string, string[]>) };
      map[toHex(unit)] = [...objects];
      return Object.fromEntries(Object.entries(map).slice(-1000));
    });
  }

  /**
   * The objects of this Principal's own units that a Key Epoch cut off
   * (G-EP7: quarantined, no longer in the shared state). The caller re-applies
   * those intents as new units in the current epoch (G-EP5). Each cut unit is
   * reported once; its stale outbound item is discarded once it is blocked.
   */
  async cutOwnObjects(resource: ResourceId): Promise<string[]> {
    const storage = this.storage;
    if (storage === null) return [];
    const key = `own-units:${toHex(resource)}`;
    const map = ((await this.localState.get(key)) ?? {}) as Record<string, string[]>;
    const objects = new Set<string>();
    const cut: string[] = [];
    for (const [unitHex, ids] of Object.entries(map)) {
      const unitId = dataUnitId(fromHex(unitHex));
      if ((await storage.dataUnits.get(unitId))?.status !== "quarantined") continue;
      for (const id of ids) objects.add(id);
      cut.push(unitHex);
      this.#staleToDiscard.add(unitHex);
    }
    // Removes only the cut units: units remembered meanwhile stay.
    if (cut.length > 0)
      await this.localState.update(key, (value) => {
        const now = { ...((value ?? {}) as Record<string, string[]>) };
        for (const unitHex of cut) delete now[unitHex];
        return now;
      });
    await this.#discardStale();
    return [...objects].sort();
  }

  /** Discards re-applied units' outbound items once the queue has blocked them (stale-epoch). */
  async #discardStale(): Promise<void> {
    const storage = this.storage;
    if (storage === null || this.#outbound === null) return;
    for (const unitHex of [...this.#staleToDiscard]) {
      const item = await storage.outbound.get(hash32(fromHex(unitHex)));
      if (item === undefined) this.#staleToDiscard.delete(unitHex);
      else if (item.blocked !== null) {
        await this.#outbound.discard(item.itemId);
        this.#staleToDiscard.delete(unitHex);
      }
    }
  }

  /** Whether this vault stores the Resource (and can therefore project it). */
  async hasResource(resource: ResourceId): Promise<boolean> {
    const storage = this.storage;
    return storage !== null && (await storage.resources.get(resource)) !== undefined;
  }

  /** The Shared Objects state of a stored Resource, without opening a session. */
  async profileOf(resource: ResourceId): Promise<SharedObjectsDataProfile> {
    return (await this.#local(resource)).profile;
  }

  /**
   * Applies one Shared Objects intent locally and queues it as this
   * Principal's next Data Unit (§59 intent → Automerge change → encrypted,
   * signed unit), committed with its outbound entry and the profile
   * checkpoint in one batch. Writes are serialized. An intent that sets an
   * unchanged value still writes a real op (G-SC4), so callers send only
   * intended changes; null when the profile produced no change. Sent when a
   * session for the Resource is open.
   */
  writeIntent(resource: ResourceId, intent: ReplicaIntent): Promise<DataUnitId | null> {
    const run = this.#writes.then(() => this.#write(resource, intent));
    this.#writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #write(resource: ResourceId, intent: ReplicaIntent): Promise<DataUnitId | null> {
    const { storage, secrets, principal } = this.#ready();
    const local = await this.#local(resource);
    const chain = await loadControlChain(storage, resource);
    if (chain?.kind !== "linear") throw new Error("this Resource's Control Chain is not usable");
    const dek = await dekResolver(storage, secrets, resource)(chain.state.epoch.epoch);
    if (dek === undefined) throw new Error("no key for this Resource's current Data Epoch yet");
    const profile = local.profile;
    const change = profile.replica.apply(intent);
    if (change === null) return null;
    const created = await createQueuedDataUnit(
      storage,
      {
        view: chain,
        controlHead: chain.state.head,
        actor: principal.signer,
        dek,
        profile: profile.codecFor({ resourceId: resource, actor: principal.id }),
        value: checkChange(change.change),
        onCreated: (c, value) => profile.recordLocal(c.unitId, value),
      },
      () => [local.checkpointer.write()],
    );
    if (local.url !== null) this.#pool.get(local.url)?.client.flush();
    await this.#rememberOwnUnit(
      resource,
      created.unitId,
      change.objects.map((o) => o.objectId),
    );
    for (const o of change.objects) this.#emitObject(resource, o);
    return created.unitId;
  }

  /**
   * A new Resource owned by this vault's identity (§15): a fresh Resource ID
   * and epoch-0 DEK (into the secret store first), the Genesis, the Resource
   * row and the profile's initial document as the first Data Unit. Local
   * only: hosting it on a server is a separate step (LFCP-065).
   */
  async createResource(options: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
  }): Promise<ResourceId> {
    const { storage, secrets, principal } = this.#ready();
    const R = generateResourceId();
    const dek = generateResourceDEK();
    const epoch0 = dataEpoch(0n);
    const genesis = signControlRecord(
      { resourceId: R, controlSeq: 0n, prevControlId: null },
      {
        type: "GENESIS",
        dataProfile: PROFILE_ID,
        owner: principal.signer.descriptor,
        dekCommitment: dekCommitment(R, epoch0, dek),
        endpoints: options.endpoints.map((url, n) => ({ url, priority: BigInt(n) })),
        coordinatorUrl: options.coordinatorUrl,
      },
      principal.signer,
    );
    const chain = validateControlChain([genesis.bytes]);
    if (chain.kind !== "linear") throw new Error("the Genesis does not validate");
    const ref = dekSecretRef(R, epoch0);
    await secrets.put(ref, exportSecretKeyBytes(dek));
    const saved = await saveControlChain(storage, chain, null);
    if (!saved.ok) throw new Error("the Resource was not stored");
    const epochs = await storage.control.epochs(R);
    const r = await storage.commit([
      ...epochs.map((e) => ({
        op: "put-epoch" as const,
        resourceId: R,
        epoch: { ...e, dekRef: ref },
      })),
      {
        op: "put-resource",
        row: {
          resourceId: R,
          dataProfile: PROFILE_ID,
          localPrincipal: {
            principalId: principal.id,
            signingKeyRef: principalKeySecretRef(principal.id, "signing"),
            agreementKeyRef: principalKeySecretRef(principal.id, "agreement"),
          },
          labels: { name: options.name },
        },
      },
    ]);
    if (!r.ok) throw new Error("the Resource was not stored");
    const { replica, change } = SharedObjectsReplica.create({
      resource: R,
      principal: principal.id,
    });
    const profile = new SharedObjectsDataProfile(replica);
    const opened: Opened = {
      resourceId: R,
      profile,
      url: null,
      checkpointer: new ProfileCheckpointer(storage, profile, { minIntervalMs: 2000 }),
      applier: null,
    };
    this.#opened.set(toHex(R), opened);
    this.#watch(R, profile);
    await createQueuedDataUnit(
      storage,
      {
        view: chain,
        controlHead: chain.state.head,
        actor: principal.signer,
        dek,
        profile: profile.codecFor({ resourceId: R, actor: principal.id }),
        value: checkChange(change.change),
        onCreated: (c, value) => profile.recordLocal(c.unitId, value),
      },
      () => [opened.checkpointer.write()],
    );
    return R;
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
    } else if (e.type === "epoch-reconciled" && e.outbound.length > 0) {
      void this.#discardStale().catch(() => undefined);
    } else if (e.type === "error" && e.resourceId !== undefined) {
      this.#errors.set(toHex(e.resourceId), e.code);
    }
    for (const l of this.#listeners) l(e);
  }

  /** The SDK inputs of the collaboration flows (LFCP-065), or null unless ready. */
  collaborationContext(): CollaborationContext | null {
    const i = this.#install;
    if (this.#stopped || i.kind !== "ready") return null;
    return {
      storage: i.storage,
      secrets: i.secrets,
      principal: i.principal,
      now: () => this.#env.timers.now(),
      ...(this.#env.webSocket === undefined ? {} : { webSocket: this.#env.webSocket }),
      session: (url) => this.#session(url).client,
    };
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
    this.#objectListeners.clear();
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
