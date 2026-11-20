// A section's installation of LFCP Bridge (MVP 0.6 A§4.3, A§5.2, E9–E11;
// E-023): toggling section X asks the bridge through its control Resource C
// (`requests/<rid> = {op: pair-section, binding: X, args: {link}}` with the
// link of a new pairing session J_X); the SDK's autoApproveSection approves
// the bridge's request without the human only when every check of A§4.3
// step 3 holds, and otherwise cancels J_X and writes `cancels{mismatch}`.
// One open session per bridge, journaled in local state (no secret: the
// link is read again from J_X's session); the local deadline (30 min) and a
// cancel cut short by a restart are finished on a later tick.

import type {
  ApprovalResult,
  IdentityFlowOptions,
  ServiceControlPort,
  ServiceControlStateView,
} from "@openlfcp/client";
import { createdBy, principalOfRef } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { parsePairingUri } from "@openlfcp/wire";
import { ATTEMPT_DEADLINE_MS } from "./connect-attempt";
import type { IdentityFlows } from "./flows";

/** Local state: the section pairings of this installation, by C (hex): one open per bridge. */
export const SECTIONS_KEY = "reminders-sections";
/** A§5.2: at most 8 connected sections per bridge; paused ones count, only Remove frees one. */
export const MAX_SECTIONS = 8;

export type SectionPairingState =
  /** J_X made, the request written in C; waiting for the bridge's `pairing/<rid>` and its request in I. */
  | "pairing"
  /** Consumed (A1): the phases go on, no cancel any more (A§4.4). */
  | "approving"
  /** A1–A4 done: the bridge reports `ready` in C next. */
  | "connected"
  // Final, before the consume: J_X revoked.
  | "mismatch"
  | "expired"
  | "cancelled"
  /** Stopped with a message (C refused the request, the server refused a phase). */
  | "failed";

const OPEN: ReadonlySet<SectionPairingState> = new Set(["pairing", "approving"]);

export interface SectionPairing {
  /** UUIDv7: the `rid` of `requests/<rid>`, also the approval record's origin (A3). */
  readonly rid: string;
  /** C (hex). */
  readonly c: string;
  /** X as `requests[rid].binding` (base64url). */
  readonly binding: string;
  readonly createdAt: number;
  readonly state: SectionPairingState;
  /** J_X's pairing session; undefined until it is made (found again after a crash). */
  readonly session?: string;
  /** The sessions open before J_X was made: one open now and not among them is J_X. */
  readonly sessionsBefore?: readonly string[];
  /** `requests[rid]` acknowledged by the server. */
  readonly requested?: boolean;
  /** [Cancel] to finish (J_X not revoked yet, or `cancels[rid]` not acknowledged). */
  readonly aborting?: "user";
  /** The approval's operation once consumed (resumed after a restart). */
  readonly approval?: string;
  readonly message?: string;
}

export type SectionStart =
  | { readonly kind: "started"; readonly pairing: SectionPairing }
  /** One open section pairing per bridge (A§4.3): this one is under way. */
  | { readonly kind: "busy"; readonly pairing?: SectionPairing }
  /** A§5.2: 8 sections connected to this bridge already. */
  | { readonly kind: "sections-full" }
  /** A§5.2: live(I) + 2 + 1 > 32. */
  | { readonly kind: "too-many-devices" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface SectionPairingDeps {
  readonly flows: Pick<
    IdentityFlows,
    | "createPairingSession"
    | "resumePairingSession"
    | "openPairingSessions"
    | "cancelPairing"
    | "resumeApproval"
    | "autoApproveSection"
    | "revokeDevice"
  >;
  readonly flow: () => IdentityFlowOptions;
  readonly localState: () => {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
  /** C's port, opened here first; undefined while it cannot be. */
  readonly control: (C: ResourceId) => Promise<ServiceControlPort | undefined>;
  /** live(I) of the root and whether a device (J) is revoked in I; null when I cannot be read. */
  readonly identity: () => Promise<{
    readonly live: number;
    readonly revoked: (device: PrincipalId) => boolean;
  } | null>;
  /**
   * Runs `work` where no other pairing session is made (BridgeConnect.otherDevice): the
   * base attempt never takes J_X for its J, nor "Add my other device…" for its own.
   */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** `requests[].client` (A§3.5a). */
  readonly client: { readonly app: string; readonly protocol: number };
}

/** A§5.2: room in I for the section's installation, J_X and one spare. */
const ROOM_NEEDED = 3;
const MAX_LIVE_BOUND = 32;

/** `events.state` values after which a request is no longer open (A§3.3). */
const FINAL_EVENTS: ReadonlySet<string> = new Set([
  "ready",
  "applied",
  "failed",
  "rejected",
  "stale",
  "cancelled",
]);

/** The sections C counts against the 8 (A§5.2): approved and not removed, and bound by the bridge. */
export function connectedSections(
  state: ServiceControlStateView & { bindings?: object },
): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(state.approvals))
    if (a.role === "section" && !a.revoked) out.add(a.resource);
  for (const X of Object.keys(state.bindings ?? {})) out.add(X);
  return out;
}

