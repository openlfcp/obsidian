// The executor's check before "Invite collaborator…" opens its role dialog
// (I4, LFCP-03-041): the pane's invite descriptor, on the section's facts.
// Right after a share or a start, the status pass and the access check may
// not have caught up yet: the check waits for them, a few seconds at most,
// and refuses only if inviting is still not offered. Offline it refuses at
// once: waiting would not check anything. Once the host stops (the plugin
// unloads) it gives up without a word: nothing is shown after unload. Pure:
// the host gives the reads.

import { INVITE_WAITS } from "../actions/descriptors";

/** How long a check waits for the status pass and the access check (ms). */
export const INVITE_CHECK_MS = 5000;
/** How often it reads again while it waits, at most (ms). */
export const INVITE_CHECK_STEP_MS = 250;
/**
 * The check's answer once the host stopped (the plugin unloads): no role
 * dialog and nothing said. Never shown.
 */
export const INVITE_STOPPED = "The sections host stopped.";

export interface InviteCheckSource {
  /** The keys of the sections with a status now (`<resource>#<sectionId>`). */
  readonly keys: () => Iterable<string>;
  /** The invite descriptor's reason for section `key` on its facts now, or null (offered). */
  readonly refusal: (key: string) => Promise<string | null>;
  /** Whether section `key` is offline (or its connection failed): no check would happen. */
  readonly offline: (key: string) => boolean;
  /** Asks for a status pass soon. */
  readonly refresh: () => void;
  /**
   * Resolves on the next status change, or after `ms`, or once `signal`
   * aborts; it lets go of its listener and its timer when it resolves.
   */
  readonly next: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** Whether the host stopped (the plugin unloads). */
  readonly stopped: () => boolean;
}

/** The section key of Resource `resource` (base64url) among `keys`, if any. */
export function sectionKeyOf(keys: Iterable<string>, resource: string): string | undefined {
  const prefix = `${resource}#`;
  for (const k of keys) if (k.startsWith(prefix)) return k;
  return undefined;
}

/** `read`'s answer, or `late` if it has none within `ms` (a read that never ends does not hold the check). */
async function within(
  src: InviteCheckSource,
  read: Promise<string | null>,
  ms: number,
  late: string,
): Promise<string | null> {
  const stop = new AbortController();
  const LATE = Symbol("late");
  const timeout = (async (): Promise<typeof LATE> => {
    const end = src.now() + ms;
    // A status change wakes `next` early: wait again until the time is up
    // (or the host stopped).
    for (let left = ms; left > 0 && !stop.signal.aborted && !src.stopped(); left = end - src.now())
      await src.next(left, stop.signal);
    return LATE;
  })();
  try {
    const out = await Promise.race([read, timeout]);
    return out === LATE ? late : out;
  } finally {
    stop.abort();
  }
}

/**
 * Why inviting to the section of `resource` (base64url) is not offered, or
 * null when it is. Waiting for the server's check is waited out, up to
 * `waitMs`; any other reason, and offline, is said at once. Once the host
 * stopped it answers INVITE_STOPPED.
 */
export async function inviteCheck(
  src: InviteCheckSource,
  resource: string,
  waitMs = INVITE_CHECK_MS,
): Promise<string | null> {
  const deadline = src.now() + waitMs;
  for (;;) {
    if (src.stopped()) return INVITE_STOPPED;
    const key = sectionKeyOf(src.keys(), resource);
    const reason =
      key === undefined
        ? INVITE_WAITS
        : // The read gets one step at least: a read at the deadline still counts.
          await within(
            src,
            src.refusal(key),
            Math.max(INVITE_CHECK_STEP_MS, deadline - src.now()),
            INVITE_WAITS,
          );
    if (src.stopped()) return INVITE_STOPPED;
    if (reason !== INVITE_WAITS) return reason;
    if (key !== undefined && src.offline(key)) return reason;
    const left = deadline - src.now();
    if (left <= 0) return reason;
    src.refresh();
    await src.next(Math.min(INVITE_CHECK_STEP_MS, left));
  }
}
