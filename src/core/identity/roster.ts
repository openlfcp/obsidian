// Listing a section in the person's roster (IDENTITY-PROFILE-01 §2,
// \`roster.put\`), for a section the first device creates or joins after
// it was paired (LFCP-04-413e item 3; status-414 «Найдено, не исправлено» 1,
// decision I17). A device that is not the first one lists its sections
// through the SDK's own flows (§7.2, §7.3); the root has no high-level SDK
// call for it in 0.3.0. The call lands in SDK 0.3.1 (LFCP-04-410d): until
// then this port answers "unsupported", and every such section waits in
// the device upkeep's queue, said as unfinished, never silently left out.

import type { RosterEntryValue } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";

/** What listing one section did. */
export type RosterAdd =
  | { readonly kind: "added" }
  /** The server could not be reached: tried again by the next upkeep. */
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "refused"; readonly code: string }
  /** No SDK call for it yet (SDK 0.3.0). */
  | { readonly kind: "unsupported" };

/** Writes roster entries in this installation's device list (the SDK's call, once it exists). */
export interface RosterWriter {
  add(resource: ResourceId, entry: RosterEntryValue): Promise<RosterAdd>;
}

/** SDK 0.3.0 has no call to add to the roster: everything waits. */
export const NO_ROSTER_WRITER: RosterWriter = Object.freeze({
  add: async (): Promise<RosterAdd> => ({ kind: "unsupported" }),
});
