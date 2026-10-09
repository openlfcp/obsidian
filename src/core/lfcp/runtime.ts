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
  type AccessState,
  type CommitBinding,
  createQueuedDataUnit,
  DataUnitApplier,
  dekResolver,
  isEngineTrap,
  loadControlChain,
  OutboundQueue,
  ProfileCheckpointer,
  type ResourcePhase,
  type ResourceRefusal,
  type RevokeAccessResult,
  type Receipt as SectionReceipt,
  type SnapshotBinding,
  type StatusSnapshot,
  SyncClient,
  type SyncEvent,
  saveControlChain,
  startSyncDriver,
  type WebSocketFactory,
  type WriteAccess,
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
import {
  dekCommitment,
  exportSecretKeyBytes,
  generateResourceDEK,
  localStateCipher,
} from "@openlfcp/crypto";
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
  SECTIONS_PROFILE_ID,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import {
  dekSecretRef,
  type LfcpStorage,
  type LocalStateDiagnostics,
  principalKeySecretRef,
  type SecretStore,
} from "@openlfcp/storage";
import { signControlRecord, validateControlChain } from "@openlfcp/wire";
import {
  createInstall,
  databaseName,
  INSTALL_KEY,
  type Install,
  type InstallEnv,
  LOCK_MESSAGES,
  type LocalPrincipal,
  type LockReason,
  openInstall,
} from "./install";
import { idbBeforeSealing, idbMetaKeys, PLUGIN_PREFIX, SealedLocalState } from "./local-seal";
import { isInstallId, SlotSecretStore } from "./secrets";

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
  /**
   * POST-007 (LFCP-02-097): a LIVE Resource gets a new Snapshot after this
   * many merged units since the last one, published by a member holding
   * `snapshot/publish` (default 200).
   */
  readonly snapshotEvery?: number;
}

/** The local encryption status (LFCP-02-098 §8). */
export interface LocalStateReport {
  /** The profile checkpoints (the storage adapter's); null when it was opened without sealing. */
  readonly checkpoints: LocalStateDiagnostics | null;
  /** The plugin's own rows. */
  readonly plugin: LocalStateDiagnostics;
}

/** "Local encryption: lse-v1, generation N, key present|missing. …" */
export function localStateLine(report: LocalStateReport | null): string {
  if (report === null) return "Local encryption: not started.";
  const rows = (d: LocalStateDiagnostics) =>
    `${d.rows.sealed} sealed, ${d.rows.plaintext} plaintext, ${d.rows.unreadable} unreadable`;
  const p = report.plugin;
  const c = report.checkpoints;
  const present = p.keyPresent && (c === null || c.keyPresent);
  const events = [p.lastEvent, c?.lastEvent].filter((e) => e !== null && e !== undefined);
  const last = events.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return [
    `Local encryption: ${p.scheme}, generation ${p.generation}, key ${present ? "present" : "missing"}.`,
    c === null ? "Checkpoints: not sealed." : `Checkpoints: ${rows(c)}.`,
    `Plugin data: ${rows(p)}.`,
    last === undefined ? "" : `Last event: ${last.kind} at ${last.at}.`,
  ]
    .filter((x) => x !== "")
    .join(" ");
}

/**
 * Why the runtime could not start, in the user's words (LFCP-02-055). Local
 * sync data written by a newer plugin (IndexedDB version 2 and later,
 * MVP-0.2-COMPATIBILITY-AND-MIGRATION §11–§12) is left untouched: the notes
 * stay readable and editable, sync waits for an update.
 */
export function startFailure(e: unknown): {
  readonly newerData: boolean;
  readonly message: string;
} {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/written by a newer client|VersionError|newer than this code/i.test(raw))
    return {
      newerData: true,
      message:
        "This vault's sync data on this device was written by a newer version of Shared Tasks. Update the plugin to sync again. Your notes are not changed, and the sync data is left as it is.",
    };
  return { newerData: false, message: e instanceof Error ? e.message : String(e) };
}

/** What every refused call says once the profile engine trapped (needs-restart). */
export const NEEDS_RESTART =
  "Shared Tasks needs an Obsidian restart: its sync engine stopped working";

