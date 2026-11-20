// "Connect Apple Reminders" (MVP 0.6 A§4.1–4.4; E-022d1): one attempt at a
// time, journaled in local state. A new control Resource C, a pairing
// session J, the link handed to LFCP Bridge; the request under J found in
// I and its code compared by the person; [Yes] approves the bridge's base
// installation with its record in C (phases A1–A4, DeviceService.approve);
// before the consume, [No], [Cancel], the deadline or the bridge's refusal
// revoke J (I rotated by the SDK) and archive C in the roster. Callbacks
// are unauthenticated hints (A§4.2): they only make the attempt look again.

import {
  fetchDeks,
  genesisOwner,
  type IdentityFlowOptions,
  loadControlChain,
  loadIdentityDocument,
  mayManageDevices,
  OperationJournal,
  type PairingLinkText,
  type PairingReview,
  resourceRef,
  runUnitPhase,
  sealIdentityUnit,
  syncChain,
} from "@openlfcp/client";
import { bytesEqual, fromHex, type ResourceId, toHex } from "@openlfcp/core";
import { hasAbility } from "@openlfcp/wire";
import {
  ACTIVE,
  ATTEMPT_DEADLINE_MS,
  type Attempt,
  type AttemptState,
  BEFORE_CONSUME,
  bridgeLink,
  type Callback,
} from "./connect-attempt";
import type { IdentityFlows } from "./flows";
import type { ApprovalView } from "./pairing-view";
import type { DeviceRuntime } from "./service";

/** Local state: the current attempt (Attempt). */
export const ATTEMPT_KEY = "reminders-connect";

export interface ConnectDeps {
  readonly flows: IdentityFlows;
  readonly flow: () => IdentityFlowOptions;
  readonly runtime: () => DeviceRuntime;
  readonly defaultServer: () => string;
  readonly identity: () => Promise<ResourceId | undefined>;
  /** The device list, created on first use (DeviceService.startSession's first step); a message if not. */
  readonly ensureIdentity: () => Promise<string | null>;
  readonly approve: (review: PairingReview, C: ResourceId, origin: string) => Promise<ApprovalView>;
  readonly finishApproval: (operation: string, label: string) => Promise<ApprovalView>;
}

/** A§5.2: the device list must keep room for the bridge, J and one spare. */
export const ROOM_NEEDED = 3;
/** W §17.4 rule 8: live Principals bound to a root in one Resource. */
export const MAX_LIVE_BOUND = 32;

