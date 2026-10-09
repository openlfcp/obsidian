// The statuses of every watched section, one at a time (D1): a section whose
// model throws when read (a poisoned replica) shows that it needs attention,
// and never stops the others' statuses, which would freeze their badges at
// their last state, CURRENT included. Pure.

import { type StatusView, statusView } from "./reducer";

/** One section's status: its key (Resource base64url # section ID) and view. */
export interface KeyedStatus {
  readonly key: string;
  readonly view: StatusView;
}

/** The view of a section whose model cannot be read: an invalid profile (ATTENTION). */
export function unreadableView(session: string): StatusView {
  return statusView({
    session,
    revision: 0,
    replica: "invalid-profile",
    access: "unknown",
    pendingControl: [],
    connection: "offline",
    catchUp: "unknown",
    problems: [],
    batches: [],
    acceptanceEvidence: "available",
    projections: [],
  });
}

/**
 * Each session's status from `one` (null: nothing to show yet). A session
 * whose `one` throws gets the unreadable view under the key it last had;
 * without one it is left out (its badge stays unknown, never CURRENT).
 * `keys` remembers each session's last key across calls.
 */
export async function collectStatuses(
  sessions: Iterable<string>,
  one: (session: string) => Promise<KeyedStatus | null>,
  keys: Map<string, string>,
): Promise<Map<string, StatusView>> {
  const out = new Map<string, StatusView>();
  for (const session of sessions) {
    let status: KeyedStatus | null;
    try {
      status = await one(session);
    } catch {
      const key = keys.get(session);
      if (key !== undefined) out.set(key, unreadableView(session));
      continue;
    }
    if (status === null) continue;
    keys.set(session, status.key);
    out.set(status.key, status.view);
  }
  return out;
}