/** A pair-section request of C still open (no final event, no cancel), from any managing device. */
export interface PendingConnection {
  readonly rid: string;
  readonly binding: string;
  /** J_X, from the request's link. */
  readonly pairingDevice: PrincipalId;
}

/**
 * U П1, П5 "Pending connection" [Cancel]: the pair-section requests of C
 * written by root or personal, without a final event or a cancel, whose
 * J_X is not revoked in I (once consumed or cancelled there is nothing to cancel).
 */
export function pendingConnections(
  port: Pick<ServiceControlPort, "state" | "creatorsOf">,
  revoked: (device: PrincipalId) => boolean,
): PendingConnection[] {
  const state = port.state() as
    | (ServiceControlStateView & { events?: Record<string, { state?: unknown }> })
    | undefined;
  if (state === undefined) return [];
  const out: PendingConnection[] = [];
  for (const [rid, r] of Object.entries(state.requests)) {
    if (r.op !== "pair-section" || typeof r.binding !== "string") continue;
    if (state.cancels[rid] !== undefined) continue;
    const event = state.events?.[rid]?.state;
    if (typeof event === "string" && FINAL_EVENTS.has(event)) continue;
    if (!createdBy(port.creatorsOf("requests", rid), ["root", "personal"])) continue;
    let J: PrincipalId;
    try {
      J = parsePairingUri(String(r.args.link)).pairingDevice;
    } catch {
      continue;
    }
    if (!revoked(J)) out.push({ rid, binding: r.binding, pairingDevice: J });
  }
  return out;
}

/** A UUIDv7 (RFC 9562 §5.7) in lower-case hyphenated form, as C's keys are (§2.1). */
export function uuid7(
  now: number,
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const b = new Uint8Array(16);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b.set(random.subarray(0, 10), 6);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const fromHexC = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => Number.parseInt(x, 16)) as ResourceId;