/** What a collaboration of another Data Profile (e.g. a shared section) says. */
export const NEEDS_NEWER_VERSION =
  "This collaboration needs a newer version of Shared Tasks. Update the plugin in Settings → Community plugins";

/**
 * A stored Resource whose Data Profile this version cannot read (a newer
 * plugin's shared sections, say): it is never opened, merged or written.
 */
export class UnsupportedProfileError extends Error {
  /** Not the §62 PROFILE_UNSUPPORTED, which is a server's refusal: the server is not involved here. */
  readonly code = "NEWER_VERSION_NEEDED";
  constructor(readonly dataProfile: string) {
    super(NEEDS_NEWER_VERSION);
    this.name = "UnsupportedProfileError";
  }
}

/** How long a held unit waits before its author counts as blocked (§26.2 links usually arrive at once). */
export const HELD_BLOCKED_MS = 10 * 60_000;

/**
 * A collaborator whose units this device cannot apply: refused by the
 * profile, quarantined (a Key Epoch cutoff, the engine crash breaker,
 * no key), equivocating, or held unlinked for HELD_BLOCKED_MS. Codes and
 * counts only, never content.
 */
export interface BlockedCollaborator {
  /** The author's public Principal ID (hex). */
  readonly principal: string;
  /** How many of their units cannot be applied here. */
  readonly units: number;
  /** The reason codes (ACTOR_EQUIVOCATION, INVALID_AUTOMERGE_BYTES, PREV_MISMATCH, …), sorted. */
  readonly reasons: readonly string[];
}

const BLOCKING_STATUSES = [
  "profile-rejected",
  "quarantined",
  "equivocation",
  "local-failure",
  "held",
  // POST-001 (sdk-ts 0.1.3): another change took this (actor, seq); it waits for a rebuild.
  "profile-held",
] as const;

/** The reason code of a stored unit that cannot be applied. */
function blockReason(status: (typeof BLOCKING_STATUSES)[number], detail: string | null): string {
  const code = /^[A-Z][A-Z0-9_]+/.exec(detail ?? "")?.[0];
  switch (status) {
    case "profile-rejected":
      return "PROFILE_REJECTED";
    case "equivocation":
      return "ACTOR_EQUIVOCATION";
    case "quarantined":
      return code ?? "STALE_DATA_EPOCH";
    case "local-failure":
      return code ?? "LOCAL_FAILURE";
    case "held":
      return code ?? "HELD";
    case "profile-held":
      return code ?? "PROFILE_HELD";
  }
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
  | {
      /**
       * The profile engine trapped (Automerge's wasm module is terminated
       * for this process): every session is stopped and nothing more is
       * processed until Obsidian restarts. At the next start the SDK's
       * crash-loop breaker isolates the content that caused it.
       */
      readonly kind: "needs-restart";
      readonly message: string;
    }
  | { readonly kind: "stopped" };

/** The registry's view of a Resource (OBSIDIAN-ARCHITECTURE-01 §27). */
export type RegistryState =
  | "available"
  | "offline"
  | "locked"
  | "error"
  /** The server refused the Resource for good (POST-017): see RegistryEntry.refusal. */
  | "refused"
  /**
   * LFCP-02-106: the server refused access, and this device re-supplies the
   * Control Records that grant it (a restored server may have lost them).
   */
  | "recovering"
  | "control_conflict"
  /** Another Data Profile than Shared Objects: never opened here (needs a newer plugin). */
  | "unsupported";

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
  /**
   * Why the server refused this Resource for good in this session (e.g.
   * RESOURCE_NOT_HOSTED after a purge, AUTHORIZATION_FAILED after a
   * revocation), or null. It is not asked again until Obsidian restarts.
   */
  readonly refusal: ResourceRefusal | null;
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
  /** What the session was given, to open it again after a refusal. */
  binding?: Parameters<SyncClient["open"]>[0];
}

/** An opened shared-sections Resource. */
interface OpenedSection {
  readonly resourceId: ResourceId;
  readonly profile: SharedSectionsDataProfile;
  readonly url: string;
  readonly checkpointer: ProfileCheckpointer;
}

