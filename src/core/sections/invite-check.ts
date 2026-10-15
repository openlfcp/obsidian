// The executor's check before "Invite collaborator…" opens its role dialog
// (I4, LFCP-03-041): the pane's invite descriptor, on the section's facts.
// Right after a share or a start, the status pass and the access check may
// not have caught up yet: the check waits for them, a few seconds at most,
// and refuses only if inviting is still not offered. Offline it refuses at
// once: waiting would not check anything. Pure: the host gives the reads.

import { INVITE_WAITS } from "../actions/descriptors";

/** How long a check waits for the status pass and the access check (ms). */
export const INVITE_CHECK_MS = 5000;
/** How often it reads again while it waits, at most (ms). */
export const INVITE_CHECK_STEP_MS = 250;

export interface InviteCheckSource {
  /** The keys of the sections with a status now (`<resource>#<sectionId>`). */
  readonly keys: () => Iterable<string>;
  /** The invite descriptor's reason for section `key` on its facts now, or null (offered). */
  readonly refusal: (key: string) => Promise<string | null>;
  /** Whether section `key` is offline (or its connection failed): no check would happen. */
  readonly offline: (key: string) => boolean;
  /** Asks for a status pass soon. */
  readonly refresh: () => void;
  /** Resolves on the next status change, or after `ms`. */
  readonly next: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** The section key of Resource `resource` (base64url) among `keys`, if any. */
export function sectionKeyOf(keys: Iterable<string>, resource: string): string | undefined {
  const prefix = `${resource}#`;
  for (const k of keys) if (k.startsWith(prefix)) return k;
  return undefined;
}

/**
 * Why inviting to the section of `resource` (base64url) is not offered, or
 * null when it is. Waiting for the server's check is waited out, up to
 * `waitMs`; any other reason, and offline, is said at once.
 */
export async function inviteCheck(
  src: InviteCheckSource,
  resource: string,
  waitMs = INVITE_CHECK_MS,
): Promise<string | null> {
  const deadline = src.now() + waitMs;
  for (;;) {
    const key = sectionKeyOf(src.keys(), resource);
    const reason = key === undefined ? INVITE_WAITS : await src.refusal(key);
    if (reason !== INVITE_WAITS) return reason;
    if (key !== undefined && src.offline(key)) return reason;
    const left = deadline - src.now();
    if (left <= 0) return reason;
    src.refresh();
    await src.next(Math.min(INVITE_CHECK_STEP_MS, left));
  }
}
