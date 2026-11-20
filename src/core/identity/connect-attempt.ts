// "Connect Apple Reminders" (MVP 0.6 A§4.1, U П1; E-022d1): the attempt's
// states, its journal record, the link handed to LFCP Bridge, the
// callbacks it sends back, and what the settings show for each state.
// Pure: no Obsidian, no network (connect.ts drives it).

/** A§4.1 "Состояния попытки", and the two checks before one starts (A§5.2, U П1). */
export type AttemptState =
  /** The link is handed to LFCP Bridge; no request under J yet (local deadline 30 min). */
  | "waiting-app"
  /** A request signed by this attempt's J is in I: the human compares its code. */
  | "confirm-code"
  /** [Yes] given: phases A1–A4 (no cancel from here on, A§4.4). */
  | "committing"
  /** Approved and registered; waiting for the bridge's first write in C. */
  | "registering"
  | "ready"
  // Final, before the consume: J revoked, I rotated, C archived.
  | "rejected"
  | "cancelled"
  | "expired"
  | "already-connected"
  | "other-account"
  // Final, nothing started.
  | "insufficient-authority"
  | "capacity"
  /** Stopped with a message (e.g. the server refused a step after [Yes]). */
  | "failed";

/** States before the consume: [Cancel], the deadline and the bridge's refusals apply. */
export const BEFORE_CONSUME: ReadonlySet<AttemptState> = new Set(["waiting-app", "confirm-code"]);
/** States still under way (anything else is final). */
export const ACTIVE: ReadonlySet<AttemptState> = new Set([
  "waiting-app",
  "confirm-code",
  "committing",
  "registering",
]);

/** A§4.1: the local cleanup deadline of an attempt before the consume (the server applies none). */
export const ATTEMPT_DEADLINE_MS = 30 * 60_000;

/** A§4.1 step 1: the attempt's journal record (no secret: the link is derived again from J). */
export interface Attempt {
  /** `meta.attemptId` of C, also the origin of its base approval (A3). */
  readonly id: string;
  /** `meta.createdAt` of C: the initial change repeats it (§2.2). */
  readonly metaAt: string;
  readonly vault: string;
  /** Hex: the root, C, J; the pairing session's operation. */
  readonly root: string;
  readonly c: string;
  readonly url: string;
  readonly j?: string;
  readonly session?: string;
  readonly createdAt: number;
  readonly state: AttemptState;
  /** C's initial change (§2.2) is committed. */
  readonly initialized?: boolean;
  /** The approval's operation, once A1 has run (resumed after a restart). */
  readonly approval?: string;
  /**
   * A cancel to finish (J not revoked yet, or C not archived): the final
   * state it leads to. While set, nothing is approved and no request is
   * offered (review r1, 4): only the cancel goes on, or a consume found.
   */
  readonly aborting?: AttemptState;
  /** [No]'s request key, deleted with the cancel, again on a retry. */
  readonly reject?: string;
  /**
   * The request the person compared and said [Yes] to (review r1, 1): after
   * a restart only this one is approved, never another under J.
   */
  readonly confirmed?: { readonly requestKey: string; readonly fingerprint: string };
  /**
   * The pairing sessions already open before this attempt made J (review r1,
   * 3): a session open now and not among them is J, found again after a
   * crash between its creation and the journal.
   */
  readonly sessionsBefore?: readonly string[];
  /**
   * Set while "Add my other device…" runs and this attempt has no J yet (review r3): the
   * sessions made since are personal, recorded in `sessionsBefore`, never taken for J,
   * also after a crash that left this set.
   */
  readonly othersSince?: number;
  readonly message?: string;
}

/** The callback events LFCP Bridge sends to `obsidian://openlfcp-bridge` (A§4.1; E-031). */
export type CallbackEvent = "request-ready" | "app-ready" | "already-connected" | "other-account";

export interface Callback {
  readonly event: CallbackEvent;
  readonly attempt?: string;
  readonly vault?: string;
}

const EVENTS: ReadonlySet<string> = new Set([
  "request-ready",
  "app-ready",
  "already-connected",
  "other-account",
]);

/**
 * The callback's parameters (Obsidian hands them as a record), or null for
 * an unknown event. It is unauthenticated (A§4.2): never more than a hint.
 */
export function parseCallback(p: Readonly<Record<string, string | undefined>>): Callback | null {
  const event = p.event;
  if (event === undefined || !EVENTS.has(event)) return null;
  return {
    event: event as CallbackEvent,
    ...(p.attempt === undefined ? {} : { attempt: p.attempt }),
    ...(p.vault === undefined ? {} : { vault: p.vault }),
  };
}