export class BridgeConnect {
  readonly #d: ConnectDeps;
  /** Not journaled (secrets, or re-read from I): the link and the request under review. */
  #link: PairingLinkText | null = null;
  #review: PairingReview | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ConnectDeps) {
    this.#d = deps;
  }

  /** One step at a time: the settings, the callbacks and the timer all come here. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async attempt(): Promise<Attempt | undefined> {
    return (await this.#d.runtime().localState.get(ATTEMPT_KEY)) as Attempt | undefined;
  }

  async #save(a: Attempt): Promise<Attempt> {
    await this.#d.runtime().localState.put(ATTEMPT_KEY, a);
    return a;
  }

  /** The code of the request under review (confirm-code). */
  code(): string | undefined {
    return this.#review?.fingerprint;
  }

  /** [Connect Apple Reminders]: a new attempt, unless one is under way. */
  start(vault: string, mac = "Mac"): Promise<Attempt> {
    return this.#serial(async () => {
      const current = await this.attempt();
      if (current !== undefined && ACTIVE.has(current.state)) return current;
      this.#link = null;
      this.#review = null;
      const blank = { id: "", metaAt: "", vault, root: "", c: "", url: "", createdAt: this.#now() };
      const failed = await this.#d.ensureIdentity();
      if (failed !== null) return this.#save({ ...blank, state: "failed", message: failed });
      const I = await this.#d.identity();
      const flow = this.#d.flow();
      const chain = I === undefined ? undefined : await loadControlChain(flow.storage, I);
      if (chain?.kind !== "linear")
        return this.#save({
          ...blank,
          state: "failed",
          message: "your device list could not be read",
        });
      // A§4.1: 12 and 13 (a Full device or the root); A§5.2: live(I) + 2 + 1 ≤ 32.
      const me = flow.installation.signer.descriptor.principalId;
      const root = chain.state.owner.principalId;
      const isRoot = bytesEqual(me, root);
      if (!isRoot && !(mayManageDevices(chain.state, me, root) && hasAbility(chain.state, me, 13n)))
        return this.#save({ ...blank, state: "insufficient-authority" });
      if ((chain.state.liveBound.get(toHex(root)) ?? 0) + ROOM_NEEDED > MAX_LIVE_BOUND)
        return this.#save({ ...blank, state: "capacity" });
      // A§4.1 step 1: a new C (+ roster), then J, then the journal.
      const url = this.#d.defaultServer().trim();
      const created = await this.#d.flows.createServiceControl({ ...flow, url, mac });
      if (created.kind !== "created")
        return this.#save({ ...blank, state: "failed", message: describe(created) });
      const a: Attempt = {
        id: created.initialize.attemptId,
        metaAt: created.initialize.createdAt,
        vault,
        root: toHex(root),
        c: toHex(created.resource),
        url,
        createdAt: this.#now(),
        state: "waiting-app",
      };
      // Journaled before J exists: a crash after the SDK made it finds it again (#recoverSession).
      const sessionsBefore = (await this.#d.flows.openPairingSessions(flow)).map((s) => s.session);
      const made = await this.#ensureSession(await this.#save({ ...a, sessionsBefore }));
      return BEFORE_CONSUME.has(made.state) ? this.#save(await this.#initialize(made)) : made;
    });
  }

  /**
   * J of this attempt: a session made after `sessionsBefore` and still open
   * (review r1, 3), found again in the SDK's journal after a crash, or made
   * now. Unchanged while the server cannot be reached; final when J cannot
   * be made (limit → capacity).
   */
  async #ensureSession(a: Attempt): Promise<Attempt> {
    const found = await this.#recoverSession(a);
    if (found.session !== undefined)
      return this.#link === null ? this.#resumeSession(found) : found;
    const session = await this.#d.flows.createPairingSession(this.#d.flow());
    if (session.kind === "created") {
      this.#link = session.link;
      return this.#save({ ...found, session: session.session, j: toHex(session.pairingDevice) });
    }
    // Begun but not finished: the session is in the journal, the next tick resumes it
    // (#resumeSession, arbiter round 3, 2).
    if (session.kind === "unavailable") return this.#recoverSession(found);
    return this.#abort(
      found,
      session.kind === "limit" ? "capacity" : "failed",
      undefined,
      describe(session),
    );
  }

  /**
   * J's creation carried on (resumePairingSession: J registered in I, its keys
   * delivered) until the link is known here: after a restart, or after a
   * creation the server did not finish. Unchanged while unreachable; a
   * refusal ends the attempt as a creation's does.
   */
  async #resumeSession(a: Attempt): Promise<Attempt> {
    if (a.session === undefined) return a;
    const r = await this.#d.flows.resumePairingSession(this.#d.flow(), a.session);
    if (r.kind === "created") {
      this.#link = r.link;
      return a;
    }
    if (r.kind === "unavailable" || r.kind === "conflict") return a;
    return this.#abort(a, r.kind === "limit" ? "capacity" : "failed", undefined, describe(r));
  }

  /**
   * "Add my other device…" (DeviceService.startSession) runs in this queue, so it never
   * makes a session between `sessionsBefore` and J, with the attempt's J found again
   * first: `work` gets the session to leave out (arbiter round 3, 1).
   */
  otherDevice<T>(work: (reserved: string | undefined) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const stored = await this.attempt();
      if (stored === undefined || !ACTIVE.has(stored.state)) return work(undefined);
      return work((await this.#recoverSession(stored)).session);
    });
  }

  /** The attempt with its J from the SDK's journal, if a session was made for it. */
  async #recoverSession(a: Attempt): Promise<Attempt> {
    if (a.session !== undefined || a.sessionsBefore === undefined) return a;
    const before = new Set(a.sessionsBefore);
    const mine = (await this.#d.flows.openPairingSessions(this.#d.flow())).find(
      (s) => !before.has(s.session),
    );
    if (mine === undefined) return a;
    return this.#save({ ...a, session: mine.session, j: toHex(mine.pairingDevice) });
  }

  /** The link for LFCP Bridge (open on this Mac, or Copy link), while the attempt waits. */
  link(): Promise<string | null> {
    return this.#serial(async () => {
      const stored = await this.attempt();
      if (
        stored === undefined ||
        !BEFORE_CONSUME.has(stored.state) ||
        stored.aborting !== undefined
      )
        return null;
      const a = await this.#recoverSession(stored);
      if (a.session === undefined) return null;
      if (this.#link === null) {
        const r = await this.#d.flows.resumePairingSession(this.#d.flow(), a.session);
        if (r.kind !== "created") return null;
        this.#link = r.link;
      }
      return bridgeLink(a, this.#link.reveal());
    });
  }

  /**
   * `obsidian://openlfcp-bridge?…` (A§4.1): an unauthenticated hint for this
   * vault's current attempt only. `reopen`: open the link again (app-ready).
   * already-connected / other-account only end the attempt before the
   * consume, the safe way (J revoked, C archived): nothing is approved.
   */
  callback(c: Callback): Promise<{ readonly reopen: boolean }> {
    return this.#serial(async () => {
      const a = await this.attempt();
      if (a === undefined || c.attempt !== a.id || c.vault !== a.vault || !ACTIVE.has(a.state))
        return { reopen: false };
      if (a.aborting !== undefined) return { reopen: false };
      if (c.event === "app-ready") return { reopen: a.state === "waiting-app" };
      if (c.event === "request-ready") await this.#look(a);
      else if (BEFORE_CONSUME.has(a.state)) await this.#abort(a, c.event);
      return { reopen: false };
    });
  }

  /** [Yes, it matches] / [No]. */
  confirm(matches: boolean): Promise<Attempt | undefined> {
    return this.#serial(async () => {
      const a = await this.attempt();
      // A cancel under way: no new approval (review r1, 4).
      if (a?.state !== "confirm-code" || a.aborting !== undefined || this.#review === null)
        return a;
      const review = this.#review;
      if (!matches) return this.#abort(a, "rejected", review.requestKey);
      // The request the person said [Yes] to, journaled with the state (review r1, 1).
      return this.#advance(
        await this.#save({
          ...a,
          state: "committing",
          confirmed: { requestKey: review.requestKey, fingerprint: review.fingerprint },
        }),
      );
    });
  }

  /** [Cancel]: before the consume only (A§4.4: none after [Yes]); false when not possible. */
  cancel(): Promise<boolean> {
    return this.#serial(async () => {
      const a = await this.attempt();
      if (a === undefined || !BEFORE_CONSUME.has(a.state)) return false;
      await this.#abort(a, "cancelled");
      return true;
    });
  }

  /**
   * The periodic step: the deadline before the consume; a request under J
   * looked for; an unfinished cancel finished; [Yes] carried through A1–A4
   * (after a restart too) and `ready` read from C.
   */
  tick(): Promise<Attempt | undefined> {
    return this.#serial(async () => {
      const a = await this.attempt();
      if (a === undefined) return undefined;
      if (a.aborting !== undefined) return this.#abort(a, a.aborting, a.reject, a.message);
      if (!ACTIVE.has(a.state)) return a;
      if (BEFORE_CONSUME.has(a.state) && this.#now() - a.createdAt > ATTEMPT_DEADLINE_MS)
        return this.#abort(a, "expired");
      if (BEFORE_CONSUME.has(a.state))
        return this.#look(await this.#save(await this.#initialize(await this.#ensureSession(a))));
      return this.#advance(a);
    });
  }

  #now(): number {
    return this.#d.flow().now();
  }

  /** C's initial change (§2.2), committed once C is synchronised here; tried again on each tick. */
  async #initialize(a: Attempt): Promise<Attempt> {
    if (a.initialized === true) return a;
    const runtime = this.#d.runtime();
    const C = fromHex(a.c) as ResourceId;
    await runtime.openControl?.(C, a.url);
    const port = runtime.controlPort?.(C);
    if (port === undefined) return a;
    // Not state(): C reads as unusable until this very change. Its session must be live
    // to write (SyncClient refuses before then, e.g. key-unavailable): a later tick.
    const r = await port
      .commit(
        [{ intent: "initialize", attemptId: a.id, createdAt: a.metaAt }],
        `${a.id}:initialize`,
      )
      .catch(() => null);
    return r === null || r.kind === "rejected" ? a : { ...a, initialized: true };
  }

  /** A§4.1 step 5: the request signed by this attempt's J, of a service, with scope exactly [C]. */
  async #look(a: Attempt): Promise<Attempt> {
    if (!BEFORE_CONSUME.has(a.state) || a.aborting !== undefined) return a;
    const ours = await this.#requests(a);
    if (ours === null) return a;
    // Two requests under one J: the link went to someone else too; nothing is offered.
    if (ours.length > 1) return this.#abort(a, "cancelled");
    const review = ours[0];
    if (review === undefined) return a;
    this.#review = review;
    return a.state === "confirm-code" ? a : this.#save({ ...a, state: "confirm-code" });
  }

  /** [Yes]: A1–A4 through DeviceService (A3 needs C initialized first), then `ready` from C. */
  async #advance(a: Attempt): Promise<Attempt> {
    if (a.state === "registering") {
      // The port reads C's whole state (ServiceControlValidation); `service` is the bridge's.
      const state = this.#d
        .runtime()
        .controlPort?.(fromHex(a.c) as ResourceId)
        ?.state() as { readonly service?: unknown } | undefined;
      // A§4.1 step 6: the bridge completes its pairing and writes C as `service`.
      return state?.service === undefined ? a : this.#save({ ...a, state: "ready" });
    }
    if (a.state !== "committing") return a;
    let ready = await this.#save(await this.#initialize(a));
    if (ready.initialized !== true) return ready;
    // An approval the SDK journaled for J (A1 may have run before a crash, review r1, 2).
    const approval = ready.approval ?? (await this.#journaledApproval(ready));
    let view: ApprovalView;
    if (approval !== undefined) {
      if (ready.approval === undefined) ready = await this.#save({ ...ready, approval });
      view = await this.#d.finishApproval(approval, "LFCP Bridge");
    } else {
      const review = await this.#confirmedReview(ready);
      // Not readable now: still committing, [Yes] kept; a later tick.
      if (review === null) return ready;
      // The request said [Yes] to is gone before any consume: compare a code again.
      if (review === undefined) {
        const { confirmed: _, ...rest } = ready;
        return this.#look(await this.#save({ ...rest, state: "waiting-app" }));
      }
      view = await this.#d.approve(review, fromHex(ready.c) as ResourceId, ready.id);
    }
    switch (view.kind) {
      case "done":
        return this.#save({ ...ready, state: "registering" });
      case "finish":
        return this.#save({ ...ready, approval: view.operation });
      case "reconfirm": {
        this.#review = view.review ?? null;
        const { confirmed: _, ...rest } = ready;
        return this.#save({
          ...rest,
          state: this.#review === null ? "waiting-app" : "confirm-code",
        });
      }
      case "stop":
        return this.#save({ ...ready, state: "failed", message: view.message });
    }
  }

  /** The requests under J of a service with scope exactly [C]; null when not readable now. */
  async #requests(a: Attempt): Promise<readonly PairingReview[] | null> {
    if (a.session === undefined) return null;
    const all = await this.#d.flows
      .pairingRequests({ ...this.#d.flow(), session: a.session })
      .catch(() => null);
    if (all === null) return null;
    return all.filter(
      (r) =>
        r.kind === 1 &&
        r.requestedScope.length === 1 &&
        toHex(r.requestedScope[0] as ResourceId) === a.c,
    );
  }

  /**
   * The request the person said [Yes] to, by its key and code (review r1,
   * 1): the one in memory, or read again after a restart; never another
   * request under J. Undefined when it is no longer there; null when the
   * requests cannot be read now (arbiter round 3, 3: not a reason to drop [Yes]).
   */
  async #confirmedReview(a: Attempt): Promise<PairingReview | undefined | null> {
    const c = a.confirmed;
    if (c === undefined) return undefined;
    const same = (r: PairingReview) =>
      r.requestKey === c.requestKey && r.fingerprint === c.fingerprint;
    if (this.#review !== null && same(this.#review)) return this.#review;
    const all = await this.#requests(a);
    if (all === null) return null;
    const r = all.find(same);
    if (r !== undefined) this.#review = r;
    return r;
  }

  /** The SDK's approval of this attempt's J, journaled at its start (before A1). */
  async #journaledApproval(a: Attempt): Promise<string | undefined> {
    if (a.session === undefined) return undefined;
    const ops = await new OperationJournal(this.#d.flow().storage).list({
      kind: "pairing-approval",
    });
    return ops.find(
      (op) =>
        op.status !== "superseded" &&
        op.status !== "abandoned" &&
        op.intent.requestKey === a.confirmed?.requestKey &&
        ownApproval(a, op.intent),
    )?.id;
  }

  /**
   * Before the consume (A§4.1): J revoked (reason 0) and I rotated by the
   * SDK, C archived; journaled first, so a crash or the network finishes it
   * on a later tick. A cancel that finds J consumed is the approval's:
   * the attempt goes on as `committing` (A§4.4).
   */
  async #abort(a: Attempt, to: AttemptState, reject?: string, message?: string): Promise<Attempt> {
    // J made but not journaled yet (a crash, review r1, 3) is revoked too.
    let next = await this.#recoverSession(
      await this.#save({
        ...a,
        aborting: to,
        ...(reject === undefined ? {} : { reject }),
        ...(message === undefined ? {} : { message }),
      }),
    );
    if (next.session !== undefined) {
      const r = await this.#d.flows
        .cancelPairing({
          ...this.#d.flow(),
          session: next.session,
          ...(reject === undefined ? {} : { reject }),
        })
        .catch(() => ({ kind: "unavailable" }) as const);
      // J consumed by this attempt's own approval (kind 1, scope exactly [C], its record in C):
      // that approval goes on (A§4.4). Consumed by anything else (a personal device's approval
      // through J, arbiter round 3, 1): J is spent, the attempt ends below and C is archived.
      const own =
        r.kind === "consumed" &&
        r.operation !== undefined &&
        ownApproval(
          next,
          (await new OperationJournal(this.#d.flow().storage).get(r.operation))?.intent,
        );
      if (own && r.kind === "consumed" && r.operation !== undefined) {
        const { aborting: _, reject: _r, ...rest } = next;
        return this.#save({ ...rest, state: "committing", approval: r.operation });
      }
      if (r.kind !== "cancelled" && r.kind !== "document-incomplete" && r.kind !== "consumed")
        return next;
    }
    if (!(await this.#archive(next))) return next;
    this.#link = null;
    this.#review = null;
    const { aborting: _, reject: _r, ...rest } = next;
    next = await this.#save({ ...rest, state: to });
    return next;
  }

  /**
   * A§4.1: the attempt's C archived in the roster (`roster.put` with
   * `archived: true`, IDENTITY §4 rule 6: it revokes nothing); done once the
   * entry is archived, by this device or another. As the SDK's
   * writeRosterEntry, its own unit phase (sdk-ts 0.7.x may take it over).
   */
  async #archive(a: Attempt): Promise<boolean> {
    const I = await this.#d.identity();
    if (I === undefined || a.c === "") return true;
    const o = this.#d.flow();
    const ref = resourceRef(fromHex(a.c) as ResourceId);
    const journal = new OperationJournal(o.storage);
    const operation = `archive-control.${a.id}`;
    if ((await journal.get(operation)) === undefined)
      await journal.begin({
        id: operation,
        kind: "add-to-roster",
        createdAt: o.now(),
        intent: { identity: toHex(I), resource: a.c, archive: true },
      });
    try {
      const stored = await loadControlChain(o.storage, I);
      const url = stored?.kind === "linear" ? stored.state.route.coordinatorUrl : a.url;
      const channel = await o.network.connect(o.installation.signer, url);
      try {
        const open = async () => {
          const chain = await syncChain(o.storage, channel, I);
          const doc = o.document(I, genesisOwner(chain));
          const deks = await fetchDeks(o.storage, o.secrets, channel, chain, o.installation);
          const load = await loadIdentityDocument({ channel, chain, deks, doc });
          return { chain, doc, deks, load };
        };
        const r = await runUnitPhase(channel, journal, operation, {
          id: "archive",
          resource: I,
          rebuildOn: ["STALE_DATA_EPOCH"],
          rebuildRefused: true,
          build: async () => {
            const { chain, doc, deks, load } = await open();
            const entry = doc.roster().get(ref);
            if (entry === undefined || entry.archived === true) return null;
            return sealIdentityUnit({
              storage: o.storage,
              chain,
              deks,
              signer: o.installation.signer,
              doc,
              latest: load.latest,
              intents: [{ intent: "roster.put", key: ref, entry: { ...entry, archived: true } }],
            });
          },
        });
        if (r.state === "refused") return false;
        await journal.setStatus(operation, "done");
        return true;
      } finally {
        channel.close();
      }
    } catch {
      // Not reached: a later tick finishes it (the attempt keeps `aborting`).
      return false;
    }
  }
}

/** A result kind in words, for `failed` (never a secret). */
function describe(r: {
  readonly kind: string;
  readonly reason?: string;
  readonly code?: string;
}): string {
  return r.reason ?? r.code ?? r.kind;
}

/**
 * Whether a journaled `pairing-approval` intent approves this attempt's bridge: under its J,
 * of kind 1 with scope exactly [C], with its approval record in C (A3).
 */
function ownApproval(a: Attempt, intent: Readonly<Record<string, unknown>> | undefined): boolean {
  if (intent === undefined || intent.session !== a.session) return false;
  const payload = intent.payload as
    | { readonly kind?: unknown; readonly scope?: unknown }
    | undefined;
  const record = intent.approvalRecord as { readonly resource?: unknown } | undefined;
  const scope: readonly unknown[] = Array.isArray(payload?.scope)
    ? (payload.scope as unknown[])
    : [];
  return payload?.kind === 1 && scope.length === 1 && scope[0] === a.c && record?.resource === a.c;
}
