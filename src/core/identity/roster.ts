// Listing a section in the person's roster (IDENTITY-PROFILE-01 §2,
// `roster.put`), for a section the first device creates or joins after
// it was paired (LFCP-04-413e item 3; status-414 «Найдено, не исправлено» 1,
// decision I17). A device that is not the first one lists its sections
// through the SDK's own flows (§7.2, §7.3). The rule (SDK 0.3.1): whoever
// creates or accepts a Resource after the device list exists adds it to the
// roster; reconciliation adds none. The device flows write it with the
// SDK's addToRoster (DeviceService); this port lets tests stand in for it.

import type { RosterEntryValue } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";

/** What listing one section did. */
export type RosterAdd =
  | { readonly kind: "added" }
  /** The server could not be reached: tried again by the next upkeep. */
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "refused"; readonly code: string }
  /** No call for it in the SDK in use. */
  | { readonly kind: "unsupported" };

/** Writes roster entries in this installation's device list (the SDK's call, once it exists). */
export interface RosterWriter {
  add(resource: ResourceId, entry: RosterEntryValue): Promise<RosterAdd>;
}
