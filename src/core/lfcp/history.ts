// LFCP-02-117: how large a section's history is, as the Snapshot limits of
// SHARED-OBJECTS-PROFILE-01 §13.1 count it: the value count of the largest
// column of its save, where every character ever inserted is a row. Past
// the floor (262,144) another device may refuse its Snapshot and catch up
// from the changes instead; the card suggests a new section before that.

import {
  checkSnapshotExpansion,
  SNAPSHOT_LIMITS_FLOOR,
  type SnapshotLimits,
} from "@openlfcp/shared-objects";

// Typed as the floor's own values; a receiver MAY configure higher (§13.1).
const MEASURE = Object.freeze({
  ...SNAPSHOT_LIMITS_FLOOR,
  maxRows: Number.MAX_SAFE_INTEGER,
  maxGroupSum: Number.MAX_SAFE_INTEGER,
  maxStringBytes: Number.MAX_SAFE_INTEGER,
  maxInflatedBytes: Number.MAX_SAFE_INTEGER,
}) as unknown as SnapshotLimits;

/** The largest column's value count of a document save (§13.1), measured, never refused. */
export function historyRows(save: Uint8Array): number {
  return checkSnapshotExpansion(save, MEASURE).maxRows;
}
