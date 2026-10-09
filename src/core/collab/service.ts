// The collaboration flows behind the LFCP-065 commands. Obsidian-free: the
// adapter supplies prompts and note I/O; this module calls the SDK's flows
// and the plugin runtime, and implements no protocol itself.
//
// - Create: runtime.createResource (Resource ID, epoch-0 DEK, Genesis, the
//   Shared Objects root, the registry row), then RESOURCE_HOST on the
//   coordinator through the pooled SyncClient. Offline, the Resource is
//   fully usable locally and hosting stays pending until "host" succeeds.
// - Invite: @openlfcp/client createInvitation (a CAPABILITY_GRANT with an
//   explicit claim_limit and the Invitation Principal's Key Package,
//   queued for the coordinator), then sent on the Resource's session.
// - Join: @openlfcp/client acceptInvitation (§73), then the registry row
//   and the Resource's session.
// - Status: what the stored, signed Control state and the local
//   Shared Objects state say, never key material.
//
// Secrets: an invitation link is a bearer key. It is returned as the SDK's
// InvitationLink (redacted when printed or serialized) and never logged,
// stored, put in a notice or an error.

import {
  type AcceptedInvitation,
  type AcceptInvitationStage,
  abandonInvitationClaim,
  acceptInvitation,
  createInvitation,
  dekResolver,
  type InvitationLink,
  loadControlChain,
  pendingInvitationClaims,
  resumeInvitationClaim,
  type SyncClient,
  type SyncEvent,
} from "@openlfcp/client";
import {
  resourceId as asResourceId,
  type DataUnitId,
  fromHex,
  type ObjectId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import {
  PROFILE_ID,
  type ReplicaIntent,
  resolveFieldConflict,
  SCALAR_FIELDS,
  type ScalarField,
  type SharedObjectsDataProfile,
  type Task,
} from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { principalKeySecretRef } from "@openlfcp/storage";
import { ABILITY_NAMES, abilitiesOf, parseInviteUri } from "@openlfcp/wire";
import {
  type BlockedCollaborator,
  type CollaborationContext,
  NEEDS_NEWER_VERSION,
  type OpenResource,
  type RegistryEntry,
  type RuntimeStatus,
  SECTIONS_READ_ONLY,
} from "../lfcp/runtime";
import type { TaskState } from "../refs/scanner";
import type { InsertCandidate } from "./batch";
import { planShare } from "./markdown";
import { codeOf, plainCode } from "./messages";
import { DEFAULT_CLAIM_LIMIT, INVITE_PRESETS, type InvitePreset } from "./presets";
import { refusalNotice } from "./view";

/** What the flows need from the plugin runtime (LfcpRuntime implements it). */
export interface CollabRuntime {
  readonly status: RuntimeStatus;
  registry(): Promise<RegistryEntry[]>;
  /** A Resource's local display name, kept in the sealed local state. */
  setLocalName(resource: ResourceId, name: string | null): Promise<void>;
  createResource(options: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
  }): Promise<ResourceId>;
  openResource(resource: ResourceId): Promise<OpenResource>;
  /** A shared-sections Resource's session (MVP 0.2). */
  openSection(resource: ResourceId): Promise<unknown>;
  /** An open section Resource: ready (§12.1), and no change held for a missing dependency. */
  sectionLoad?(
    resource: ResourceId,
  ): { readonly ready: boolean; readonly loaded: boolean } | undefined;
  hasResource(resource: ResourceId): Promise<boolean>;
  supportsResource(resource: ResourceId): Promise<boolean>;
  profileOf(resource: ResourceId): Promise<SharedObjectsDataProfile>;
  writeIntent(resource: ResourceId, intent: ReplicaIntent): Promise<DataUnitId | null>;
  on(listener: (e: SyncEvent) => void): () => void;
  /** The session phase of a Resource ("CLOSED" when not open). */
  phase(resource: ResourceId): string;
  collaborationContext(): CollaborationContext | null;
  /** Collaborators whose units this device cannot apply (LfcpRuntime.blockedCollaborators). */
  blockedCollaborators?(resource: ResourceId): Promise<readonly BlockedCollaborator[]>;
  /** The server's terminal refusal not reported before (LfcpRuntime.newlyRefused). */
  newlyRefused?(
    resource: ResourceId,
  ): Promise<{ readonly code: string; readonly url: string } | null>;
  readonly localState: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
}

