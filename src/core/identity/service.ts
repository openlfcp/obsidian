// The device flows of the plugin (LFCP-04-413, draft §9 O2 + O3;
// IDENTITY-PROFILE-01 §§5–8, decisions I2–I6). Obsidian-free: the adapter
// supplies dialogs; this module calls the SDK's identity flows with the
// installation's keys and storage, and says what each result means
// (pairing-view.ts). It implements no protocol.
//
// - Managing side: "Add my other device…" creates the person's device list
//   (the Identity Resource, §5.1) on the first use, after the warning of
//   compat.ts; a pairing session with its link; its requests, approved with
//   a preset (and, for a service, a narrowed scope) or rejected; the link
//   cancelled. The device list; "Remove device…" with its preview (§8.1);
//   re-certifying devices a removal would suspend.
// - New device's side: "Pair this device with a link…" writes the request,
//   shows the fingerprint, learns the result from the chain (§5.3 step 8),
//   and opens every section of the roster it was added to (§5.3 step 11).
//
// Secrets: a pairing link is a bearer secret. It stays a PairingLinkText
// (redacted when printed or serialized) until a dialog reveals it, and is
// never logged, stored or put in a notice. Journals hold none (§9.8).

import {
  checkIssuance,
  exposingRevocationsSince,
  type FlowOptions,
  heldDeks,
  type IdentityChannel,
  IdentityConflict,
  type IdentityFlowOptions,
  IdentityRefused,
  IdentityUnavailable,
  type LinearChain,
  leafPayload,
  loadControlChain,
  localIdentityResource,
  type MaskPreset,
  mayManageDevices,
  OperationJournal,
  PackageLedger,
  PairingLinkText as PairingLink,
  type PairingLinkText,
  type PairingReview,
  planReconciliation,
  principalOfRef,
  type RegistrationResult,
  type RosterEntryValue,
  type RotationOutcome,
  readersAt,
  rotatorTest,
  signChain,
} from "@openlfcp/client";
import {
  bytesEqual,
  dataEpoch,
  fromBase64url,
  fromHex,
  type PrincipalId,
  type ResourceId,
  secureRandom,
  toHex,
} from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { actsFor, DEVICE_KIND } from "@openlfcp/wire";
import {
  CollabError,
  type Collaboration,
  type DeviceCreate,
  type DeviceJoin,
  type DeviceOrigin,
} from "../collab/service";
import type { CollaborationContext, RegistryEntry } from "../lfcp/runtime";
import { firstPairingWarning, type PairingWarning, pairingSections } from "./compat";
import { type DeviceRow, deviceRows } from "./device-list";
import { identityDocument } from "./document";
import { type IdentityFlows, SDK_IDENTITY_FLOWS } from "./flows";
import {
  type ApprovalView,
  approvalView,
  type CancelView,
  cancelView,
  createView,
  type Names,
  OFFLINE,
  type OpenFailure,
  type ProgressView,
  progressView,
  type RemovalView,
  type RequestView,
  type RevokeView,
  removalView,
  requestView,
  revokeView,
  type SessionView,
  type Stop,
  sessionView,
  type UpkeepIssue,
  upkeepIssues,
  upkeepText,
} from "./pairing-view";
import { DEVICE_LABELS_KEY, deviceLabelsOf, fingerprintOf, shortId } from "./people";
import type { RosterAdd, RosterWriter } from "./roster";

/** The pairing request of this device until every section it brought is opened here (P2-5). */
const PAIRING_KEY = "identity-pairing-request";

/** What the device flows need of the plugin runtime (LfcpRuntime implements it). */
export interface DeviceRuntime {
  registry(): Promise<RegistryEntry[]>;
  /** An open section's profile, undefined while it is not open here (LfcpRuntime.sectionProfile). */
  sectionProfile?(resource: ResourceId): unknown;
  readonly localState: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
}

export interface DeviceServiceOptions {
  readonly runtime: () => DeviceRuntime | null;
  readonly context: () => CollaborationContext | null;
  readonly collab: () => Collaboration | null;
  /** The default server: where the person's device list is kept (§5.1). */
  readonly defaultServer: () => string;
  /** "desktop" or "mobile": the managing device's default preset reads it (§5.4). */
  readonly platform: string;
  /** Shared sections are on: their Resources go into the roster. */
  readonly sections: boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long one server request may take before it reads as "could not be reached". */
  readonly requestTimeoutMs?: number;
  readonly flows?: IdentityFlows;
  /** Adds the first device's new sections to the roster (default: the SDK's addToRoster). */
  readonly roster?: RosterWriter;
}

/** The device list as shown. */
export type DeviceList =
  | { readonly kind: "none" }
  | {
      readonly kind: "list";
      readonly rows: readonly DeviceRow[];
      /** Read from the server now; false: from this device's last copy. */
      readonly current: boolean;
      /** This device may add and remove devices. */
      readonly manages: boolean;
      /** Why the server's copy could not be read, when it could not. */
      readonly note: string | null;
    };

/** A step left unfinished, offered again (§9: resumed, never repeated). */
export interface Unfinished {
  /**
   * approval, removal, request: an operation of the SDK's journal, resumed
   * by its own call. registration, key: what the device upkeep finishes
   * (upkeep: a device not added to sections yet; a key change after a
   * removal this device makes; a key this device holds and has not handed
   * to one of the person's devices); `operation` is empty.
   */
  readonly kind:
    | "approval"
    | "removal"
    | "request"
    | "registration"
    | "key"
    | "handover"
    | "roster";
  readonly operation: string;
  readonly label: string;
  /** The sections concerned, by name (registration, key). */
  readonly sections?: readonly string[];
}

/** What one device upkeep did (§7.1, §8.4). */
export interface UpkeepResult {
  /** Reconciliation of the person's device list and roster ran. */
  readonly reconciled: boolean;
  /** Each key change the rotation policy made or tried. */
  readonly rotations: readonly RotationOutcome[];
  /** What reconciliation left unfinished, by Resource: never dropped (I14). */
  readonly issues: readonly UpkeepIssue[];
  /** The device list's coordinator could not be reached: nothing was decided on its state. */
  readonly offline: boolean;
  /** Resources (hex) whose new key a key change had left owed, handed on now. */
  readonly handedOn: readonly string[];
  /** Sections of the person's roster opened on this device now, by name (§6, §7.2, §7.3). */
  readonly opened: readonly string[];
  /** The whole result in words, the sections by name. */
  readonly summary: string;
}

/** Sections (hex) the first device made or joined after pairing, waiting to be listed in the roster. */
const ROSTER_PENDING_KEY = "identity-roster-pending";

