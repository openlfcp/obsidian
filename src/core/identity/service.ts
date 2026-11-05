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
  type FlowOptions,
  type IdentityChannel,
  IdentityConflict,
  type IdentityFlowOptions,
  IdentityRefused,
  IdentityUnavailable,
  leafPayload,
  loadControlChain,
  localIdentityResource,
  type MaskPreset,
  OperationJournal,
  PairingLinkText as PairingLink,
  type PairingLinkText,
  type PairingReview,
  principalOfRef,
  type RosterEntryValue,
  signChain,
} from "@openlfcp/client";
import { fromHex, type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { Collaboration } from "../collab/service";
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
} from "./pairing-view";
import { fingerprintOf, shortId } from "./people";

/** Where the labels of the person's devices are kept between loads (Principal hex → label). */
export const DEVICE_LABELS_KEY = "identity-device-labels";

/** What the device flows need of the plugin runtime (LfcpRuntime implements it). */
export interface DeviceRuntime {
  registry(): Promise<RegistryEntry[]>;
  /** A Resource never sent anywhere (a section drafted, never shared): not in the roster. */
  sectionNeverShared?(resource: ResourceId): Promise<boolean>;
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
  readonly kind: "approval" | "removal" | "request";
  readonly operation: string;
  readonly label: string;
}

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
    const v = await this.#runtime().localState.get(DEVICE_LABELS_KEY);
    return typeof v === "object" && v !== null ? (v as Record<string, string>) : {};
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
    return out;
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

  /** The roster of a new device list (§5.1 step 2): every shared Resource of this installation. */
  async #roster(): Promise<{ resource: ResourceId; entry: RosterEntryValue }[]> {
    const runtime = this.#runtime();
    const storage = this.#context().storage;
    const out: { resource: ResourceId; entry: RosterEntryValue }[] = [];
    for (const e of await runtime.registry()) {
      if (!this.#profileOk(e.profile)) continue;
      if ((await runtime.sectionNeverShared?.(e.resourceId).catch(() => false)) === true) continue;
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

  /** The valid requests of a session (§5.3 step 4); null when the server could not be reached. */
  async requests(session: string): Promise<readonly PairingReview[] | null> {
    try {
      return await this.#flows.pairingRequests({ ...this.#flow(), session });
    } catch (e) {
      if (e instanceof IdentityUnavailable) return null;
      throw e;
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
   * A or the root"), the same kind, access and scope (N8), registered in
   * the device list and every section where this device may act. This
   * device cannot re-certify itself.
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
    const targets = [
      { resource: I, url: chain.state.route.coordinatorUrl },
      ...(await this.#roster()).map((r) => ({ resource: r.resource, url: r.entry.coordinator })),
    ];
    const lines: string[] = [];
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
        lines.push(`"${name}": cannot be re-certified from this device (${feasible.reason}).`);
        continue;
      }
      const signed = signChain(chain.state, flow.installation.signer, leaf);
      try {
        const r = await this.#flows.registerDevice({ ...flow, chain: signed, targets });
        const later = r.results.filter((x) => x.status !== "registered");
        lines.push(
          later.length === 0
            ? `"${name}" is re-certified.`
            : `"${name}" is re-certified; later in ${later.map((x) => `"${names.resource(toHex(x.resource))}"`).join(", ")}.`,
        );
      } catch (e) {
        lines.push(`"${name}": ${this.#thrown(e).message}`);
      }
    }
    return lines.join(" ");
  }

  // --- The new device's side (O3) --------------------------------------------

  /** Why this vault cannot be paired as a device of another installation, or null. */
  async pairRefusal(): Promise<string | null> {
    if ((await this.identity()) !== undefined)
      return 'This device is already in a device list. Add other devices from here with "Add my other device…".';
    const open = await new OperationJournal(this.#context().storage).list({
      kind: "pairing-request",
      status: "open",
    });
    if (open.length > 0) return null;
    if ((await this.#runtime().registry()).length > 0) return NOT_EMPTY;
    return null;
  }

  /** The open request of this device (§9: resumed with its fingerprint), if any. */
  async openRequest(): Promise<{
    readonly operation: string;
    readonly fingerprint: string;
  } | null> {
    const op = (
      await new OperationJournal(this.#context().storage).list({
        kind: "pairing-request",
        status: "open",
      })
    )[0];
    if (op === undefined) return null;
    return { operation: op.id, fingerprint: fingerprintOf(toHex(this.#context().principal.id)) };
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
    let outcome: Awaited<ReturnType<IdentityFlows["completePairing"]>>;
    try {
      outcome = await this.#flows.completePairing({ ...this.#flow(), operation });
    } catch (e) {
      outcome = { kind: "unavailable", reason: this.#thrown(e).message };
    }
    const opened: string[] = [];
    if (outcome.kind === "approved") {
      const collab = this.#o.collab();
      for (const c of outcome.candidates) {
        if (c.status !== "ready" || collab === null) continue;
        try {
          if (await collab.openFromRoster(c.resource, c.name ?? null))
            opened.push(c.name ?? names.resource(toHex(c.resource)));
        } catch {
          // A section this version cannot open stays listed as ready; it opens after an update.
        }
      }
    }
    return { ...progressView(outcome, names), opened };
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