export interface CollabOptions {
  /** How long to wait for a session to become READY before reporting "offline" (ms). */
  readonly connectTimeoutMs?: number;
  /** How long an invitation waits for the coordinator's ACKs (ms). */
  readonly ackTimeoutMs?: number;
  /** How long a join may take (ms). */
  readonly joinTimeoutMs?: number;
  /** A timer: the host's (the plugin passes window.setTimeout, for popout windows). */
  readonly sleep: (ms: number) => Promise<void>;
  /** The clock for a shared Task's created_at, in ms since the epoch (default Date.now). */
  readonly now?: () => number;
  /** Shared sections (the `sectionsPreview` flag): invite to and join section Resources. */
  readonly sections?: boolean;
  /** LFCP-02-095 (V3): sections are read-only on this device, so nobody is invited from it. */
  readonly sectionsReadOnly?: boolean;
}

/** Why something needs the network and could not get it, or was refused. */
export type HostOutcome =
  | { readonly kind: "hosted"; readonly durability: bigint }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

export interface CreatedCollaboration {
  readonly resourceId: ResourceId;
  readonly hosting: HostOutcome;
}

export interface Invitation {
  /** The bearer link: show it to the user only, never log or store it. */
  readonly link: InvitationLink;
  readonly preset: InvitePreset;
  readonly claimLimit: bigint;
  /** Whether the coordinator acknowledged the grant and its Key Package: the link works now. */
  readonly confirmed: boolean;
}

/**
 * Join stages in §73's order (LFCP-065): the first four as the SDK's
 * acceptInvitation reports them (the key is retrieved before the claim; a
 * claim refreshed after CONTROL_HEAD_MISMATCH is reported again), then
 * synchronizing while the Resource's session comes up. None carries a
 * secret.
 */
export type JoinStage =
  | "connecting"
  | "validating invitation"
  | "retrieving key"
  | "claiming capability"
  | "synchronizing"
  /** A shared section: until it is ready and every change known so far is here. */
  | "loading section";

const SDK_STAGE: Readonly<Record<AcceptInvitationStage, JoinStage>> = {
  connecting: "connecting",
  "validating-invitation": "validating invitation",
  "retrieving-key": "retrieving key",
  "claiming-capability": "claiming capability",
};

export type JoinOutcome =
  | {
      readonly kind: "joined";
      readonly resourceId: ResourceId;
      /** Ability names the claim granted. */
      readonly abilities: readonly string[];
      /** A shared section (MVP 0.2): whether it was ready and fully loaded when the join returned. */
      readonly section?: { readonly loaded: boolean };
    }
  | { readonly kind: "already-member"; readonly resourceId: ResourceId }
  /**
   * The collaboration has another Data Profile (a newer plugin's shared
   * sections, say). Checked before the claim: the invitation is not used
   * and nothing is stored, so it works once the plugin is updated.
   */
  | { readonly kind: "needs-newer-version"; readonly resourceId: ResourceId }
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface Participant {
  /** Public Principal ID, shortened for display. */
  readonly id: string;
  /** The full Principal ID (hex), to act on this identity (060). */
  readonly principal: string;
  readonly you: boolean;
  readonly owner: boolean;
  readonly abilities: readonly string[];
  /** For an Invitation Principal: claims used of the limit. */
  readonly invitation?: { readonly used: string; readonly limit: string };
}

export interface ConflictSummary {
  readonly objectId: string;
  readonly title: string;
  readonly fields: readonly ScalarField[];
}

/** The Resource status view (LFCP-065): non-secret fields only. */
export interface ResourceStatus {
  readonly localName: string | null;
  readonly resourceId: string;
  readonly profile: string;
  readonly state: RegistryEntry["state"];
  /** The server's terminal refusal (POST-017): its §62 code and the server, or null. */
  readonly refusal: { readonly code: string; readonly url: string } | null;
  /** True when the Control Chain has forked: everything security-sensitive is blocked. */
  readonly blocked: boolean;
  readonly phase: string;
  readonly hosting: "hosted" | "pending" | "unknown";
  readonly controlHead: string | null;
  readonly controlSeq: string | null;
  readonly dataEpoch: string | null;
  readonly coordinator: string | null;
  readonly endpoints: readonly string[];
  readonly participants: readonly Participant[];
  readonly pendingOutbound: number;
  readonly conflicts: readonly ConflictSummary[];
  /**
   * Collaborators whose edits this device cannot apply (rejected,
   * quarantined, equivocating, or held too long): short Principal ID, unit
   * count and reason codes. Never content.
   */
  readonly blockedCollaborators?: readonly {
    readonly id: string;
    readonly units: number;
    readonly reasons: readonly string[];
  }[];
}