/**
 * A§4.1 step 2: `lfcp-bridge://connect?attempt&vault&c&root&j#link=<pairing link>`.
 * The pairing link (the secret) is in the fragment only; the other fields
 * are hex identifiers, never secrets.
 */
export function bridgeLink(a: Attempt, pairingLink: string): string {
  const q = new URLSearchParams({
    attempt: a.id,
    vault: a.vault,
    c: a.c,
    root: a.root,
    j: a.j ?? "",
  });
  return `lfcp-bridge://connect?${q.toString()}#link=${encodeURIComponent(pairingLink)}`;
}

/** What the person can do in a state (U П1). */
export type ConnectAction =
  | "connect"
  | "download"
  | "open-again"
  | "cancel"
  | "other-ways"
  | "copy-link"
  | "yes"
  | "no"
  | "open-devices"
  | "show-it"
  /** U П1 "connected": [Disconnect…] (A§6.3, E-024). */
  | "disconnect";

export interface ConnectView {
  readonly lines: readonly string[];
  /** Shown big in the code comparison. */
  readonly code?: string;
  readonly actions: readonly ConnectAction[];
}

/**
 * The texts of U П1 for a state; `offline` while the server cannot be reached
 * (after [Yes], or when the link for LFCP Bridge could not be made: retried).
 */
export function connectView(
  a: Pick<Attempt, "state" | "message" | "aborting"> | undefined,
  o: { readonly code?: string; readonly offline?: boolean } = {},
): ConnectView {
  // A cancel under way offers nothing more, [Yes] least of all (review r1, 4).
  if (a?.aborting !== undefined) return { lines: ["Cancelling the connection…"], actions: [] };
  switch (a?.state) {
    case undefined:
      return {
        lines: ["Sync shared tasks with Apple Reminders on your Mac."],
        actions: ["connect"],
      };
    case "waiting-app":
      return {
        lines: [
          "Waiting for LFCP Bridge…",
          "If it isn't installed yet: download it, open it, and come back — we'll continue automatically.",
          ...(o.offline === true ? [OFFLINE_LINK] : []),
        ],
        actions: ["download", "open-again", "cancel", "other-ways", "copy-link"],
      };
    case "confirm-code":
      return {
        lines: [
          "Does your Mac show the same code?",
          "While connecting, the Mac can see the sections you turn on and the list of your devices.",
        ],
        ...(o.code === undefined ? {} : { code: o.code }),
        actions: ["no", "yes"],
      };
    // A§4.4: no cancel after [Yes]; changing one's mind is Disconnect once it is done.
    case "committing":
    case "registering":
      return {
        lines: [
          "Finishing connection…",
          ...(o.offline === true
            ? ["Still trying to reach the server — this can take a while."]
            : []),
          "(Changed your mind? Disconnect after it finishes.)",
        ],
        actions: [],
      };
    case "ready":
      return { lines: ["Connected."], actions: ["disconnect"] };
    case "rejected":
    case "cancelled":
    case "expired":
      return { lines: ["Connection cancelled. Nothing was changed."], actions: ["connect"] };
    case "already-connected":
      return { lines: ["This Mac is already connected."], actions: ["show-it"] };
    case "other-account":
      return {
        lines: [
          "This Mac is connected to another account. On that Mac, choose LFCP Bridge menu → Disconnect from Obsidian…, then try again.",
        ],
        actions: [],
      };
    case "insufficient-authority":
      return {
        lines: ["Connect from a computer where you manage devices for your account."],
        actions: [],
      };
    case "capacity":
      return {
        lines: ["Your account has too many connected devices. Remove an old one first."],
        actions: ["open-devices"],
      };
    case "failed":
      return {
        lines: [`The connection didn't finish: ${a.message ?? "something went wrong"}`],
        actions: ["connect"],
      };
  }
}

/** The link for LFCP Bridge could not be made (the server is not reached): tried again. */
export const OFFLINE_LINK = "Can't reach the server right now — trying again.";

/** [Copy link] done: where the link goes (U П1, "another device"). */
export const LINK_COPIED =
  "Shared Tasks: link copied. Send it to your Mac, then choose LFCP Bridge menu → Paste connection link.";

/** [Copy link] failed: the clipboard refused it (the link is never shown). */
export const COPY_FAILED =
  "Shared Tasks: the link could not be copied. Allow Obsidian to use the clipboard, then try Copy link again.";

/** The steps of the "another device" path (U П1, mockups/plugin.md §1). */
export const OTHER_DEVICE_STEPS = [
  "1. Copy this link and send it to your Mac.",
  "2. On the Mac: LFCP Bridge menu → Paste connection link.",
  "3. Compare the code — we'll show it here when the Mac is ready.",
] as const;