export class LfcpRuntime {
  readonly #env: RuntimeEnv;
  #install: Install;
  /** Resources (hex) this vault may publish Snapshots of (POST-007). */
  readonly #publishers = new Set<string>();
  /** This vault's 0.1 units (writeIntent) per Resource (hex) since its last Snapshot (POST-007). */
  readonly #ownUnits = new Map<string, number>();

  #countOwn(resource: ResourceId, units: number): void {
    const key = toHex(resource);
    this.#ownUnits.set(key, (this.#ownUnits.get(key) ?? 0) + units);
  }
  #lock: HeldLock | null;
  #outbound: OutboundQueue | null = null;
  readonly #pool = new Map<string, Pooled>();
  readonly #opened = new Map<string, Opened>();
  readonly #sections = new Map<string, OpenedSection>();
  readonly #phases = new Map<string, ResourcePhase>();
  readonly #errors = new Map<string, string>();
  /** Terminal refusals by the server (POST-017), per Resource. */
  readonly #refusals = new Map<string, ResourceRefusal>();
  /** Resources whose access the client is recovering (LFCP-02-106). */
  readonly #recovering = new Set<string>();
  readonly #listeners = new Set<(e: SyncEvent) => void>();
  #stopped = false;
  #writes: Promise<void> = Promise.resolve();
  readonly #staleToDiscard = new Set<string>();
  readonly #objectListeners = new Set<(resource: ResourceId, change: ObjectChange) => void>();

  #sealed: SealedLocalState | null;

  private constructor(
    env: RuntimeEnv,
    install: Install,
    lock: HeldLock | null,
    sealed: SealedLocalState | null,
  ) {
    this.#env = env;
    this.#install = install;
    this.#lock = lock;
    this.#sealed = sealed;
  }

  /**
   * The plugin's own rows, sealed with its local state key (LFCP-02-098);
   * opening it seals an older plugin's plaintext rows. Null without storage.
   */
  static async #seal(env: RuntimeEnv, install: Install): Promise<SealedLocalState | null> {
    const storage = install.storage;
    if (storage === null) return null;
    return SealedLocalState.open({
      meta: storage.meta,
      secrets:
        install.kind === "ready"
          ? install.secrets
          : new SlotSecretStore(env.slots, install.installId),
      cipher: localStateCipher,
      keys: () => idbMetaKeys(databaseName(install.installId), PLUGIN_PREFIX),
    });
  }

  /** Local startup only: Automerge, the install, the writer lock. Never waits for the network. */
  static async start(env: RuntimeEnv): Promise<LfcpRuntime> {
    // Before any replica exists (the slim Automerge build needs it; a no-op otherwise).
    await (env.initializeAutomerge ?? initializeAutomerge)();
    // The sync data of a plugin before 0.4, about to be upgraded (said once, LFCP-02-055).
    const id = env.local.load(INSTALL_KEY);
    const before =
      isInstallId(id) && typeof indexedDB !== "undefined"
        ? await idbBeforeSealing(databaseName(id)).catch(() => null)
        : null;
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
        null,
      );
    }
    const sealed = await LfcpRuntime.#seal(env, install);
    const runtime = new LfcpRuntime(env, install, lock, sealed);
    runtime.upgradedLocalData = before === true && install.storage !== null;
    return runtime;
  }

  /**
   * This start upgraded local data written by a plugin before 0.4 (LFCP-02-055):
   * the plugin says so once, since that plugin can no longer open it.
   */
  upgradedLocalData = false;

  /** The lock, null when the runtime has no lock support, undefined when another instance holds it. */
  static async #takeLock(env: RuntimeEnv, installId: string): Promise<HeldLock | null | undefined> {
    if (env.acquireLock === undefined) return null;
    return (await env.acquireLock(`openlfcp-${installId}`)) ?? undefined;
  }

  get status(): RuntimeStatus {
    if (this.#stopped) return { kind: "stopped" };
    if (this.#trapped !== null) return { kind: "needs-restart", message: this.#trapped };
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

  /** Called once per run when a sealed row could not be read (a lost key, LFCP-02-098 §7). */
  onLocalStateUnreadable(listener: () => void): () => void {
    return this.#sealed?.onUnreadable(listener) ?? (() => undefined);
  }

  /**
   * Rotates the local state keys (LFCP-02-098 §8): the checkpoints' and the
   * plugin's, each to its next generation, every row sealed again.
   */
  async rotateLocalStateKey(): Promise<void> {
    const storage = this.#install.storage;
    if (storage === null || this.#sealed === null)
      throw new Error("Shared Tasks has no local state on this device yet");
    await storage.rotateLocalStateKey?.();
    await this.#sealed.rotate();
  }

  /** The local encryption status of the checkpoints and of the plugin's rows (§8). */
  async localStateDiagnostics(): Promise<LocalStateReport | null> {
    if (this.#sealed === null) return null;
    return {
      checkpoints: (await this.#install.storage?.localStateDiagnostics?.()) ?? null,
      plugin: await this.#sealed.diagnostics(),
    };
  }

  /** The diagnostics line of §8: never key bytes, envelopes or plaintext. */
  localStateSummary(report: LocalStateReport | null): string {
    return localStateLine(report);
  }

  /**
   * Small local, device-only state of the plugin (e.g. projection bases),
   * kept in this install's database next to the LFCP state. Never secrets.
   */
  readonly localState = {
    get: async (key: string): Promise<unknown> =>
      this.#stopped ? undefined : this.#sealed?.get(key),
    put: async (key: string, value: unknown): Promise<void> => {
      if (this.#stopped) return;
      await this.#sealed?.put(key, value);
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
      const refusal = this.#refusals.get(key) ?? null;
      const state: RegistryState =
        row.dataProfile !== PROFILE_ID
          ? "unsupported"
          : conflict !== undefined || phase === "CONTROL_CONFLICT"
            ? "control_conflict"
            : this.#install.kind === "locked"
              ? "locked"
              : this.#recovering.has(key)
                ? "recovering"
                : refusal !== null
                  ? "refused"
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
          refusal,
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
  openResource(resource: ResourceId): Promise<OpenResource> {
    return this.#engine(() => this.#openResource(resource));
  }

  async #openResource(resource: ResourceId): Promise<OpenResource> {
    const local = await this.#local(resource);
    if (local.applier !== null) {
      // Refused for good (POST-017): the session does not ask again on its
      // own. Opening it again — e.g. right after hosting it — asks once more.
      const key = toHex(resource);
      if (this.#refusals.has(key) && local.url !== null && local.binding !== undefined) {
        this.#refusals.delete(key);
        this.#session(local.url).client.open(local.binding);
      }
      return local;
    }
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
          // A catch-up (join, reconnect, restart replay) merges in one
          // Automerge call instead of one per unit.
          applyBatch: (units) => profile.applyBatch(units as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    });
    const { client } = this.#session(url);
    const binding = {
      resourceId: resource,
      applier,
      checkpointer: local.checkpointer,
      snapshot: {
        codec: profile.snapshotCodec(),
        load: (s: unknown) => void profile.loadSnapshot(s as Uint8Array),
        current: () => profile.snapshotState(),
      },
    };
    client.open(binding);
    local.binding = binding;
    local.applier = applier;
    local.url = url;
    return local;
  }

  #ready(): Extract<Install, { kind: "ready" }> {
    const i = this.#install;
    if (this.#trapped !== null) throw new Error(NEEDS_RESTART);
    if (this.#stopped || i.kind !== "ready") throw new Error("Shared Tasks is not ready");
    return i;
  }

  /** Why the engine trapped (needs-restart), or null. */
  #trapped: string | null = null;
  readonly #restartListeners = new Set<(message: string) => void>();

  /** Called once if the profile engine traps and Obsidian must restart (status needs-restart). */
  onNeedsRestart(listener: (message: string) => void): () => void {
    this.#restartListeners.add(listener);
    return () => this.#restartListeners.delete(listener);
  }

  /** The engine trapped: stop every session once; later calls refuse with NEEDS_RESTART. */
  #engineTrapped(detail: string): void {
    if (this.#trapped !== null || this.#stopped) return;
    this.#trapped = `${NEEDS_RESTART} (${detail})`;
    for (const p of this.#pool.values()) {
      p.stopDriver();
      p.unsubscribe();
      void p.client.stop().catch(() => undefined);
    }
    this.#pool.clear();
    for (const l of this.#restartListeners) l(this.#trapped);
  }

  /** Runs engine work; a trap switches the runtime to needs-restart. */
  async #engine<T>(work: () => Promise<T>): Promise<T> {
    if (this.#trapped !== null) throw new Error(NEEDS_RESTART);
    try {
      return await work();
    } catch (e) {
      if (!isEngineTrap(e)) throw e;
      this.#engineTrapped(e instanceof Error ? e.message : String(e));
      throw new Error(NEEDS_RESTART);
    }
  }

  /** A stored Resource's Shared Objects state, local only (no session). */
  async #local(resource: ResourceId): Promise<Opened> {
    const key = toHex(resource);
    const existing = this.#opened.get(key);
    if (existing !== undefined) return existing;
    const { storage, principal } = this.#ready();
    const row = await storage.resources.get(resource);
    if (row === undefined) throw new Error("unknown Resource");
    if (row.dataProfile !== PROFILE_ID) throw new UnsupportedProfileError(row.dataProfile);
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
    if (storage === null) return;
    // Discarding touches only storage: any queue instance will do.
    this.#outbound ??= new OutboundQueue({ storage });
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
  /**
   * The collaborators whose units this device cannot apply in `resource`
   * (BlockedCollaborator), by Principal ID; this Principal's own units are
   * left out (own stale work is re-applied, G-EP5). A held unit counts once
   * it has been held for HELD_BLOCKED_MS: the first time a unit is seen
   * held is kept in local state.
   */
  async blockedCollaborators(resource: ResourceId): Promise<BlockedCollaborator[]> {
    const { storage, principal } = this.#ready();
    const me = toHex(principal.id);
    const now = this.#env.timers.now();
    const units: { actor: string; unit: string; held: boolean; reason: string }[] = [];
    for (const status of BLOCKING_STATUSES)
      for (const u of await storage.dataUnits.withStatus(resource, status)) {
        const actor = toHex(u.actor);
        if (actor !== me)
          units.push({
            actor,
            unit: toHex(u.unitId),
            held: status === "held" || status === "profile-held",
            reason: blockReason(status, u.detail),
          });
      }
    // First-seen times of held units: new ones now, those no longer held dropped.
    let since: Record<string, number> = {};
    await this.localState.update(`held-since:${toHex(resource)}`, (value) => {
      const old = (value ?? {}) as Record<string, number>;
      since = Object.fromEntries(
        units.filter((u) => u.held).map((u) => [u.unit, old[u.unit] ?? now]),
      );
      return since;
    });
    const byActor = new Map<string, { units: number; reasons: Set<string> }>();
    for (const u of units) {
      if (u.held && now - (since[u.unit] ?? now) < HELD_BLOCKED_MS) continue;
      const entry = byActor.get(u.actor) ?? { units: 0, reasons: new Set<string>() };
      entry.units++;
      entry.reasons.add(u.reason);
      byActor.set(u.actor, entry);
    }
    return [...byActor]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([principal, e]) =>
        Object.freeze({ principal, units: e.units, reasons: Object.freeze([...e.reasons].sort()) }),
      );
  }

  /**
   * The blocked collaborators of `resource` not reported before, and
   * records them as reported (in local state, so a restart does not report
   * them again): one notice per Resource and collaborator.
   */
  async newlyBlocked(resource: ResourceId): Promise<BlockedCollaborator[]> {
    const blocked = await this.blockedCollaborators(resource);
    if (blocked.length === 0) return [];
    let fresh: BlockedCollaborator[] = [];
    await this.localState.update(`blocked-reported:${toHex(resource)}`, (value) => {
      const reported = new Set((value ?? []) as string[]);
      fresh = blocked.filter((b) => !reported.has(b.principal));
      for (const b of fresh) reported.add(b.principal);
      return [...reported].sort();
    });
    return fresh;
  }

  /**
   * The server's terminal refusal of `resource` if it was not reported
   * before, recording it as reported (in local state, so a restart that is
   * refused the same way does not report it again): one notice per
   * collaboration. Reaching LIVE again clears the record.
   */
  async newlyRefused(resource: ResourceId): Promise<ResourceRefusal | null> {
    const refusal = this.#refusals.get(toHex(resource));
    if (refusal === undefined) return null;
    const mark = `${refusal.code} ${refusal.url}`;
    let fresh = false;
    await this.localState.update(`refused-reported:${toHex(resource)}`, (value) => {
      fresh = value !== mark;
      return mark;
    });
    return fresh ? refusal : null;
  }

  async hasResource(resource: ResourceId): Promise<boolean> {
    const storage = this.storage;
    return storage !== null && (await storage.resources.get(resource)) !== undefined;
  }

  /** Whether a stored Resource has the Data Profile this version reads (Shared Objects). */
  async supportsResource(resource: ResourceId): Promise<boolean> {
    return (await this.storage?.resources.get(resource))?.dataProfile === PROFILE_ID;
  }

  /** The Shared Objects state of a stored Resource, without opening a session. */
  profileOf(resource: ResourceId): Promise<SharedObjectsDataProfile> {
    return this.#engine(async () => (await this.#local(resource)).profile);
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
    const run = this.#writes
      .then(() => this.#engine(() => this.#write(resource, intent)))
      .then((unit) => {
        if (unit !== null) this.#countOwn(resource, 1);
        return unit;
      });
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
  createResource(options: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
  }): Promise<ResourceId> {
    return this.#engine(() => this.#createResource(options));
  }

  async #createResource(options: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
  }): Promise<ResourceId> {
    const { storage, principal } = this.#ready();
    const { R, chain, dek } = await this.#genesis(options, PROFILE_ID);
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

  /**
   * A new shared-sections Resource (MVP 0.2), owned by this vault's identity:
   * its Genesis and row, without a first unit. The section itself
   * (section.create and its import) is one operation committed once the
   * Resource is open (SDK-SECTIONS-INTEGRATION-01 §3.1).
   */
  createSectionResource(options: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
    /**
     * The Resource ID chosen beforehand (the section creation journal,
     * LFCP-02-050): a Resource already stored under it is not created again.
     */
    readonly resourceId?: ResourceId;
  }): Promise<ResourceId> {
    return this.#engine(async () => {
      const wanted = options.resourceId;
      if (wanted !== undefined && (await this.#ready().storage.resources.get(wanted)) !== undefined)
        return wanted;
      return (await this.#genesis(options, SECTIONS_PROFILE_ID, wanted)).R;
    });
  }

  /**
   * Opens a stored shared-sections Resource: its replica restored from its
   * checkpoint, a session on its coordinator, and the commit binding through
   * which local batches are committed with receipts.
   */
  /** An open section Resource: ready (SSP §12.1), and no change held for a missing dependency. */
  sectionLoad(
    resource: ResourceId,
  ): { readonly ready: boolean; readonly loaded: boolean } | undefined {
    const profile = this.sectionProfile(resource);
    if (profile === undefined) return undefined;
    const c = profile.replica.snapshot().classification;
    return {
      ready: c !== "IMPORTING" && c !== "PROFILE_INVALID",
      loaded: profile.heldUnits().length === 0,
    };
  }

  openSection(resource: ResourceId): Promise<SharedSectionsDataProfile> {
    return this.#engine(async () => (await this.#openSection(resource)).profile);
  }

  async #openSection(resource: ResourceId): Promise<OpenedSection> {
    const key = toHex(resource);
    const existing = this.#sections.get(key);
    if (existing !== undefined) return existing;
    const { storage, principal } = this.#ready();
    const row = await storage.resources.get(resource);
    if (row === undefined) throw new Error("unknown Resource");
    if (row.dataProfile !== SECTIONS_PROFILE_ID) throw new UnsupportedProfileError(row.dataProfile);
    const route = await storage.resources.route(resource);
    const url = route?.coordinatorUrl;
    if (url === undefined) throw new Error("no known route for this Resource");
    const options = { resource, principal: principal.id };
    const checkpoint = await storage.profileState.checkpoint(resource);
    const profile =
      checkpoint === undefined
        ? new SharedSectionsDataProfile(SectionReplica.empty(options))
        : SharedSectionsDataProfile.restore(checkpoint, options);
    const checkpointer = new ProfileCheckpointer(
      storage,
      { checkpoint: () => profile.checkpoint() },
      { minIntervalMs: 2000 },
    );
    const applier = new DataUnitApplier({
      storage,
      dek: dekResolver(storage, this.#ready().secrets, resource),
      handlers: [
        {
          dataProfile: profile.dataProfile,
          codecFor: (u) => profile.codecFor(u),
          apply: (u, v) => profile.apply(u, v as never),
          applyBatch: (units) => profile.applyBatch(units as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    });
    const binding = {
      resourceId: resource,
      applier,
      checkpointer,
      commit: profile.commitBinding(principal.id) as CommitBinding<unknown>,
      // LFCP-02-097: a joiner loads the section's Snapshot and fetches only the tail.
      snapshot: profile.snapshotBinding() as SnapshotBinding<unknown>,
    };
    this.#session(url).client.open(binding);
    const opened: OpenedSection = { resourceId: resource, profile, url, checkpointer };
    this.#sections.set(key, opened);
    return opened;
  }

  /** An open shared-sections Resource's profile, synchronously (the section snapshot rule). */
  sectionProfile(resource: ResourceId): SharedSectionsDataProfile | undefined {
    return this.#sections.get(toHex(resource))?.profile;
  }

  /** Commits a batch on a shared-sections Resource through its session (§3.1): a durable receipt. */
  commitSection(
    resource: ResourceId,
    intents: readonly unknown[],
    options: { readonly operationId: string },
  ): Promise<SectionReceipt> {
    return this.#engine(async () => {
      const opened = await this.#openSection(resource);
      return this.#session(opened.url).client.commit(resource, intents, options);
    });
  }

  /**
   * Whether this vault may write to a shared-sections Resource
   * (SDK-SECTIONS-INTEGRATION-01 §6), from the validated Control state only.
   */
  canWriteSection(resource: ResourceId): Promise<WriteAccess> {
    return this.#engine(async () => {
      const opened = await this.#openSection(resource);
      return this.#session(opened.url).client.canWrite(resource);
    });
  }

  /** This vault's access to a Resource with its evidence (027): freshness, abilities, pending Control. */
  sectionAccessState(resource: ResourceId): Promise<AccessState> {
    return this.#engine(async () => {
      const opened = await this.#openSection(resource);
      return this.#session(opened.url).client.accessState(resource);
    });
  }

  /**
   * Removes a member's access to a shared-sections Resource (§17.3): their
   * grants are revoked and, when they keep no read access, the Data Epoch is
   * rotated. Refused, with nothing queued, unless the Resource is live and
   * current here; queued records stay pending until the server commits them.
   */
  revokeSectionAccess(resource: ResourceId, subject: PrincipalId): Promise<RevokeAccessResult> {
    return this.#engine(async () => {
      const opened = await this.#openSection(resource);
      return this.#session(opened.url).client.revokeAccess(resource, subject);
    });
  }

  /** The status of a shared-sections Resource (§5): batches, received units, readiness, access. */
  sectionStatusSnapshot(resource: ResourceId): Promise<StatusSnapshot> {
    return this.#engine(async () => {
      const opened = await this.#openSection(resource);
      return this.#session(opened.url).client.statusSnapshot(resource);
    });
  }

  /** A new Resource's Genesis, epoch-0 DEK and row, owned by this vault's identity (§15). */
  async #genesis(
    options: {
      readonly name: string;
      readonly endpoints: readonly string[];
      readonly coordinatorUrl: string;
    },
    dataProfile: string,
    resourceId?: ResourceId,
  ) {
    const { storage, secrets, principal } = this.#ready();
    const R = resourceId ?? generateResourceId();
    const dek = generateResourceDEK();
    const epoch0 = dataEpoch(0n);
    const genesis = signControlRecord(
      { resourceId: R, controlSeq: 0n, prevControlId: null },
      {
        type: "GENESIS",
        dataProfile,
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
          dataProfile,
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
    return { R, chain, dek };
  }

  #session(url: string): Pooled {
    const pooled = this.#pool.get(url);
    if (pooled !== undefined) return pooled;
    const i = this.#install;
    if (i.kind !== "ready") throw new Error("Shared Tasks is not ready");
    // One outbound queue per session: a queue holds its server's READY
    // limits and the messages in flight on that connection, and a lost
    // connection retries only its own (a shared queue applied one server's
    // limits to another and retried other sessions' items, racing their
    // ACKs). The items themselves are in storage, per Resource.
    const client = new SyncClient({
      url,
      signer: i.principal.signer,
      agreement: i.principal.agreement,
      storage: i.storage,
      secrets: i.secrets,
      outbound: new OutboundQueue({ storage: i.storage }),
      now: () => this.#env.timers.now(),
      ...(this.#env.webSocket === undefined ? {} : { webSocket: this.#env.webSocket }),
      // POST-007: a Snapshot every `snapshotEvery` merged units, by a member who may publish one.
      // The SDK counts merged units and those of sync.commit; the 0.1 writes
      // (writeIntent queues its units directly) are added here.
      snapshotPolicy: (R, units) =>
        units + (this.#ownUnits.get(toHex(R)) ?? 0) >= (this.#env.snapshotEvery ?? 200) &&
        this.#publishers.has(toHex(R)),
    });
    const unsubscribe = client.on((e) => {
      this.#onEvent(e);
      // Whether this vault may publish Snapshots, from the validated Control state.
      if (e.type === "snapshot-published") this.#ownUnits.delete(toHex(e.resourceId));
      if (e.type === "resource-state" && e.state === "LIVE")
        void client
          .accessState(e.resourceId)
          .then((a) => {
            if (a.abilities.includes("snapshot/publish")) this.#publishers.add(toHex(e.resourceId));
            else this.#publishers.delete(toHex(e.resourceId));
          })
          .catch(() => undefined);
    });
    client.start();
    const stopDriver = startSyncDriver(client, this.#env.timers, this.#env.tickMs ?? 250);
    const created: Pooled = { client, stopDriver, unsubscribe };
    this.#pool.set(url, created);
    return created;
  }

  #onEvent(e: SyncEvent): void {
    if (e.type === "resource-state") {
      const key = toHex(e.resourceId);
      this.#phases.set(key, e.state);
      if (e.state === "LIVE") {
        this.#errors.delete(key);
        this.#refusals.delete(key);
        // A later refusal of this collaboration is news again.
        void this.localState
          .update(`refused-reported:${key}`, () => undefined)
          .catch(() => undefined);
      }
    } else if (e.type === "access-recovery") {
      // LFCP-02-106: started → waiting; recovered → opens as usual; ended → the refusal stands.
      const key = toHex(e.resourceId);
      if (e.outcome === "started") this.#recovering.add(key);
      else this.#recovering.delete(key);
      if (e.outcome === "recovered") this.#refusals.delete(key);
    } else if (e.type === "resource-refused") {
      this.#refusals.set(toHex(e.resourceId), e.refusal);
    } else if (e.type === "epoch-reconciled" && e.outbound.length > 0) {
      void this.#discardStale().catch(() => undefined);
    } else if (e.type === "error" && e.code === "ENGINE_TRAP") {
      this.#engineTrapped(e.message);
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
    // After a trap the engine cannot save: the stored units are replayed at the next start.
    if (this.#trapped === null)
      await Promise.allSettled(
        [...this.#opened.values(), ...this.#sections.values()]
          .filter((o) => o.checkpointer.dirty)
          .map((o) => o.checkpointer.flush(now)),
      );
    this.#opened.clear();
    this.#sections.clear();
    this.#install.storage?.close();
    this.#lock?.release();
    this.#lock = null;
    this.#listeners.clear();
    this.#objectListeners.clear();
    this.#restartListeners.clear();
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
    this.#sealed = await LfcpRuntime.#seal(this.#env, install);
  }
}
