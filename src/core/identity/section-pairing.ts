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
/** Local state: [Cancel]s of other devices' pending connections to finish, by rid. */
export const FOREIGN_CANCELS_KEY = "reminders-section-cancels";
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
  /**
   * Every pairing session open when this pairing was journaled, before J_X was made
   * (no time filter): one open later, not among them and no other pairing's, is J_X.
   */
  readonly sessionsBefore?: readonly string[];
  /**
   * Set while another pairing session is made and this pairing has no J_X yet ("Add my
   * other device…", another section): what is made meanwhile is set aside into
   * `sessionsBefore`, also after a crash that left this set (E-022d1, arbiter).
   */
  readonly othersSince?: true;
  /** `requests[rid]` acknowledged by the server. */
  readonly requested?: boolean;
  /** A cancel to finish (J_X not revoked yet, or `cancels[rid]` not acknowledged): its end state. */
  readonly aborting?: "cancelled" | "expired" | "failed";
  /**
   * `cancels[rid]` as first decided, journaled with `aborting`: every repeat commits exactly
   * these intents under `<rid>:cancel` (SyncClient refuses other intents under a known
   * operation, OPERATION_ID_REUSED).
   */
  readonly cancel?: { readonly reason: "user" | "expired"; readonly at: string };
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
    /** Read-modify-write of one key, one at a time per key. */
    update(key: string, change: (value: unknown) => unknown): Promise<void>;
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
   * base attempt never takes J_X for its J, nor "Add my other device…" for its own. Every
   * change to a pairing without its J_X is made inside it. Lock order: this class's
   * queue, then this one; "Add my other device…" holds only this one (aside()).
   */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** Sessions of other flows never taken for J_X (the base attempt's J). */
  readonly reserved: () => Promise<readonly string[]>;
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
/** A [Cancel] of another device's pending connection, journaled before J_X is revoked. */
export interface ForeignCancel {
  readonly c: string;
  readonly rid: string;
  /** J_X (hex). */
  readonly j: string;
  readonly at: string;
}

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
    await this.#d.localState().update(SECTIONS_KEY, (all) => ({
      ...((all ?? {}) as Record<string, SectionPairing>),
      [p.c]: p,
    }));
    return p;
  }

  /** The sessions of section pairings (never handed out as a personal device's link). */
  async sessions(): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const p of Object.values(await this.all()))
      if (p.session !== undefined && OPEN.has(p.state)) out.add(p.session);
    return out;
  }

  /**
   * Inside exclusive() only. A pairing without J_X: first its sessions set aside by a
   * flow a crash cut short (`othersSince`: every open session not another pairing's is
   * then not J_X, as none was open outside its snapshot when it was set and J_X is
   * never made while it stands), then J_X found: open, outside its snapshot, nobody's.
   */
  async #recoverNow(): Promise<void> {
    const waiting = Object.values(await this.all()).filter(
      (p) => OPEN.has(p.state) && p.session === undefined && p.sessionsBefore !== undefined,
    );
    if (waiting.length === 0) return;
    const open = (await this.#d.flows.openPairingSessions(this.#d.flow())).map((s) => s.session);
    const taken = new Set([...(await this.sessions()), ...(await this.#d.reserved())]);
    for (const p of waiting.filter((x) => x.othersSince === true)) {
      const { othersSince: _, ...rest } = p;
      const set = open.filter((s) => !taken.has(s));
      await this.#save({
        ...rest,
        sessionsBefore: [...new Set([...(p.sessionsBefore ?? []), ...set])],
      });
    }
    for (const stored of waiting) {
      const p = (await this.all())[stored.c] ?? stored;
      const before = new Set(p.sessionsBefore);
      const found = open.find((s) => !before.has(s) && !taken.has(s));
      if (found === undefined) continue;
      taken.add(found);
      await this.#save({ ...p, session: found });
    }
  }

  /**
   * Inside exclusive() only: `work` makes a pairing session that is not any waiting
   * pairing's J_X. Their J_X is found first; those still without one set aside what
   * `work` opens (marker journaled first, settled after, or by #recoverNow after a crash).
   */
  async #setAside<T>(work: (sections: ReadonlySet<string>) => Promise<T>): Promise<T> {
    await this.#recoverNow();
    const marked = Object.values(await this.all()).filter(
      (p) => OPEN.has(p.state) && p.session === undefined && p.sessionsBefore !== undefined,
    );
    for (const p of marked) await this.#save({ ...p, othersSince: true });
    try {
      return await work(await this.sessions());
    } finally {
      if (marked.length > 0) await this.#recoverNow();
    }
  }

  /**
   * "Add my other device…" (DeviceService.startSession), already inside exclusive()'s
   * lock: `work` gets the section pairings' sessions to leave out, J_X found again
   * first; what it makes is set aside for a pairing whose J_X is not made yet.
   */
  aside<T>(work: (sections: ReadonlySet<string>) => Promise<T>): Promise<T> {
    return this.#setAside(work);
  }

  /** Under the lock: J_X found again, then `change` on the record as stored now. */
  #locked(
    c: string,
    change: (p: SectionPairing) => SectionPairing | undefined,
  ): Promise<SectionPairing | undefined> {
    return this.#d.exclusive(async () => {
      await this.#recoverNow();
      const p = (await this.all())[c];
      const next = p === undefined ? undefined : change(p);
      return next === undefined ? p : this.#save(next);
    });
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
        return { kind: "unavailable", reason: "LFCP Bridge can't be reached from here yet" };
      // One open pair-section per bridge (A§3.2), also one another device of the person wrote.
      if (pendingConnections(port, I.revoked).length > 0) return { kind: "busy" };
      const sections = connectedSections(state);
      sections.delete(binding);
      if (sections.size >= MAX_SECTIONS) return { kind: "sections-full" };
      if (I.live + ROOM_NEEDED > MAX_LIVE_BOUND) return { kind: "too-many-devices" };
      const now = this.#now();
      const p = await this.#d.exclusive(() =>
        // Another pairing still without its J_X sets this J_X aside.
        this.#setAside(async () => {
          const flow = this.#d.flow();
          // Every open session, whatever its age (E-022d1): J_X is the one made after.
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
          if (made.kind === "unavailable") {
            await this.#recoverNow();
            return (await this.all())[c] ?? fresh;
          }
          return this.#save({ ...fresh, state: "failed", message: made.kind });
        }),
      );
      return { kind: "started", pairing: await this.#request(p) };
    });
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
    return this.#abort(p, "failed", `Couldn't send (${r.code})`);
  }

  /**
   * The periodic step (and on every push of I or C): the request written,
   * the bridge's records re-checked by the SDK (approve, wait, or cancel
   * with mismatch), an approval carried on, a cancel finished. The local
   * deadline comes first, before the request's ACK is looked for again:
   * past it nothing new is consumed, and #abort writes `cancels/<rid>`
   * whether or not the request's ACK reached this device.
   */
  tick(): Promise<Readonly<Record<string, SectionPairing>>> {
    return this.#serial(async () => {
      for (const f of Object.values(await this.#foreign())) await this.#finishForeign(f);
      const stored = Object.values(await this.all()).filter((p) => OPEN.has(p.state));
      if (stored.some((p) => p.session === undefined))
        await this.#d.exclusive(() => this.#recoverNow());
      for (const { c } of stored) {
        const found = (await this.all())[c];
        if (found === undefined || !OPEN.has(found.state)) continue;
        if (found.aborting !== undefined) {
          await this.#abort(found, found.aborting);
          continue;
        }
        const expired = this.#now() - found.createdAt > ATTEMPT_DEADLINE_MS;
        // The local deadline is checked before any new consume (A§4.3): a ready answer
        // after it is not approved; a consume already made carries on (A§4.4).
        if (found.state === "pairing" && expired) {
          await this.#abort(found, "expired");
          continue;
        }
        const p = await this.#request(found);
        if (p.session === undefined) continue;
        if (p.state === "approving") await this.#resume(p);
        else if (p.requested === true) await this.#check(p);
      }
      return this.all();
    });
  }

  /** A§4.3 step 3 by the SDK, before the local deadline (tick() checks it first). */
  async #check(p: SectionPairing): Promise<SectionPairing> {
    const port = await this.#d.control(fromHexC(p.c));
    if (port === undefined || p.session === undefined) return p;
    const r = await this.#d.flows
      .autoApproveSection({
        ...this.#d.flow(),
        session: p.session,
        rid: p.rid,
        control: port,
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
   * J_X revoked (reason 0, I rotated by the SDK), then `cancels[rid] = {reason:
   * user|expired}` whenever J_X exists: the request may be in C although its ACK
   * never reached this device (a crash, a lost answer), and a cancel the host sees
   * with or before its request is harmless (A§3.3). Done once C acknowledges or
   * refuses it; otherwise `aborting` stays and the next tick writes it again under
   * the same operation. Journaled first so a restart finishes it. A consumed J_X
   * carries on (A§4.4).
   */
  async #abort(
    p: SectionPairing,
    to: "cancelled" | "expired" | "failed",
    message?: string,
  ): Promise<SectionPairing> {
    // Journaled under the lock with J_X found first: a J_X made but not journaled is revoked too.
    let next =
      (await this.#locked(p.c, (fresh) => {
        // The first decision stands: a later [Cancel] does not change a cancel under way.
        const end = fresh.aborting ?? to;
        return {
          ...fresh,
          aborting: end,
          cancel: fresh.cancel ?? {
            reason: end === "expired" ? "expired" : "user",
            at: iso(this.#now()),
          },
          ...(message === undefined ? {} : { message }),
        };
      })) ?? p;
    const end = next.aborting ?? to;
    if (next.session !== undefined) {
      const r = await this.#d.flows
        .cancelPairing({ ...this.#d.flow(), session: next.session })
        .catch(() => ({ kind: "unavailable" }) as const);
      if (r.kind === "consumed") {
        const { aborting: _, cancel: _c, ...rest } = next;
        return r.operation === undefined
          ? this.#save({ ...rest, state: "cancelled" })
          : this.#resume(await this.#save({ ...rest, state: "approving", approval: r.operation }));
      }
      if (r.kind !== "cancelled" && r.kind !== "document-incomplete") return next;
    }
    if (next.requested === true || next.session !== undefined) {
      const port = await this.#d.control(fromHexC(next.c));
      const cancel = next.cancel ?? {
        reason: end === "expired" ? "expired" : "user",
        at: iso(this.#now()),
      };
      const w = await port
        ?.commit([{ intent: "cancel.create", rid: next.rid, cancel }], `${next.rid}:cancel`)
        // OPERATION_ID_REUSED: this operation's cancel is already durable here (a journal of
        // an earlier version, with another `at`); SyncClient sends it, nothing is left to write.
        .catch((e: unknown) =>
          (e as { code?: unknown } | null)?.code === "OPERATION_ID_REUSED"
            ? ({ kind: "acknowledged" } as const)
            : null,
        );
      if (w?.kind !== "acknowledged" && w?.kind !== "rejected") return next;
    }
    const { aborting: _, cancel: _c, ...rest } = next;
    next = await this.#save({ ...rest, state: end });
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
      // Journaled before J_X is revoked: once revoked it is listed no more, so only the
      // journal finishes `cancels[rid]` after a crash or a lost write.
      const f: ForeignCancel = {
        c: toHex(C),
        rid: pending.rid,
        j: toHex(pending.pairingDevice),
        at: iso(this.#now()),
      };
      await this.#d.localState().update(FOREIGN_CANCELS_KEY, (all) => ({
        ...((all ?? {}) as Record<string, ForeignCancel>),
        [f.rid]: f,
      }));
      return this.#finishForeign(f);
    });
  }

  async #foreign(): Promise<Readonly<Record<string, ForeignCancel>>> {
    return ((await this.#d.localState().get(FOREIGN_CANCELS_KEY)) ?? {}) as Record<
      string,
      ForeignCancel
    >;
  }

  /** Both phases of a foreign cancel, each again until done: J_X revoked, then `cancels[rid]`. */
  async #finishForeign(f: ForeignCancel): Promise<boolean> {
    const J = fromHexC(f.j) as unknown as PrincipalId;
    const I = await this.#d.identity();
    if (I === null) return false;
    if (!I.revoked(J)) {
      const r = await this.#d.flows
        .revokeDevice({
          ...this.#d.flow(),
          device: J,
          reason: 0n,
          operation: `revoke-pending.${f.rid}`,
        })
        .catch(() => null);
      if (r?.kind !== "revoked") return false;
    }
    const w = await (await this.#d.control(fromHexC(f.c)))
      ?.commit(
        [{ intent: "cancel.create", rid: f.rid, cancel: { reason: "user", at: f.at } }],
        `${f.rid}:cancel`,
      )
      .catch(() => null);
    if (w?.kind !== "acknowledged" && w?.kind !== "rejected") return false;
    await this.#d.localState().update(FOREIGN_CANCELS_KEY, (all) => {
      const { [f.rid]: _, ...rest } = (all ?? {}) as Record<string, ForeignCancel>;
      return rest;
    });
    return true;
  }
}

/** A principal of an approval record (hex), or undefined for a malformed one. */
export function approvedPrincipal(ref: string): string | undefined {
  const P = principalOfRef(ref);
  return P === undefined ? undefined : toHex(P);
}