export interface TaskChoice {
  readonly objectId: ObjectId;
  readonly title: string;
  readonly status: string;
}

export interface ConflictView {
  readonly field: ScalarField;
  /** Every concurrent value, sorted; the user picks one (or clears a date). */
  readonly values: readonly (string | null)[];
}

/** An LFCP refusal or local precondition, with its §62 or SDK code. */
export class CollabError extends Error {
  constructor(
    readonly code: string,
    message: string = plainCode(code),
  ) {
    super(message);
    this.name = "CollabError";
  }
}

const SHORT = 8;
const short = (hex: string): string => hex.slice(0, SHORT);
const hostingKey = (R: ResourceId): string => `collab-hosting:${toHex(R)}`;
/**
 * A join until it finishes: the local name it was given and the link's
 * endpoint (a claim resumed after a restart has neither dialog nor link).
 */
interface JoinRecord {
  readonly name: string;
  readonly url: string;
}
const joinNameKey = (R: ResourceId): string => `collab-join-name:${toHex(R)}`;
const WS_URL = /^wss?:\/\/[^\s/]+/i;

export class Collaboration {
  readonly #runtime: CollabRuntime;
  readonly #o: Required<CollabOptions>;

  constructor(runtime: CollabRuntime, options: CollabOptions) {
    this.#runtime = runtime;
    this.#o = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 15_000,
      joinTimeoutMs: options.joinTimeoutMs ?? 30_000,
      sleep: options.sleep,
      now: options.now ?? Date.now,
      sections: options.sections ?? false,
      sectionsReadOnly: options.sectionsReadOnly ?? false,
    };
  }

  #context(): CollaborationContext {
    const c = this.#runtime.collaborationContext();
    if (c === null) {
      const s = this.#runtime.status;
      throw new CollabError(
        "NOT_READY",
        s.kind === "locked"
          ? `Shared Tasks cannot write on this device: ${s.message}`
          : "Shared Tasks is not ready yet.",
      );
    }
    return c;
  }

  async #entry(R: ResourceId): Promise<RegistryEntry> {
    const key = toHex(R);
    const e = (await this.list()).find((x) => toHex(x.resourceId) === key);
    if (e === undefined)
      throw new CollabError("UNKNOWN_RESOURCE", "This collaboration is not on this device.");
    return e;
  }

  /**
   * The known collaborations, for pickers and status. The runtime calls a
   * shared section's Resource "unsupported" (a 0.3 plugin cannot read one);
   * with the sections preview on, this version can, so its state is its
   * session's: refused, in sync or offline (LFCP-02-066).
   */
  async list(): Promise<RegistryEntry[]> {
    const entries = await this.#runtime.registry();
    if (!this.#o.sections) return entries;
    return entries.map((e) =>
      e.profile === SECTIONS_PROFILE_ID && e.state === "unsupported"
        ? {
            ...e,
            state:
              e.refusal !== null
                ? "refused"
                : this.#runtime.phase(e.resourceId) === "LIVE"
                  ? "available"
                  : "offline",
          }
        : e,
    );
  }

  /** "Create collaboration": a new Resource owned by this vault's identity, hosted when online. */
  async create(options: {
    readonly name: string;
    readonly server: string;
  }): Promise<CreatedCollaboration> {
    const name = options.name.trim();
    const server = options.server.trim();
    if (name === "") throw new CollabError("UNSUPPORTED_VALUE", "Give the collaboration a name.");
    if (!WS_URL.test(server))
      throw new CollabError(
        "UNSUPPORTED_VALUE",
        "The server must be a WebSocket URL (wss://… or, for local testing, ws://…).",
      );
    this.#context();
    const resourceId = await this.#runtime.createResource({
      name,
      endpoints: [server],
      coordinatorUrl: server,
    });
    await this.#runtime.localState.put(hostingKey(resourceId), "pending");
    return { resourceId, hosting: await this.host(resourceId) };
  }

  /**
   * Waits until `client` is READY: false as soon as a connection attempt
   * fails (offline), or at the timeout. Already disconnected between
   * reconnect attempts counts as offline.
   */
  async #ready(client: SyncClient): Promise<boolean> {
    if (client.connectionState === "READY") return true;
    if (client.connectionState === "DISCONNECTED") return false;
    let done: (ok: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((r) => {
      done = r;
    });
    const off = client.on((e) => {
      if (e.type !== "connection") return;
      if (e.state === "READY") done(true);
      else if (e.state === "DISCONNECTED") done(false);
    });
    void this.#o.sleep(this.#o.connectTimeoutMs).then(() => done(false));
    try {
      return await ready;
    } finally {
      off();
    }
  }

  /**
   * RESOURCE_HOST (§39) of a Resource this vault created, on its
   * coordinator, then its session. Pending while the server is unreachable;
   * the local Resource works meanwhile.
   */
  async host(R: ResourceId): Promise<HostOutcome> {
    const c = this.#context();
    const chain = await loadControlChain(c.storage, R);
    if (chain?.kind !== "linear") throw new CollabError("CONTROL_CONFLICT");
    const genesis = chain.records[0]?.signed.bytes;
    if (genesis === undefined) throw new CollabError("MISSING_DEPENDENCY");
    const url = chain.state.route.coordinatorUrl;
    const client = c.session(url);
    if (!(await this.#ready(client)))
      return {
        kind: "pending",
        reason: `The server ${url} is not reachable now. The collaboration works on this device; host it later from "Resource status".`,
      };
    try {
      const durability = await client.host(genesis);
      await this.#runtime.localState.put(hostingKey(R), "hosted");
      // A shared-sections Resource opens with its own profile (MVP 0.2).
      if ((await c.storage.resources.get(R))?.dataProfile === SECTIONS_PROFILE_ID)
        await this.#runtime.openSection(R);
      else await this.#runtime.openResource(R);
      return { kind: "hosted", durability };
    } catch (e) {
      const code = /NACK (\w+)/.exec(e instanceof Error ? e.message : "")?.[1];
      if (code === undefined)
        return {
          kind: "pending",
          reason: "The server did not answer the hosting request in time.",
        };
      return { kind: "refused", code, message: plainCode(code) };
    }
  }

  /** "Invite collaborator": a one-time invitation with a preset's abilities. */
  async invite(R: ResourceId, preset: InvitePreset): Promise<Invitation> {
    const entry = await this.#entry(R);
    if (entry.state === "control_conflict") throw new CollabError("CONTROL_CONFLICT");
    const section = entry.profile === SECTIONS_PROFILE_ID;
    await this.checkInvitable(R);
    const c = this.#context();
    const chain = await loadControlChain(c.storage, R);
    if (chain?.kind !== "linear") throw new CollabError("CONTROL_CONFLICT");
    const epoch = chain.state.epoch.epoch;
    const dek = await dekResolver(c.storage, c.secrets, R)(epoch);
    if (dek === undefined)
      throw new CollabError(
        "KEY_PACKAGE_UNAVAILABLE",
        "This device does not hold the collaboration's current key yet.",
      );
    const endpoints = [...chain.state.route.endpoints]
      .sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0))
      .map((e) => e.url);
    let created: Awaited<ReturnType<typeof createInvitation>>;
    try {
      created = await createInvitation({
        storage: c.storage,
        resourceId: R,
        inviter: c.principal.signer,
        dek,
        endpoints,
        abilities: INVITE_PRESETS[preset].abilities,
        claimLimit: DEFAULT_CLAIM_LIMIT,
      });
    } catch (e) {
      const code = codeOf(e);
      throw code === "AUTHORIZATION_FAILED"
        ? new CollabError(
            code,
            "You are not allowed to invite collaborators to this collaboration.",
          )
        : e;
    }
    // Send the queued grant and Key Package; the link works once both are ACKed.
    const wanted = new Set([toHex(created.grantId), toHex(created.keyPackageId)]);
    let resolve: () => void = () => undefined;
    const acked = new Promise<boolean>((r) => {
      resolve = () => r(true);
    });
    const off = this.#runtime.on((e) => {
      if (e.type !== "ack") return;
      for (const id of e.outcome.acked) wanted.delete(toHex(id));
      if (wanted.size === 0) resolve();
    });
    try {
      let url: string | null;
      if (section) {
        await this.#runtime.openSection(R);
        url = chain.state.route.coordinatorUrl;
      } else url = (await this.#runtime.openResource(R)).url;
      const client = url === null ? null : c.session(url);
      // Offline: queued, and sent when the session is back; no point waiting for ACKs.
      const online = client !== null && (await this.#ready(client));
      if (online) client.flush();
      const confirmed =
        online &&
        (await Promise.race([acked, this.#o.sleep(this.#o.ackTimeoutMs).then(() => false)]));
      return { link: created.link, preset, claimLimit: DEFAULT_CLAIM_LIMIT, confirmed };
    } finally {
      off();
    }
  }

  /**
   * A section is offered for invitation only once it is hosted and ready
   * (SSP §12.1, LFCP-02-050): never while it imports or before the server
   * holds it.
   */
  async checkInvitable(R: ResourceId): Promise<void> {
    if ((await this.#entry(R)).profile !== SECTIONS_PROFILE_ID) return;
    if (!this.#o.sections) throw new CollabError("NEWER_VERSION_NEEDED", NEEDS_NEWER_VERSION);
    if (this.#o.sectionsReadOnly === true)
      throw new CollabError("SECTIONS_READ_ONLY", `${SECTIONS_READ_ONLY}.`);
    if ((await this.#runtime.localState.get(hostingKey(R))) !== "hosted")
      throw new CollabError(
        "NOT_HOSTED",
        'This section is not on its server yet, so nobody could join it. Host it first from "Resource status".',
      );
    await this.#runtime.openSection(R);
    if (this.#runtime.sectionLoad?.(R)?.ready !== true)
      throw new CollabError(
        "SECTION_IMPORTING",
        "This section is still being created. Invite once it is ready.",
      );
  }

  /** "Join collaboration": claim a bearer invitation (§73) as this vault's identity. */
  async join(
    uri: string,
    options: { readonly name: string; readonly onStage?: (stage: JoinStage) => void },
  ): Promise<JoinOutcome> {
    const reported = options.onStage ?? (() => undefined);
    let last: JoinStage | null = null;
    const stage = (s: JoinStage) => {
      last = s;
      reported(s);
    };
    const c = this.#context();
    const R = parseInviteUri(uri.trim()).resourceId;
    const profiles = this.#o.sections ? [PROFILE_ID, SECTIONS_PROFILE_ID] : [PROFILE_ID];
    if (await this.#runtime.hasResource(R)) {
      const profile = (await c.storage.resources.get(R))?.dataProfile;
      return profile !== undefined && profiles.includes(profile)
        ? { kind: "already-member", resourceId: R }
        : { kind: "needs-newer-version", resourceId: R };
    }
    await this.#runtime.localState.put(joinNameKey(R), {
      name: options.name,
      url: parseInviteUri(uri.trim()).endpoints[0] ?? "",
    } satisfies JoinRecord);
    const accepted: AcceptedInvitation = await acceptInvitation({
      onProgress: (p) => stage(SDK_STAGE[p.stage]),
      link: uri.trim(),
      claimant: { signer: c.principal.signer, agreement: c.principal.agreement },
      storage: c.storage,
      secrets: c.secrets,
      now: c.now,
      ...(c.webSocket === undefined ? {} : { webSocket: c.webSocket }),
      timeout: this.#o.sleep(this.#o.joinTimeoutMs),
      // Another profile is refused before the claim, so the link stays unused.
      dataProfiles: profiles,
    });
    if (accepted.kind === "profile-unsupported")
      return { kind: "needs-newer-version", resourceId: R };
    if (accepted.kind === "refused")
      return { kind: "refused", code: accepted.code, message: plainCode(accepted.code) };
    if (accepted.kind === "unavailable")
      // A claim sent without an answer is journaled by the SDK (LFCP-02-110):
      // the same link, or the next start, settles it without spending it twice.
      return last === "claiming capability"
        ? {
            kind: "unavailable",
            message: `The server did not confirm the claim (${accepted.reason}). It is kept on this device: join again with the same link, or it finishes at the next start.`,
          }
        : {
            kind: "unavailable",
            message: `The collaboration's server could not complete the join (${accepted.reason}). Joining needs a connection; try again when online.`,
          };
    return this.#finishJoin(R, accepted.abilities, options.name, stage);
  }

  /** The claimed Resource stored and opened (a section: until it is loaded). */
  async #finishJoin(
    R: ResourceId,
    granted: readonly bigint[],
    name: string,
    stage: (s: JoinStage) => void,
  ): Promise<JoinOutcome> {
    const c = this.#context();
    const profiles = this.#o.sections ? [PROFILE_ID, SECTIONS_PROFILE_ID] : [PROFILE_ID];
    const chain = await loadControlChain(c.storage, R);
    if (chain?.kind !== "linear") throw new CollabError("INVALID_CONTROL_CHAIN");
    // Unreachable since the SDK checks before the claim (dataProfiles); kept as a guard.
    if (!profiles.includes(chain.state.dataProfile))
      throw new CollabError("NEWER_VERSION_NEEDED", NEEDS_NEWER_VERSION);
    const id = c.principal.id;
    const r = await c.storage.commit([
      {
        op: "put-resource",
        row: {
          resourceId: R,
          dataProfile: chain.state.dataProfile,
          localPrincipal: {
            principalId: id,
            signingKeyRef: principalKeySecretRef(id, "signing"),
            agreementKeyRef: principalKeySecretRef(id, "agreement"),
          },
          // The name is the user's text: sealed local state, not the public labels.
          labels: {},
        },
      },
    ]);
    if (!r.ok) throw new CollabError("UNSUPPORTED_VALUE", "The collaboration could not be stored.");
    await this.#runtime.setLocalName(R, name.trim() === "" ? "Shared collaboration" : name.trim());
    await this.#runtime.localState.put(hostingKey(R), "hosted");
    await this.#runtime.localState.put(joinNameKey(R), null);
    const abilities = granted.map((a) => ABILITY_NAMES.get(a) ?? `ability ${a}`);
    stage("synchronizing");
    const section = chain.state.dataProfile === SECTIONS_PROFILE_ID;
    if (section) await this.#runtime.openSection(R);
    else await this.#runtime.openResource(R);
    // Until the session is live, or the connect timeout: joined either way.
    const until = this.#o.connectTimeoutMs;
    let waited = 0;
    for (; this.#runtime.phase(R) !== "LIVE" && waited < until; waited += 50)
      await this.#o.sleep(50);
    if (!section) return { kind: "joined", resourceId: R, abilities };
    // A section is inserted only once ready and fully loaded (LFCP-02-052).
    stage("loading section");
    const loaded = () => {
      const l = this.#runtime.sectionLoad?.(R);
      return l?.ready === true && l.loaded;
    };
    for (; !loaded() && waited < until; waited += 50) await this.#o.sleep(50);
    return { kind: "joined", resourceId: R, abilities, section: { loaded: loaded() } };
  }

  /** Joins that did not finish: a claim sent and not settled (LFCP-02-110). */
  async pendingJoins(): Promise<{ readonly resourceId: ResourceId; readonly name: string }[]> {
    const c = this.#context();
    const out: { resourceId: ResourceId; name: string }[] = [];
    for (const j of await pendingInvitationClaims(c.storage)) {
      const R = asResourceId(fromHex(j.resourceId));
      const record = (await this.#runtime.localState.get(joinNameKey(R))) as JoinRecord | undefined;
      out.push({ resourceId: R, name: record?.name ?? "Shared collaboration" });
    }
    return out;
  }

  /**
   * Settles a journaled claim without its link (at start, or "Retry"):
   * joined when it had landed; when it had not, the link is still unused.
   */
  async resumeJoin(R: ResourceId): Promise<JoinOutcome | { readonly kind: "not-claimed" }> {
    const c = this.#context();
    const journal = (await pendingInvitationClaims(c.storage)).find(
      (j) => j.resourceId === toHex(R),
    );
    if (journal === undefined) return { kind: "not-claimed" };
    const record = (await this.#runtime.localState.get(joinNameKey(R))) as JoinRecord | undefined;
    if (record === undefined || record.url === "")
      return {
        kind: "unavailable",
        message:
          "This device does not know the collaboration's server: join again with the same link.",
      };
    const settled = await resumeInvitationClaim({
      resourceId: R,
      claimant: { signer: c.principal.signer },
      storage: c.storage,
      secrets: c.secrets,
      url: record.url,
      now: c.now,
      ...(c.webSocket === undefined ? {} : { webSocket: c.webSocket }),
      timeout: this.#o.sleep(this.#o.joinTimeoutMs),
    });
    const name = record.name;
    switch (settled.kind) {
      case "claimed":
        return this.#finishJoin(R, settled.abilities, name, () => undefined);
      case "not-claimed":
      case "none":
        await this.#runtime.localState.put(joinNameKey(R), null);
        return { kind: "not-claimed" };
      case "refused":
        await this.#runtime.localState.put(joinNameKey(R), null);
        return { kind: "refused", code: settled.code, message: plainCode(settled.code) };
      case "unavailable":
        return {
          kind: "unavailable",
          message: `The collaboration's server could not be reached (${settled.reason}). Joining finishes when it can.`,
        };
      default:
        return { kind: "needs-newer-version", resourceId: R };
    }
  }

  /** "Give up": the journaled claim is dropped; nothing joined is kept. */
  async abandonJoin(R: ResourceId): Promise<void> {
    await abandonInvitationClaim(this.#context().storage, R);
    await this.#runtime.localState.put(joinNameKey(R), null);
  }

  /**
   * The notice for a collaboration its server refused for good (POST-017),
   * once per collaboration (LfcpRuntime.newlyRefused), or null. A
   * collaboration created while its server was unreachable and never hosted
   * gets none: the server refusing it is expected, the user was told to host
   * it later, and "Resource status" says it is not hosted yet.
   */
  async refusalNotice(R: ResourceId): Promise<string | null> {
    const hosting = await this.#runtime.localState.get(hostingKey(R));
    const refusal = (await this.#runtime.newlyRefused?.(R)) ?? null;
    if (refusal === null) return null;
    if (hosting === "pending" && refusal.code === "RESOURCE_NOT_HOSTED") return null;
    const name =
      (await this.#runtime.registry()).find((e) => toHex(e.resourceId) === toHex(R))?.localName ??
      "a collaboration";
    return refusalNotice(name, refusal);
  }

  /** "Resource status": the non-secret state of a collaboration. */
  async status(R: ResourceId): Promise<ResourceStatus> {
    const entry = await this.#entry(R);
    const c = this.#context();
    const chain = await loadControlChain(c.storage, R);
    const state = chain?.kind === "linear" ? chain.state : null;
    const me = toHex(c.principal.id);
    const participants: Participant[] = [];
    if (state !== null) {
      const subjects = new Map<string, Participant>();
      const ownerId = toHex(state.owner.principalId);
      const add = (hex: string, extra: Partial<Participant> = {}) => {
        const abilities = abilitiesOf(
          state,
          state.principals.get(hex)?.principalId ?? state.owner.principalId,
        );
        subjects.set(hex, {
          id: short(hex),
          principal: hex,
          you: hex === me,
          owner: hex === ownerId,
          abilities:
            hex === ownerId ? ["owner"] : abilities.map((a) => ABILITY_NAMES.get(a) ?? String(a)),
          ...extra,
        });
      };
      add(ownerId);
      for (const g of state.grants.values()) {
        if (g.revokedBy !== null) continue;
        const hex = toHex(g.subject);
        if (subjects.has(hex)) continue;
        const holds = abilitiesOf(state, g.subject).map((a) => ABILITY_NAMES.get(a) ?? String(a));
        subjects.set(hex, {
          id: short(hex),
          principal: hex,
          you: hex === me,
          owner: false,
          abilities: holds,
          ...(g.claimLimit === null
            ? {}
            : { invitation: { used: String(g.claimsUsed), limit: String(g.claimLimit) } }),
        });
      }
      participants.push(...subjects.values());
    }
    let conflicts: ConflictSummary[] = [];
    try {
      const replica = (await this.#runtime.profileOf(R)).replica;
      conflicts = Object.entries(replica.conflicts()).map(([objectId, fields]) => ({
        objectId,
        title:
          replica
            .task(objectId)
            ?.fields.title.values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
            .join(" / ") ?? objectId,
        fields: Object.keys(fields).filter((f): f is ScalarField =>
          (SCALAR_FIELDS as readonly string[]).includes(f),
        ),
      }));
    } catch {
      conflicts = [];
    }
    const hosting = await this.#runtime.localState.get(hostingKey(R));
    const notApplied = await this.#runtime.blockedCollaborators?.(R).catch(() => []);
    return {
      localName: entry.localName,
      resourceId: toBase64url(R),
      profile: entry.profile,
      state: entry.state,
      refusal: entry.refusal === null ? null : { code: entry.refusal.code, url: entry.refusal.url },
      blocked: entry.state === "control_conflict",
      phase: this.#runtime.phase(R),
      hosting: hosting === "hosted" || hosting === "pending" ? hosting : "unknown",
      controlHead: entry.lastKnownControlHead,
      controlSeq: state === null ? null : String(state.seq),
      dataEpoch: state === null ? null : String(state.epoch.epoch),
      coordinator: state?.route.coordinatorUrl ?? null,
      endpoints: entry.routes,
      participants,
      pendingOutbound: (await c.storage.outbound.list(R)).length,
      conflicts,
      ...(notApplied === undefined
        ? {}
        : {
            blockedCollaborators: notApplied.map((b) => ({
              id: short(b.principal),
              units: b.units,
              reasons: b.reasons,
            })),
          }),
    };
  }

  /** "Share task under cursor": task.create (and a completion date) for a local Task. */
  async share(
    R: ResourceId,
    task: TaskState,
  ): Promise<{ readonly objectId: ObjectId; readonly warnings: readonly string[] }> {
    const [first] = (await this.shareAll(R, [task])).shared;
    if (first === undefined) throw new Error("not shared");
    return first;
  }

  /**
   * Share local Tasks one by one (POST-018), each its own task.create and
   * change, stamped created_at now + its index in ms, so their order is the
   * note's. Stops at the first failure: `shared` holds those done before it,
   * `error` the failure.
   */
  async shareAll(
    R: ResourceId,
    tasks: readonly TaskState[],
  ): Promise<{
    readonly shared: readonly {
      readonly objectId: ObjectId;
      readonly warnings: readonly string[];
    }[];
    readonly error?: unknown;
  }> {
    const entry = await this.#entry(R);
    if (entry.state === "control_conflict") throw new CollabError("CONTROL_CONFLICT");
    const c = this.#context();
    const base = this.#o.now();
    const shared: { objectId: ObjectId; warnings: readonly string[] }[] = [];
    for (const [i, task] of tasks.entries()) {
      try {
        const at = new Date(base + i).toISOString();
        const plan = planShare(task, c.principal.id, undefined, at);
        for (const intent of plan.intents) await this.#runtime.writeIntent(R, intent);
        shared.push({ objectId: plan.objectId, warnings: plan.warnings });
      } catch (error) {
        if (shared.length === 0 && tasks.length === 1) throw error;
        return { shared, error };
      }
    }
    return { shared };
  }

  /** The live, valid Tasks of a collaboration, for "Insert shared object". */
  async tasks(R: ResourceId): Promise<TaskChoice[]> {
    const replica = (await this.#runtime.profileOf(R)).replica;
    const out: TaskChoice[] = [];
    for (const id of replica.objectIds()) {
      const view = replica.task(id);
      const task = view?.task;
      if (view?.status !== "ready" || task === undefined || task.lifecycle === "deleted") continue;
      out.push({ objectId: id as ObjectId, title: task.title, status: task.status });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Every live, valid Task with its created_at, for "Insert all tasks from collaboration". */
  async insertCandidates(R: ResourceId): Promise<InsertCandidate[]> {
    const replica = (await this.#runtime.profileOf(R)).replica;
    const out: InsertCandidate[] = [];
    for (const id of replica.objectIds()) {
      const view = replica.task(id);
      const task = view?.task;
      if (view?.status !== "ready" || task === undefined || task.lifecycle === "deleted") continue;
      out.push({
        objectId: id,
        ...(task.created_at === undefined ? {} : { createdAt: task.created_at }),
      });
    }
    return out;
  }

  /** A shared Task's current state (its visible values), if it is a valid Task. */
  async profileTask(R: ResourceId, objectId: string): Promise<Task | undefined> {
    return (await this.#runtime.profileOf(R)).replica.task(objectId)?.task;
  }

  /** The conflicted fields of a shared Task and their competing values (conflict UI hook). */
  async conflicts(R: ResourceId, objectId: string): Promise<ConflictView[]> {
    const view = (await this.#runtime.profileOf(R)).replica.task(objectId);
    if (view === undefined) return [];
    return SCALAR_FIELDS.filter((f) => view.fields[f].conflicted).map((field) => ({
      field,
      values: view.fields[field].values.map((v) => (typeof v === "string" ? v : null)),
    }));
  }

  /** Resolves a conflicted field with the chosen value: task.resolve_field_conflict (§69). */
  async resolve(
    R: ResourceId,
    objectId: string,
    field: ScalarField,
    value: string | null,
  ): Promise<DataUnitId | null> {
    return this.#runtime.writeIntent(R, resolveFieldConflict(objectId as ObjectId, field, value));
  }
}