const hexList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Rotation operations the upkeep journals itself (outside the person's roster). */
const UPKEEP = "plugin-upkeep";

/**
 * Key changes whose new key a server refused to some reader (§8.4, §9.2
 * Package): the Resource, the SDK operation that made the change (the
 * upkeep's own, or a reconciliation's), and the readers still owed (hex).
 * Kept in local state until the same operation hands the key on.
 */
const OWED_KEY = "identity-rotation-owed";

interface OwedKey {
  readonly resource: string;
  readonly operation: string;
  readonly recipients: readonly string[];
}

const owedOf = (v: unknown): OwedKey[] =>
  Array.isArray(v)
    ? v.filter(
        (o): o is OwedKey =>
          typeof o === "object" &&
          o !== null &&
          typeof (o as OwedKey).resource === "string" &&
          typeof (o as OwedKey).operation === "string" &&
          Array.isArray((o as OwedKey).recipients),
      )
    : [];

/** Thrown when OpenLFCP is not ready (locked, stopped, starting). */
export class DevicesUnavailable extends Error {
  constructor() {
    super("Shared Tasks is not ready on this device.");
    this.name = "DevicesUnavailable";
  }
}

const NOT_EMPTY =
  "This vault already shares sections under its own identity, so it cannot become a device of another one. Pair a new, empty vault instead.";

const reasonText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class DeviceService {
  readonly #o: DeviceServiceOptions;
  readonly #flows: IdentityFlows;

  constructor(o: DeviceServiceOptions) {
    this.#o = o;
    this.#flows = o.flows ?? SDK_IDENTITY_FLOWS;
  }

  #context(): CollaborationContext {
    const c = this.#o.context();
    if (c === null) throw new DevicesUnavailable();
    return c;
  }

  #runtime(): DeviceRuntime {
    const r = this.#o.runtime();
    if (r === null) throw new DevicesUnavailable();
    return r;
  }

  /** The inputs of every identity flow, for this installation. */
  #flow(): IdentityFlowOptions {
    const c = this.#context();
    const ms = this.#o.requestTimeoutMs ?? 30_000;
    return {
      installation: { signer: c.principal.signer, agreement: c.principal.agreement },
      storage: c.storage,
      secrets: c.secrets,
      now: c.now,
      network: this.#flows.connectionNetwork({
        now: c.now,
        ...(c.webSocket === undefined ? {} : { webSocket: c.webSocket }),
        timeout: () => this.#o.sleep(ms),
      }),
      document: identityDocument,
    };
  }

  /** The Identity Resource this installation belongs to, if any. */
  async identity(): Promise<ResourceId | undefined> {
    return localIdentityResource(this.#context().storage);
  }

  /** Names for messages: sections by their name here, devices by their label. */
  async names(): Promise<Names> {
    const registry = await this.#runtime()
      .registry()
      .catch(() => []);
    const sections = new Map(registry.map((e) => [toHex(e.resourceId), e.localName]));
    const roster = await this.#rosterNames();
    const labels = await this.#labels();
    return {
      resource: (hex) => sections.get(hex) ?? roster.get(hex) ?? `section ${shortId(hex)}`,
      device: (hex) => labels[hex] ?? fingerprintOf(hex),
    };
  }

  /** Roster names a pairing request on this device journaled (§5.3 step 3), by Resource hex. */
  async #rosterNames(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ops = await new OperationJournal(this.#context().storage).list({
      kind: "pairing-request",
    });
    for (const op of ops) {
      const candidates = op.intent.candidates;
      if (!Array.isArray(candidates)) continue;
      for (const c of candidates as { resource?: unknown; name?: unknown }[])
        if (typeof c.resource === "string" && typeof c.name === "string")
          out.set(c.resource, c.name);
    }
    return out;
  }

  async #labels(): Promise<Readonly<Record<string, string>>> {
    return deviceLabelsOf(await this.#runtime().localState.get(DEVICE_LABELS_KEY));
  }

  /** Steps a crash, a refusal or a lost connection left unfinished on this device. */
  async unfinished(): Promise<Unfinished[]> {
    const journal = new OperationJournal(this.#context().storage);
    const label = (v: unknown, fallback: string) =>
      typeof v === "string" && v !== "" ? v : fallback;
    const names = await this.names();
    const out: Unfinished[] = [];
    for (const op of await journal.list({ kind: "pairing-approval", status: "open" }))
      out.push({
        kind: "approval",
        operation: op.id,
        label: label(op.intent.label, "a new device"),
      });
    for (const op of await journal.list({ kind: "revoke-device", status: "open" }))
      out.push({
        kind: "removal",
        operation: op.id,
        label: typeof op.intent.device === "string" ? names.device(op.intent.device) : "a device",
      });
    for (const op of await journal.list({ kind: "pairing-request", status: "open" }))
      out.push({ kind: "request", operation: op.id, label: label(op.intent.label, "this device") });
    // What reconciliation and the rotation policy still owe, from this device's stored chains.
    const local = await this.#localState();
    const pending = new Map<string, string[]>();
    if (local.identity !== null && local.manages)
      for (const [hex, chain] of local.chains)
        for (const step of planReconciliation(local.identity, chain))
          if (step.kind === "register") {
            const d = toHex(step.device);
            pending.set(d, [...(pending.get(d) ?? []), names.resource(hex)]);
          }
    for (const [device, sections] of pending)
      out.push({ kind: "registration", operation: "", label: names.device(device), sections });
    const keys = [...local.chains]
      .filter(([, chain]) => this.#rotationDue(chain))
      .map(([hex]) => names.resource(hex));
    if (keys.length > 0) out.push({ kind: "key", operation: "", label: "", sections: keys });
    const waiting = hexList(await this.#runtime().localState.get(ROSTER_PENDING_KEY));
    if (waiting.length > 0)
      out.push({
        kind: "roster",
        operation: "",
        label: "",
        sections: waiting.map((r) => names.resource(r)),
      });
    const list = local.identity === null ? "" : toHex(local.identity.state.resourceId);
    const owedKeys = await this.#keysOwed(local);
    // And the readers a key change's new key was refused to (another person's devices too).
    for (const o of owedOf(await this.#runtime().localState.get(OWED_KEY)))
      for (const r of o.recipients)
        if (!(owedKeys.get(r) ?? []).includes(o.resource))
          owedKeys.set(r, [...(owedKeys.get(r) ?? []), o.resource]);
    for (const [device, resources] of owedKeys)
      out.push({
        kind: "handover",
        operation: "",
        label: names.device(device),
        sections: resources.map((r) => (r === list ? "your device list" : names.resource(r))),
      });
    return out;
  }

  /**
   * §7.1 step 3 by this device's own ledger (§9.5): for each of the
   * person's devices that reads a Resource of the roster (or the device
   * list) at its head, the Resources with an epoch whose key this device
   * holds and has not sent it, by device (hex). A key change accepted
   * after which a package was lost is owed here until it is sent.
   */
  async #keysOwed(local: {
    readonly identity: LinearChain | null;
    readonly manages: boolean;
    readonly chains: ReadonlyMap<string, LinearChain>;
  }): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (local.identity === null || !local.manages) return out;
    const c = this.#context();
    const me = c.principal.id;
    const root = local.identity.state.owner.principalId;
    const ledger = new PackageLedger(c.storage);
    const all = [local.identity, ...local.chains.values()];
    for (const chain of all) {
      const deks = await heldDeks(c.secrets, chain);
      if (deks.size === 0) continue;
      const R = chain.state.resourceId;
      for (const reader of readersAt(chain.state)) {
        const id = reader.principalId;
        if (bytesEqual(id, me) || !bytesEqual(actsFor(chain.state, id), root)) continue;
        for (const e of deks.keys())
          if (!(await ledger.has(R, dataEpoch(BigInt(e)), id))) {
            const hex = toHex(id);
            out.set(hex, [...(out.get(hex) ?? []), toHex(R)]);
            break;
          }
      }
    }
    return out;
  }

  /**
   * This device's stored chains: the device list (when this device is in
   * one and manages devices there) and every section of the registry.
   */
  async #localState(): Promise<{
    readonly identity: LinearChain | null;
    readonly manages: boolean;
    readonly chains: ReadonlyMap<string, LinearChain>;
  }> {
    const c = this.#context();
    const me = c.principal.id;
    const I = await this.identity();
    const stored = I === undefined ? undefined : await loadControlChain(c.storage, I);
    const identity = stored?.kind === "linear" ? stored : null;
    const chains = new Map<string, LinearChain>();
    for (const e of await this.#runtime().registry()) {
      const chain = await loadControlChain(c.storage, e.resourceId);
      if (chain?.kind === "linear") chains.set(toHex(e.resourceId), chain);
    }
    return {
      identity,
      manages:
        identity !== null && mayManageDevices(identity.state, me, identity.state.owner.principalId),
      chains,
    };
  }

  /** §8.4: an exposing revocation since the current key, and this device may change the key. */
  #rotationDue(chain: LinearChain): boolean {
    return (
      exposingRevocationsSince(chain).length > 0 &&
      rotatorTest(chain.state, this.#context().principal.id).rotator
    );
  }

  #upkeep: Promise<UpkeepResult> | null = null;

  /**
   * The device upkeep (IDENTITY-PROFILE-01 §7.1, §8.4; decision I6): run
   * after start, when a section comes live, and from "Your devices…".
   *
   * - A device that manages the person's device list reconciles it with
   *   the SDK (reconcileDevices): revocations and registrations carried
   *   into every roster section (a device added while a server was down or
   *   lacked identity-01 is added now), keys sent, and the rotation policy
   *   applied to each.
   * - Every other section this device holds where an exposing revocation
   *   (another person's device removed, or one of the person's removed
   *   elsewhere) awaits a key change this device may make, typically as
   *   its owner, is rotated (rotateIfExposed) under an operation the
   *   upkeep journals; one left unfinished is resumed first.
   *
   * Without `force`, reconciliation runs only when the stored chains show
   * work (pending registrations or revocations, a due key change, an
   * unfinished registration). One upkeep at a time.
   */
  upkeep(force = false): Promise<UpkeepResult> {
    if (this.#upkeep !== null) return this.#upkeep;
    const run = this.#runUpkeep(force).finally(() => {
      this.#upkeep = null;
    });
    this.#upkeep = run;
    return run;
  }

  async #runUpkeep(force: boolean): Promise<UpkeepResult> {
    const c = this.#context();
    const flow = this.#flow();
    const journal = new OperationJournal(c.storage);
    // The device list is no section: nothing else brings its new records here. It is read
    // from its coordinator before anything is decided (a removal may be recorded there only).
    let offline = !(await this.#refreshIdentity(flow));
    const local = await this.#localState();
    const rotations: RotationOutcome[] = [];
    const issues: UpkeepIssue[] = [];
    const covered = new Set<string>();
    let reconciled = false;
    // New keys a server refused to a reader after an earlier key change: the same operation
    // hands them on (§9.1, §9.2 Package), never another key change.
    const handedOn = await this.#handOver(flow, local, issues);
    /** Key changes made now, with the operation each is journaled under. */
    const made: { readonly rotation: RotationOutcome; readonly operation: string }[] = [];
    if (local.identity !== null && local.manages) {
      const I = local.identity;
      const due =
        force ||
        this.#rotationDue(I) ||
        (await journal.list({ kind: "register-device", status: "open" })).length > 0 ||
        [...local.chains.values()].some(
          (x) => planReconciliation(I, x).length > 0 || this.#rotationDue(x),
        ) ||
        (await this.#keysOwed(local)).size > 0;
      if (due) {
        try {
          const r = await this.#flows.reconcileDevices({ ...flow, rotate: true });
          reconciled = true;
          for (const t of r.targets) {
            if (t.status !== "unreachable") covered.add(toHex(t.resource));
            if (t.rotation !== undefined) {
              rotations.push(t.rotation);
              made.push({ rotation: t.rotation, operation: r.operation });
            }
          }
          issues.push(...upkeepIssues(r.targets, r.document, toHex(I.state.resourceId)));
        } catch (e) {
          if (!(e instanceof IdentityUnavailable || e instanceof IdentityConflict)) throw e;
          offline = true;
        }
      } else for (const hex of local.chains.keys()) covered.add(hex);
    }
    // Rotations an earlier upkeep left unfinished resume from their operation (§9.1).
    for (const op of await journal.list({ kind: "rotate", status: "open" })) {
      if (op.intent.by !== UPKEEP || typeof op.intent.resource !== "string") continue;
      const chain = local.chains.get(op.intent.resource);
      if (chain === undefined) continue;
      const rotation = await this.#rotate(flow, journal, op.id, chain);
      rotations.push(rotation);
      made.push({ rotation, operation: op.id });
      covered.add(op.intent.resource);
    }
    for (const [hex, chain] of local.chains) {
      if (covered.has(hex) || !this.#rotationDue(chain)) continue;
      const id = `rotate.${toHex(secureRandom(8))}`;
      await journal.begin({
        id,
        kind: "rotate",
        createdAt: flow.now(),
        intent: { by: UPKEEP, resource: hex },
      });
      const rotation = await this.#rotate(flow, journal, id, chain);
      rotations.push(rotation);
      made.push({ rotation, operation: id });
    }
    // A key change whose new key a server refused to a reader is not finished (C1, C2).
    const owed = owedOf(await this.#runtime().localState.get(OWED_KEY));
    for (const { rotation, operation } of made) {
      const skipped = rotation.keys?.skipped ?? [];
      if (skipped.length === 0) continue;
      const resource = toHex(rotation.resource);
      issues.push({
        resource,
        kind: "keys",
        detail: [...new Set(skipped.map((x) => x.reason))].join(", "),
      });
      owed.push({ resource, operation, recipients: skipped.map((x) => x.recipient) });
    }
    if (made.some((m) => (m.rotation.keys?.skipped.length ?? 0) > 0))
      await this.#runtime().localState.put(OWED_KEY, owed);
    // The first device's new sections into the roster (roster.ts), before anything reads it.
    if (!offline) await this.#flushRoster(issues);
    // The person's sections this device does not hold yet: created or joined on another of
    // the person's devices after this one was paired (§6; §7.2 step 4, §7.3 roster entries).
    const opened = offline ? [] : await this.#openRoster(flow);
    const result = { reconciled, rotations, issues, offline, handedOn, opened };
    return { ...result, summary: upkeepText(result, await this.names()) };
  }

  /**
   * A section this installation created or joined (LFCP-04-413e item 3).
   * On the first device, once the person has a device list, it is queued
   * for the roster and listed now if it can be; a device that is not the
   * first one lists its sections through the SDK's flows (§7.2, §7.3), and
   * without a device list there is no roster yet (its creation lists every
   * section, §5.1).
   */
  async listInRoster(resource: ResourceId): Promise<void> {
    if ((await this.identity()) === undefined || (await this.origin()) !== null) return;
    const runtime = this.#runtime();
    const hex = toHex(resource);
    const queued = hexList(await runtime.localState.get(ROSTER_PENDING_KEY));
    if (!queued.includes(hex)) await runtime.localState.put(ROSTER_PENDING_KEY, [...queued, hex]);
    await this.#flushRoster([]);
  }

  /** Lists every queued section through the roster port; what it cannot list stays queued, as an issue. */
  async #flushRoster(issues: UpkeepIssue[]): Promise<void> {
    const runtime = this.#runtime();
    const queued = hexList(await runtime.localState.get(ROSTER_PENDING_KEY));
    if (queued.length === 0) return;
    const entries = new Map((await this.#roster()).map((r) => [toHex(r.resource), r.entry]));
    const writer = this.#o.roster ?? { add: (r, entry) => this.#addToRoster(r, entry) };
    const still: string[] = [];
    for (const hex of queued) {
      const entry = entries.get(hex);
      // No longer here (discarded, forgotten): nothing to list.
      if (entry === undefined) continue;
      const r = await writer.add(fromHex(hex) as ResourceId, entry);
      if (r.kind === "added") continue;
      still.push(hex);
      issues.push({
        resource: hex,
        kind: "roster",
        ...(r.kind === "refused"
          ? { detail: r.code }
          : r.kind === "unavailable"
            ? { detail: r.reason }
            : {}),
      });
    }
    await runtime.localState.put(ROSTER_PENDING_KEY, still);
  }

  /** The SDK's addToRoster (0.3.1): one durable operation; an entry already there is "added". */
  async #addToRoster(resource: ResourceId, entry: RosterEntryValue): Promise<RosterAdd> {
    try {
      const r = await this.#flows.addToRoster({
        ...this.#flow(),
        resource,
        entry,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      });
      switch (r.kind) {
        case "added":
        case "present":
          return { kind: "added" };
        case "unavailable":
          return { kind: "unavailable", reason: r.reason };
        case "needs-writer":
          return { kind: "refused", code: "NEEDS_WRITER" };
        case "document-incomplete":
          return { kind: "refused", code: r.code };
        case "conflict":
          return { kind: "refused", code: "CONTROL_CONFLICT" };
      }
    } catch (e) {
      if (e instanceof IdentityUnavailable) return { kind: "unavailable", reason: e.message };
      if (e instanceof IdentityConflict) return { kind: "refused", code: "CONTROL_CONFLICT" };
      throw e;
    }
  }

  /**
   * Opens every section of the person's roster this device does not hold
   * and may use now: registered there, every epoch's key held (the same
   * evidence as §6 "ready"), its profile one this version opens. A section
   * not ready yet is left for a later upkeep. Returns the names opened.
   */
  async #openRoster(flow: IdentityFlowOptions): Promise<string[]> {
    const collab = this.#o.collab();
    const I = await this.identity();
    if (collab === null || I === undefined) return [];
    const roster = await this.#identityRoster(flow, I);
    if (roster === null) return [];
    const c = this.#context();
    const runtime = this.#runtime();
    // Done only once open here: a row stored by an attempt that then failed to open is tried
    // again (openFromRoster opens a stored one again).
    const here = new Set(
      (await runtime.registry())
        .filter(
          (e) =>
            e.profile !== SECTIONS_PROFILE_ID ||
            runtime.sectionProfile === undefined ||
            runtime.sectionProfile(e.resourceId) !== undefined,
        )
        .map((e) => toHex(e.resourceId)),
    );
    const opened: string[] = [];
    for (const [hex, entry] of roster) {
      if (hex === toHex(I) || here.has(hex) || !this.#profileOk(entry.profile)) continue;
      const X = fromHex(hex) as ResourceId;
      let channel: IdentityChannel | undefined;
      try {
        channel = await flow.network.connect(flow.installation.signer, entry.coordinator);
        const chain = await this.#flows.syncChain(c.storage, channel, X);
        const deks = await this.#flows.fetchDeks(
          c.storage,
          c.secrets,
          channel,
          chain,
          flow.installation,
        );
        if (![...chain.state.epochs.keys()].every((e) => deks.has(e))) continue;
        await collab.openFromRoster(X, entry.name ?? null);
        opened.push(entry.name ?? `section ${shortId(hex)}`);
      } catch (e) {
        // Not registered here yet, not reachable, or not openable by this version: later.
        if (
          !(
            e instanceof IdentityUnavailable ||
            e instanceof IdentityRefused ||
            e instanceof IdentityConflict ||
            e instanceof CollabError
          )
        )
          throw e;
      } finally {
        channel?.close();
      }
    }
    return opened;
  }

  /**
   * Hands on the new keys earlier key changes left owed: each owed change
   * is resumed with rotateIfExposed on its own operation, which sends the
   * packages its ledger lacks and changes no key. What is still refused or
   * unreachable stays owed, as an issue. Returns the Resources (hex) whose
   * keys were all handed on.
   */
  async #handOver(
    flow: FlowOptions,
    local: {
      readonly identity: LinearChain | null;
      readonly chains: ReadonlyMap<string, LinearChain>;
    },
    issues: UpkeepIssue[],
  ): Promise<string[]> {
    const runtime = this.#runtime();
    const owed = owedOf(await runtime.localState.get(OWED_KEY));
    if (owed.length === 0) return [];
    const done: string[] = [];
    const still: OwedKey[] = [];
    for (const o of owed) {
      const chain =
        local.chains.get(o.resource) ??
        (local.identity !== null && toHex(local.identity.state.resourceId) === o.resource
          ? local.identity
          : undefined);
      if (chain === undefined) {
        still.push(o);
        continue;
      }
      let channel: IdentityChannel | undefined;
      try {
        channel = await flow.network.connect(
          flow.installation.signer,
          chain.state.route.coordinatorUrl,
        );
        const outcome = await this.#flows.rotateIfExposed({
          ...flow,
          channel,
          operation: o.operation,
          resource: chain.state.resourceId,
        });
        const skipped = outcome.keys?.skipped ?? [];
        if (
          outcome.status === "unreachable" ||
          outcome.status === "refused" ||
          skipped.length > 0
        ) {
          still.push(
            skipped.length > 0 ? { ...o, recipients: skipped.map((x) => x.recipient) } : o,
          );
          issues.push({
            resource: o.resource,
            kind: "keys",
            detail:
              skipped.length > 0
                ? [...new Set(skipped.map((x) => x.reason))].join(", ")
                : (outcome.code ?? outcome.status),
          });
        } else done.push(o.resource);
      } catch (e) {
        if (!(e instanceof IdentityUnavailable || e instanceof IdentityConflict)) throw e;
        still.push(o);
        issues.push({ resource: o.resource, kind: "unreachable" });
      } finally {
        channel?.close();
      }
    }
    await runtime.localState.put(OWED_KEY, still);
    return done;
  }

  /**
   * The device list's chain as its coordinator has it, stored (a fork is
   * stored as a conflict by the SDK). Unreachable or refused: the stored
   * copy stands, and the next upkeep reads it again.
   */
  async #refreshIdentity(flow: FlowOptions): Promise<boolean> {
    const c = this.#context();
    const I = await this.identity();
    if (I === undefined) return true;
    const stored = await loadControlChain(c.storage, I);
    if (stored?.kind !== "linear") return true;
    let channel: IdentityChannel | undefined;
    try {
      channel = await flow.network.connect(
        flow.installation.signer,
        stored.state.route.coordinatorUrl,
      );
      await this.#flows.syncChain(c.storage, channel, I);
      return true;
    } catch (e) {
      if (
        !(
          e instanceof IdentityUnavailable ||
          e instanceof IdentityRefused ||
          e instanceof IdentityConflict
        )
      )
        throw e;
      return !(e instanceof IdentityUnavailable);
    } finally {
      channel?.close();
    }
  }

  /** One key change by the rotation policy, under the upkeep's operation `id`. */
  async #rotate(
    flow: FlowOptions,
    journal: OperationJournal,
    id: string,
    chain: LinearChain,
  ): Promise<RotationOutcome> {
    const resource = chain.state.resourceId;
    let channel: IdentityChannel | undefined;
    let outcome: RotationOutcome;
    try {
      channel = await flow.network.connect(
        flow.installation.signer,
        chain.state.route.coordinatorUrl,
      );
      outcome = await this.#flows.rotateIfExposed({ ...flow, channel, operation: id, resource });
    } catch (e) {
      if (!(e instanceof IdentityUnavailable || e instanceof IdentityConflict)) throw e;
      outcome = { resource, status: "unreachable" };
    } finally {
      channel?.close();
    }
    const open = outcome.status === "unreachable" || outcome.status === "awaiting-key-holder";
    await journal.setStatus(id, open ? "open" : "done");
    return outcome;
  }

  // --- The managing side (O2) ------------------------------------------------

  /**
   * The warning before the person's first pairing (LFCP-04-411, compat.ts):
   * null once a device list exists, or when no section is shared with
   * anyone else. Each section's server is asked whether it supports
   * devices (READY, W §37); one that does not answer is "not known".
   */
  async firstPairingWarning(): Promise<PairingWarning | null> {
    if ((await this.identity()) !== undefined) return null;
    const collab = this.#o.collab();
    const runtime = this.#runtime();
    const entries = (await runtime.registry()).filter((e) => this.#profileOk(e.profile));
    const statuses = new Map<string, Awaited<ReturnType<Collaboration["status"]>>>();
    const support = new Map<string, boolean | null>();
    const flow = this.#flow();
    for (const e of entries) {
      const s = await collab?.status(e.resourceId).catch(() => undefined);
      if (s === undefined) continue;
      statuses.set(toHex(e.resourceId), s);
      if (s.coordinator !== null && !support.has(s.coordinator))
        support.set(s.coordinator, await this.#supports(flow, s.coordinator));
    }
    const sections = await pairingSections({
      resources: async () =>
        entries.map((e) => ({
          resourceId: toHex(e.resourceId),
          name: e.localName ?? `section ${shortId(toHex(e.resourceId))}`,
        })),
      status: async (hex) => {
        const s = statuses.get(hex);
        if (s === undefined) throw new Error("no status");
        return s;
      },
      identityServer: (url) => support.get(url) ?? null,
    });
    return firstPairingWarning({ firstPairing: true, sections });
  }

  /** Whether the server at `url` advertises identity-01; null when it does not answer. */
  async #supports(flow: FlowOptions, url: string): Promise<boolean | null> {
    let channel: IdentityChannel | undefined;
    try {
      channel = await flow.network.connect(flow.installation.signer, url);
      return channel.extensions.includes("identity-01");
    } catch {
      return null;
    } finally {
      channel?.close();
    }
  }

  #profileOk(profile: string): boolean {
    return profile === PROFILE_ID || (this.#o.sections && profile === SECTIONS_PROFILE_ID);
  }

  /**
   * The roster of a new device list (§5.1 step 2): every Resource of this
   * installation with a stored chain. A section not hosted yet is listed
   * too: it reaches the new device once hosted (a discarded draft is no
   * longer in the registry).
   */
  async #roster(): Promise<{ resource: ResourceId; entry: RosterEntryValue }[]> {
    const runtime = this.#runtime();
    const storage = this.#context().storage;
    const out: { resource: ResourceId; entry: RosterEntryValue }[] = [];
    for (const e of await runtime.registry()) {
      if (!this.#profileOk(e.profile)) continue;
      const chain = await loadControlChain(storage, e.resourceId);
      if (chain?.kind !== "linear") continue;
      out.push({
        resource: e.resourceId,
        entry: {
          profile: e.profile,
          endpoints: e.routes.length > 0 ? e.routes : [chain.state.route.coordinatorUrl],
          coordinator: chain.state.route.coordinatorUrl,
          ...(e.localName === null ? {} : { name: e.localName }),
        },
      });
    }
    return out;
  }

  /**
   * "Add my other device…" (§5.1, §5.3 step 1): the device list is
   * created on the first use; an open session of this device is shown
   * again rather than a second one made.
   */
  async startSession(label: string): Promise<SessionView> {
    const flow = this.#flow();
    if ((await this.identity()) === undefined) {
      const url = this.#o.defaultServer().trim();
      if (url === "")
        return {
          kind: "stop",
          message: "Set a default server in Settings first: your device list is kept there.",
        };
      const created = createView(
        await this.#flows.createIdentityResource({
          ...flow,
          url,
          label,
          platform: this.#o.platform,
          roster: await this.#roster(),
          addedAt: rfc3339(flow.now()),
        }),
      );
      if (created.kind === "stop") return created;
    }
    const open = (await this.#flows.openPairingSessions(flow))[0];
    try {
      return sessionView(
        open === undefined
          ? await this.#flows.createPairingSession(flow)
          : await this.#flows.resumePairingSession(flow, open.session),
      );
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /**
   * The valid requests of a session (§5.3 step 4); null when the server
   * could not be reached (asked again later); a stop when the device list
   * cannot be read (forked, refused).
   */
  async requests(session: string): Promise<readonly PairingReview[] | null | Stop> {
    try {
      return await this.#flows.pairingRequests({ ...this.#flow(), session });
    } catch (e) {
      if (e instanceof IdentityUnavailable) return null;
      return this.#thrown(e);
    }
  }

  /** §5.3 steps 4–10: approves a confirmed request with a preset (a service: within its scope). */
  async approve(
    review: PairingReview,
    preset: MaskPreset,
    scope?: readonly ResourceId[],
  ): Promise<ApprovalView> {
    const flow = this.#flow();
    try {
      const r = await this.#flows.approvePairing({
        ...flow,
        review,
        preset,
        ...(scope === undefined ? {} : { scope }),
        addedAt: rfc3339(flow.now()),
      });
      return approvalView(r, review.label, await this.names());
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /** "Finish": resumes an approval from its next phase (§9.1). */
  async finishApproval(operation: string, label: string): Promise<ApprovalView> {
    try {
      const r = await this.#flows.resumeApproval(this.#flow(), operation);
      return approvalView(r, label, await this.names());
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /** §5.3 steps 4 and 9: rejects the request `reject` (its key), or only cancels the link. */
  async cancel(session: string, reject?: string): Promise<CancelView> {
    try {
      const r = await this.#flows.cancelPairing({
        ...this.#flow(),
        session,
        ...(reject === undefined ? {} : { reject }),
      });
      return cancelView(r, reject !== undefined);
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /**
   * The person's devices: from the server when it answers (the labels from
   * the device list's document, kept for the next time), else from this
   * device's stored copy of the chain.
   */
  async devices(): Promise<DeviceList> {
    const I = await this.identity();
    if (I === undefined) return { kind: "none" };
    const c = this.#context();
    const flow = this.#flow();
    const me = toHex(c.principal.id);
    let chain = await loadControlChain(c.storage, I);
    let labels = await this.#labels();
    let note: string | null = null;
    let current = false;
    if (chain?.kind === "linear") {
      let channel: IdentityChannel | undefined;
      try {
        channel = await flow.network.connect(
          flow.installation.signer,
          chain.state.route.coordinatorUrl,
        );
        const synced = await this.#flows.syncChain(c.storage, channel, I);
        chain = synced;
        const doc = identityDocument(I, synced.state.owner.principalId);
        await this.#flows.loadIdentityDocument({
          channel,
          chain: synced,
          deks: await this.#flows.fetchDeks(
            c.storage,
            c.secrets,
            channel,
            synced,
            flow.installation,
          ),
          doc,
        });
        const read: Record<string, string> = {};
        for (const [ref, entry] of doc.devices()) {
          const id = principalOfRef(ref);
          if (id !== undefined && entry.label.trim() !== "") read[toHex(id)] = entry.label;
        }
        labels = read;
        await this.#runtime().localState.put(DEVICE_LABELS_KEY, read);
        current = true;
      } catch (e) {
        note =
          e instanceof IdentityRefused
            ? `The server no longer gives this device your device list (${e.code}).`
            : e instanceof IdentityConflict
              ? "Your device list has two conflicting versions on the server."
              : e instanceof IdentityUnavailable
                ? "The server could not be reached: this is this device's last copy."
                : `Your device list could not be read now (${reasonText(e)}).`;
      } finally {
        channel?.close();
      }
    }
    if (chain?.kind !== "linear")
      return {
        kind: "list",
        rows: [],
        current: false,
        manages: false,
        note: note ?? "This device has no copy of your device list yet.",
      };
    const rows = deviceRows(chain.state, me, labels);
    const mine = rows.find((r) => r.thisDevice);
    return {
      kind: "list",
      rows,
      current,
      manages: mine?.manages === true && mine.state === "active",
      note,
    };
  }

  /** §8.1: what removing `device` (hex) does, before the human confirms. */
  async previewRemoval(device: string): Promise<RemovalView | Stop> {
    try {
      const p = await this.#flows.previewRevocation({
        ...this.#flow(),
        device: fromHex(device) as PrincipalId,
      });
      return removalView(p, await this.names());
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /** §8.2–8.5: removes `device` (hex), or resumes `operation`. Reason 0 retired, 1 lost, 2 compromised. */
  async remove(
    device: string,
    reason: 0n | 1n | 2n,
    label: string,
    operation?: string,
  ): Promise<RevokeView> {
    try {
      const r = await this.#flows.revokeDevice({
        ...this.#flow(),
        device: fromHex(device) as PrincipalId,
        reason,
        ...(operation === undefined ? {} : { operation }),
      });
      return revokeView(r, label, await this.names());
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /** "Try again" for an unfinished removal (§9.1): the device is read from its journal. */
  async resumeRemoval(operation: string): Promise<RevokeView> {
    const op = await new OperationJournal(this.#context().storage).load(operation);
    const device = typeof op.intent.device === "string" ? op.intent.device : "";
    const r = op.intent.reason === "1" ? 1n : op.intent.reason === "2" ? 2n : 0n;
    return this.remove(device, r, (await this.names()).device(device), operation);
  }

  /**
   * Re-certifies devices (hex) with a certificate signed by this device
   * (§8.1: "offers to re-certify the affected devices with a chain through
   * A or the root"), the same kind, access and scope (N8). The new
   * certificate is registered in the device list first: only once it is
   * accepted there is the device re-certified. It is then registered in
   * each section the device uses (the roster in the device list; for a
   * service device its signed scope there), since reconciliation leaves
   * an active device's other certificate in place; a section not reached
   * now is said as later, a refusal with its code. This device cannot
   * re-certify itself.
   */
  async recertify(devices: readonly string[]): Promise<string> {
    const I = await this.identity();
    if (I === undefined) return "This device has no device list.";
    const c = this.#context();
    const flow = this.#flow();
    const names = await this.names();
    const stored = await loadControlChain(c.storage, I);
    if (stored?.kind !== "linear") return "This device has no copy of your device list yet.";
    let chain = stored;
    let channel: IdentityChannel | undefined;
    try {
      channel = await flow.network.connect(
        flow.installation.signer,
        stored.state.route.coordinatorUrl,
      );
      chain = await this.#flows.syncChain(c.storage, channel, I);
    } catch (e) {
      return this.#thrown(e).message;
    } finally {
      channel?.close();
    }
    const list = [{ resource: I, url: chain.state.route.coordinatorUrl }];
    const lines: string[] = [];
    const accepted: { hex: string; signed: ReturnType<typeof signChain> }[] = [];
    for (const hex of devices) {
      const name = names.device(hex);
      if (hex === toHex(c.principal.id)) {
        lines.push(`"${name}": a device cannot re-certify itself; do it from your first device.`);
        continue;
      }
      const binding = chain.state.devices.get(hex);
      if (binding?.chain === null || binding === undefined) {
        lines.push(`"${name}": not in your device list.`);
        continue;
      }
      const p = binding.chain.leaf.payload;
      const leaf = leafPayload(binding.root, p.device, p.kind, p.mask, p.scope);
      const feasible = checkIssuance({ chain, issuer: flow.installation.signer, leaf });
      if (!feasible.feasible) {
        lines.push(`"${name}" was not re-certified: not from this device (${feasible.reason}).`);
        continue;
      }
      const signed = signChain(chain.state, flow.installation.signer, leaf);
      try {
        const r = await this.#flows.registerDevice({ ...flow, chain: signed, targets: list });
        const there = r.results[0];
        if (there?.status === "registered") accepted.push({ hex, signed });
        else
          lines.push(
            `"${name}" was not re-certified: ${
              there?.status === "unreachable" || there?.status === "unsupported"
                ? "the server of your device list could not be reached"
                : `your device list refused it (${there?.code ?? there?.status ?? "refused"})`
            }.`,
          );
      } catch (e) {
        lines.push(`"${name}" was not re-certified: ${this.#thrown(e).message}`);
      }
    }
    if (accepted.length === 0) return lines.join(" ");
    // The same certificate in each section the device uses (the roster in the device list;
    // a service device's signed scope within it): registered explicitly, since reconciliation
    // leaves an active device's other certificate in place (§7.1 step 2).
    const roster = await this.#identityRoster(flow, I);
    for (const { hex, signed } of accepted) {
      const name = names.device(hex);
      if (roster === null) {
        lines.push(
          `"${name}" is re-certified in your device list. Its sections could not be reached now: re-certify it again to finish.`,
        );
        continue;
      }
      const payload = signed.leaf.payload;
      const targets = [...roster]
        .filter(
          ([r]) =>
            r !== toHex(I) &&
            (payload.kind !== DEVICE_KIND.SERVICE || payload.scope.some((x) => toHex(x) === r)),
        )
        .map(([r, entry]) => ({ resource: fromHex(r) as ResourceId, url: entry.coordinator }));
      let results: readonly RegistrationResult[] = [];
      try {
        results = (await this.#flows.registerDevice({ ...flow, chain: signed, targets })).results;
      } catch (e) {
        if (!(e instanceof IdentityUnavailable || e instanceof IdentityConflict)) throw e;
        results = targets.map((t) => ({ resource: t.resource, status: "unreachable" as const }));
      }
      const where = (ts: readonly RegistrationResult[]) =>
        ts.map((t) => `"${names.resource(toHex(t.resource))}"`).join(", ");
      const refused = results.filter((t) => t.status === "refused" || t.status === "superseded");
      const later = results.filter(
        (t) => t.status !== "registered" && t.status !== "refused" && t.status !== "superseded",
      );
      const codes = [...new Set(refused.map((t) => t.code ?? t.status))].join(", ");
      lines.push(
        [
          `"${name}" is re-certified in your device list.`,
          ...(later.length === 0
            ? []
            : // Reconciliation finishes a personal device there; a service device's only path is this.
              payload.kind === DEVICE_KIND.SERVICE
              ? [`Not reached yet: ${where(later)}; re-certify it again to finish.`]
              : [`Not reached yet, done later: ${where(later)}.`]),
          ...(refused.length === 0 ? [] : [`Refused there: ${where(refused)} (${codes}).`]),
        ].join(" "),
      );
    }
    return lines.join(" ");
  }

  /**
   * The roster in the device list, as its coordinator has it: Resource
   * (hex) → its entry, archived entries left out. Null when it cannot be
   * read now.
   */
  async #identityRoster(
    flow: IdentityFlowOptions,
    I: ResourceId,
  ): Promise<ReadonlyMap<string, RosterEntryValue> | null> {
    const c = this.#context();
    const stored = await loadControlChain(c.storage, I);
    if (stored?.kind !== "linear") return null;
    let channel: IdentityChannel | undefined;
    try {
      channel = await flow.network.connect(
        flow.installation.signer,
        stored.state.route.coordinatorUrl,
      );
      const chain = await this.#flows.syncChain(c.storage, channel, I);
      const doc = identityDocument(I, chain.state.owner.principalId);
      await this.#flows.loadIdentityDocument({
        channel,
        chain,
        deks: await this.#flows.fetchDeks(c.storage, c.secrets, channel, chain, flow.installation),
        doc,
      });
      const out = new Map<string, RosterEntryValue>();
      for (const [ref, entry] of doc.roster())
        if (entry.archived !== true) out.set(toHex(fromBase64url(ref)), entry);
      return out;
    } catch (e) {
      if (
        e instanceof IdentityUnavailable ||
        e instanceof IdentityRefused ||
        e instanceof IdentityConflict
      )
        return null;
      throw e;
    } finally {
      channel?.close();
    }
  }

  // --- A device that is not the first one (§7.2, §7.3) -------------------------

  /**
   * This installation as a device of a person, or null: no device list, or
   * the first device (the root itself, whose joins and sections are its
   * own already). Read from the stored device list, offline too.
   */
  async origin(): Promise<DeviceOrigin | null> {
    const c = this.#o.context();
    if (c === null) return null;
    const I = await localIdentityResource(c.storage);
    if (I === undefined) return null;
    const chain = await loadControlChain(c.storage, I);
    if (chain?.kind !== "linear" || bytesEqual(chain.state.owner.principalId, c.principal.id))
      return null;
    return {
      accept: (link, name, operation) => this.#acceptAsDevice(link, name, operation),
      create: (o) => this.#createAsDevice(o),
    };
  }

  /** §7.3 with the SDK's createResourceAsDevice: a section owned by the root, Genesis field 5. */
  async #createAsDevice(o: {
    readonly name: string;
    readonly url: string;
    readonly operation: string;
  }): Promise<DeviceCreate> {
    try {
      const r = await this.#flows.createResourceAsDevice({
        ...this.#flow(),
        dataProfile: SECTIONS_PROFILE_ID,
        url: o.url,
        ...(o.name.trim() === "" ? {} : { name: o.name.trim() }),
        operation: o.operation,
      });
      switch (r.kind) {
        case "created":
          return { kind: "created", resourceId: r.resource, listed: r.roster };
        case "incomplete":
          return { kind: "created", resourceId: r.resource, listed: false };
        case "not-owner-acting":
          return {
            kind: "refused",
            code: "NOT_OWNER_ACTING",
            message:
              "This device cannot create shared sections for you: share it from your first device or a device with Full access.",
          };
        case "refused":
          return {
            kind: "refused",
            code: r.code,
            message: `The server refused the new section (${r.code}).`,
          };
        case "conflict":
          return {
            kind: "refused",
            code: "CONTROL_CONFLICT",
            message: "Your device list has two conflicting versions on the server.",
          };
        case "unavailable":
          return {
            kind: "unavailable",
            message:
              "The server could not be reached: a device makes your shared sections on the server, so sharing finishes when it is reachable.",
          };
      }
    } catch (e) {
      return { kind: "refused", code: "IDENTITY", message: this.#thrown(e).message };
    }
  }

  /** §7.2 with the SDK's acceptInvitationAsDevice: the claim names the root. */
  async #acceptAsDevice(link: string, name: string, operation?: string): Promise<DeviceJoin> {
    try {
      const r = await this.#flows.acceptInvitationAsDevice({
        ...this.#flow(),
        link,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        ...(operation === undefined ? {} : { operation }),
      });
      switch (r.kind) {
        case "claimed":
          return { kind: "claimed", resourceId: r.resource, listed: r.roster };
        case "incomplete":
          return { kind: "claimed", resourceId: r.resource, listed: false };
        case "needs-writer":
          return {
            kind: "refused",
            code: "NEEDS_WRITER",
            message:
              "This device only reads your device list, so it cannot accept invitations for you. Accept it on your first device or a device with Full access; the invitation is not used.",
          };
        case "invalid-invitation":
          return {
            kind: "refused",
            code: "INVALID_INVITATION",
            message: "This invitation link does not work.",
          };
        case "refused":
          return {
            kind: "refused",
            code: r.code,
            message: `The server refused the invitation (${r.code}).`,
          };
        case "conflict":
          return {
            kind: "refused",
            code: "CONTROL_CONFLICT",
            message: "The section has two conflicting versions on the server.",
          };
        case "unavailable":
          return {
            kind: "unavailable",
            message: "The server could not be reached. Use the same link again to finish joining.",
            ...(r.operation === undefined ? {} : { operation: r.operation }),
          };
      }
    } catch (e) {
      const stop = this.#thrown(e);
      return { kind: "refused", code: "IDENTITY", message: stop.message };
    }
  }

  // --- The new device's side (O3) --------------------------------------------

  /** Why this vault cannot be paired as a device of another installation, or null. */
  async pairRefusal(): Promise<string | null> {
    if ((await this.openRequest()) !== null) return null;
    if ((await this.identity()) !== undefined)
      return 'This device is already in a device list. Add other devices from here with "Add my other device…".';
    if ((await this.#runtime().registry()).length > 0) return NOT_EMPTY;
    return null;
  }

  /**
   * The request of this device still to finish (§9: resumed with its
   * fingerprint): an open one, or the last one whose sections are not all
   * opened here yet (the SDK closes it once every candidate is ready).
   */
  async openRequest(): Promise<{
    readonly operation: string;
    readonly fingerprint: string;
  } | null> {
    const journal = new OperationJournal(this.#context().storage);
    const open = (await journal.list({ kind: "pairing-request", status: "open" }))[0];
    const kept = await this.#runtime().localState.get(PAIRING_KEY);
    const id =
      open?.id ??
      (typeof kept === "string" && (await journal.get(kept)) !== undefined ? kept : undefined);
    if (id === undefined) return null;
    return { operation: id, fingerprint: fingerprintOf(toHex(this.#context().principal.id)) };
  }

  /** §5.3 steps 2–3: the request with `link`, labelled `label`; the fingerprint to compare. */
  async request(link: PairingLinkText | string, label: string): Promise<RequestView> {
    const refusal = await this.pairRefusal();
    if (refusal !== null) return { kind: "stop", message: refusal };
    const flow = this.#flow();
    try {
      const r = await this.#flows.requestPairing({
        ...flow,
        link: typeof link === "string" ? new PairingLink(link) : link,
        label,
        kind: 0,
        platform: this.#o.platform,
        requestedAt: rfc3339(flow.now()),
      });
      if (r.kind === "requested") await this.#runtime().localState.put(PAIRING_KEY, r.operation);
      return requestView(r);
    } catch (e) {
      return this.#thrown(e);
    }
  }

  /**
   * §5.3 steps 8 and 11: the result so far, and every section the device
   * was added to and holds the keys of, opened here (roster-driven, §6).
   * Resumable at any time; a timeout is never a decision.
   */
  async progress(
    operation: string,
  ): Promise<ProgressView & { readonly opened: readonly string[] }> {
    const names = await this.names();
    const request = await new OperationJournal(this.#context().storage).get(operation);
    const identity = typeof request?.intent.identity === "string" ? request.intent.identity : "";
    let outcome: Awaited<ReturnType<IdentityFlows["completePairing"]>>;
    try {
      outcome = await this.#flows.completePairing({ ...this.#flow(), operation });
    } catch (e) {
      outcome = { kind: "unavailable", reason: this.#thrown(e).message };
    }
    const opened: string[] = [];
    const failures: OpenFailure[] = [];
    if (outcome.kind === "approved") {
      const collab = this.#o.collab();
      for (const c of outcome.candidates) {
        // The device list (the Identity Resource) is not a section: it is never opened as one.
        if (c.status !== "ready" || toHex(c.resource) === identity) continue;
        try {
          if (collab === null) throw new DevicesUnavailable();
          if (await collab.openFromRoster(c.resource, c.name ?? null))
            opened.push(c.name ?? names.resource(toHex(c.resource)));
        } catch (e) {
          failures.push({
            resource: toHex(c.resource),
            newerVersion: e instanceof CollabError && e.code === "NEWER_VERSION_NEEDED",
            reason: reasonText(e),
          });
        }
      }
    }
    const view = progressView(outcome, names, identity, failures);
    // The request is resumed (openRequest) until every section it brought is opened here.
    if (view.final) await this.#runtime().localState.put(PAIRING_KEY, null);
    return { ...view, opened };
  }

  /**
   * §8.6 on a device: for each section the server refuses this device,
   * whether it was proven removed from the person's identity, or only
   * refused. Sections are read from the registry; none is asked when the
   * device has no device list.
   */
  async accessStates(): Promise<{ readonly name: string; readonly text: string }[]> {
    if ((await this.identity()) === undefined) return [];
    const flow = this.#flow();
    const out: { name: string; text: string }[] = [];
    const storage = this.#context().storage;
    for (const e of await this.#runtime().registry()) {
      if (e.refusal?.code !== "AUTHORIZATION_FAILED") continue;
      const chain = await loadControlChain(storage, e.resourceId);
      if (chain?.kind !== "linear") continue;
      const s = await this.#flows
        .revocationStatus({
          ...flow,
          resource: e.resourceId,
          url: chain.state.route.coordinatorUrl,
        })
        .catch(() => ({ kind: "unreachable", reason: "" }) as const);
      const text =
        s.kind === "revocation-proven"
          ? "This device was removed from your identity."
          : s.kind === "access-refused"
            ? "This device no longer has access to this section; it may have been removed from your identity."
            : null;
      if (text !== null)
        out.push({ name: e.localName ?? `section ${shortId(toHex(e.resourceId))}`, text });
    }
    return out;
  }

  /** A thrown flow error as what the dialog says: offline, forked, or the error itself. */
  #thrown(e: unknown): Stop {
    if (e instanceof IdentityUnavailable) return { kind: "stop", message: OFFLINE };
    if (e instanceof IdentityConflict)
      return {
        kind: "stop",
        message:
          "Your device list has two conflicting versions on the server, so devices cannot be added or removed now.",
      };
    if (e instanceof IdentityRefused)
      return { kind: "stop", message: `The server refused this (${e.code}).` };
    if (e instanceof DevicesUnavailable) return { kind: "stop", message: e.message };
    throw e;
  }
}

/** RFC 3339 UTC, whole seconds (the document's `added_at` and `requested_at`). */
export const rfc3339 = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