export class SectionPairings {
  readonly #d: SectionPairingDeps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SectionPairingDeps) {
    this.#d = deps;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #now(): number {
    return this.#d.flow().now();
  }

  /** This installation's section pairings, by C (hex). */
  async all(): Promise<Readonly<Record<string, SectionPairing>>> {
    return ((await this.#d.localState().get(SECTIONS_KEY)) ?? {}) as Record<string, SectionPairing>;
  }

  async #save(p: SectionPairing): Promise<SectionPairing> {
    await this.#d.localState().put(SECTIONS_KEY, { ...(await this.all()), [p.c]: p });
    return p;
  }

  /** The sessions of section pairings (never handed out as a personal device's link). */
  async sessions(): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const p of Object.values(await this.all()))
      if (p.session !== undefined && OPEN.has(p.state)) out.add(p.session);
    return out;
  }

  /** The section's toggle (the person acted, A§4.3 step 1): checks, then J_X and the request in C. */
  start(C: ResourceId, X: ResourceId): Promise<SectionStart> {
    return this.#serial(async () => {
      const c = toHex(C);
      const binding = toBase64url(X);
      const mine = (await this.all())[c];
      if (mine !== undefined && OPEN.has(mine.state)) return { kind: "busy", pairing: mine };
      const port = await this.#d.control(C);
      const state = port?.state();
      const I = await this.#d.identity();
      if (port === undefined || state === undefined || I === null)
        return { kind: "unavailable", reason: "the bridge's control Resource is not readable yet" };
      // One open pair-section per bridge (A§3.2), also one another device of the person wrote.
      if (pendingConnections(port, I.revoked).length > 0) return { kind: "busy" };
      const sections = connectedSections(state);
      sections.delete(binding);
      if (sections.size >= MAX_SECTIONS) return { kind: "sections-full" };
      if (I.live + ROOM_NEEDED > MAX_LIVE_BOUND) return { kind: "too-many-devices" };
      const now = this.#now();
      const p = await this.#d.exclusive(async () => {
        const flow = this.#d.flow();
        const before = (await this.#d.flows.openPairingSessions(flow)).map((s) => s.session);
        // Journaled before J_X exists: a crash after the SDK made it finds it again.
        const fresh = await this.#save({
          rid: uuid7(now),
          c,
          binding,
          createdAt: now,
          state: "pairing",
          sessionsBefore: before,
        });
        const made = await this.#d.flows.createPairingSession(flow);
        if (made.kind === "created") return this.#save({ ...fresh, session: made.session });
        if (made.kind === "unavailable") return this.#recover(fresh);
        return this.#save({ ...fresh, state: "failed", message: made.kind });
      });
      return { kind: "started", pairing: await this.#request(p) };
    });
  }

  /** J_X of a pairing journaled before its session was (a crash in between). */
  async #recover(p: SectionPairing): Promise<SectionPairing> {
    if (p.session !== undefined || p.sessionsBefore === undefined) return p;
    const before = new Set(p.sessionsBefore);
    const others = new Set([...(await this.sessions())]);
    const found = (await this.#d.flows.openPairingSessions(this.#d.flow())).find(
      (s) => !before.has(s.session) && !others.has(s.session),
    );
    return found === undefined ? p : this.#save({ ...p, session: found.session });
  }

  /** A§4.3 step 1: `requests/<rid>` in C, committed again (a receipt) until acknowledged. */
  async #request(p: SectionPairing): Promise<SectionPairing> {
    if (p.requested === true || p.session === undefined || p.state !== "pairing") return p;
    const port = await this.#d.control(fromHexC(p.c));
    const link = await this.#d.flows.resumePairingSession(this.#d.flow(), p.session);
    if (port === undefined || link.kind !== "created") return p;
    const r = await port
      .commit(
        [
          {
            intent: "request.create",
            rid: p.rid,
            request: {
              op: "pair-section",
              binding: p.binding,
              args: { link: link.link.reveal() },
              client: this.#d.client,
              at: iso(p.createdAt),
            },
          },
        ],
        `${p.rid}:request`,
      )
      .catch(() => null);
    if (r === null || r.kind === "queued") return p;
    if (r.kind === "acknowledged") return this.#save({ ...p, requested: true });
    // Admission refused it (A§3.5a "Couldn't send"): J_X goes, nothing was asked.
    return this.#abort({ ...p, message: `Couldn't send (${r.code})` }, "failed");
  }

  /**
   * The periodic step (and on every push of I or C): the request written,
   * the bridge's records re-checked by the SDK (approve, wait, or cancel
   * with mismatch / expired), an approval carried on, a cancel finished.
   */
  tick(): Promise<Readonly<Record<string, SectionPairing>>> {
    return this.#serial(async () => {
      for (const stored of Object.values(await this.all())) {
        if (!OPEN.has(stored.state)) continue;
        if (stored.aborting !== undefined) {
          await this.#abort(stored, "cancelled");
          continue;
        }
        const p = await this.#request(await this.#recover(stored));
        if (p.session === undefined) {
          // J_X was never made: nothing to revoke once its deadline passed.
          if (this.#now() - p.createdAt > ATTEMPT_DEADLINE_MS)
            await this.#save({ ...p, state: "expired" });
          continue;
        }
        if (p.state === "approving") await this.#resume(p);
        else if (p.requested === true) await this.#check(p);
        else if (this.#now() - p.createdAt > ATTEMPT_DEADLINE_MS) await this.#abort(p, "expired");
      }
      return this.all();
    });
  }

  /** A§4.3 step 3 by the SDK, with the local deadline. */
  async #check(p: SectionPairing): Promise<SectionPairing> {
    const port = await this.#d.control(fromHexC(p.c));
    if (port === undefined || p.session === undefined) return p;
    const r = await this.#d.flows
      .autoApproveSection({
        ...this.#d.flow(),
        session: p.session,
        rid: p.rid,
        control: port,
        expired: this.#now() - p.createdAt > ATTEMPT_DEADLINE_MS,
      })
      .catch((e: unknown) => ({ kind: "unavailable" as const, reason: String(e) }));
    switch (r.kind) {
      case "waiting":
      case "unavailable":
      case "conflict":
        return p;
      case "not-own":
        return this.#save({ ...p, state: "failed", message: r.reason });
      case "closed":
        return this.#save({ ...p, state: "cancelled" });
      case "approval":
        return this.#approved(p, r.approval);
      case "cancelled": {
        // Finished once J_X is cancelled and `cancels[rid]` acknowledged (or another hand's);
        // until then the SDK's journal finishes the same cancel on the next call.
        const revoked =
          r.cancel === undefined ||
          r.cancel.kind === "cancelled" ||
          r.cancel.kind === "document-incomplete";
        const done = revoked && (r.written === undefined || r.written.kind === "acknowledged");
        return done ? this.#save({ ...p, state: r.reason, message: r.detail }) : p;
      }
    }
  }

  async #resume(p: SectionPairing): Promise<SectionPairing> {
    const port = await this.#d.control(fromHexC(p.c));
    if (p.approval === undefined || port === undefined) return p;
    const r = await this.#d.flows
      .resumeApproval({ ...this.#d.flow(), control: port }, p.approval)
      .catch(() => null);
    return r === null ? p : this.#approved(p, r);
  }

  async #approved(p: SectionPairing, r: ApprovalResult): Promise<SectionPairing> {
    switch (r.kind) {
      case "approved":
        return this.#save({ ...p, state: "connected", approval: r.operation });
      case "approval-record-pending":
      case "document-incomplete":
      case "limit":
        return this.#save({ ...p, state: "approving", approval: r.operation });
      case "superseded":
        return this.#save({ ...p, state: "cancelled" });
      case "unavailable":
        // A1 may have run before the server stopped answering: the operation goes on.
        return r.operation === undefined || p.approval !== undefined
          ? p
          : this.#save({ ...p, state: "approving", approval: r.operation });
      case "conflict":
      case "reconfirm":
        return p;
      case "infeasible":
        return this.#save({ ...p, state: "failed", message: r.reason });
      case "refused":
        return this.#save({ ...p, state: "failed", message: r.code });
    }
  }

  /** [Cancel] of this installation's pairing on bridge C: before the consume only. */
  cancel(C: ResourceId): Promise<boolean> {
    return this.#serial(async () => {
      const p = (await this.all())[toHex(C)];
      if (p?.state !== "pairing") return false;
      return (await this.#abort(p, "cancelled")).state !== "approving";
    });
  }

  /**
   * J_X revoked (reason 0, I rotated by the SDK), then `cancels[rid] = {reason: user}`;
   * journaled first so a restart finishes it. A consumed J_X carries on (A§4.4).
   */
  async #abort(p: SectionPairing, to: "cancelled" | "expired" | "failed"): Promise<SectionPairing> {
    let next = await this.#save({ ...p, aborting: "user" });
    if (next.session !== undefined) {
      const r = await this.#d.flows
        .cancelPairing({ ...this.#d.flow(), session: next.session })
        .catch(() => ({ kind: "unavailable" }) as const);
      if (r.kind === "consumed") {
        const { aborting: _, ...rest } = next;
        return r.operation === undefined
          ? this.#save({ ...rest, state: "cancelled" })
          : this.#resume(await this.#save({ ...rest, state: "approving", approval: r.operation }));
      }
      if (r.kind !== "cancelled" && r.kind !== "document-incomplete") return next;
    }
    if (next.requested === true) {
      const port = await this.#d.control(fromHexC(next.c));
      const reason = to === "expired" ? "expired" : "user";
      const w = await port
        ?.commit(
          [{ intent: "cancel.create", rid: next.rid, cancel: { reason, at: iso(this.#now()) } }],
          `${next.rid}:cancel`,
        )
        .catch(() => null);
      if (w?.kind !== "acknowledged" && w?.kind !== "rejected") return next;
    }
    const { aborting: _, ...rest } = next;
    next = await this.#save({ ...rest, state: to });
    return next;
  }

  /**
   * [Cancel] on "Pending connection" written by another device (gone for good, A§4.3):
   * J_X revoked here (reason 0), then `cancels[rid] = {reason: user}`. Our own goes by cancel().
   */
  cancelPending(C: ResourceId, pending: PendingConnection): Promise<boolean> {
    return this.#serial(async () => {
      const own = (await this.all())[toHex(C)];
      if (own?.rid === pending.rid) {
        if (own.state !== "pairing") return false;
        return (await this.#abort(own, "cancelled")).state === "cancelled";
      }
      const r = await this.#d.flows
        .revokeDevice({ ...this.#d.flow(), device: pending.pairingDevice, reason: 0n })
        .catch(() => null);
      if (r?.kind !== "revoked") return false;
      const port = await this.#d.control(C);
      const w = await port
        ?.commit(
          [
            {
              intent: "cancel.create",
              rid: pending.rid,
              cancel: { reason: "user", at: iso(this.#now()) },
            },
          ],
          `${pending.rid}:cancel`,
        )
        .catch(() => null);
      return w?.kind === "acknowledged";
    });
  }
}

/** A principal of an approval record (hex), or undefined for a malformed one. */
export function approvedPrincipal(ref: string): string | undefined {
  const P = principalOfRef(ref);
  return P === undefined ? undefined : toHex(P);
}
