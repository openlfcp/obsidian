// The vault's shared sections at a glance (LFCP-03-003, pane-ready): how
// many sections are current, need attention or are not known yet, the
// outbound queue and the edits held in notes, each counted on its own and
// never added up. An unknown count stays unknown (null). Pure.

import type { HeldCause } from "./held";
import type { StatusView } from "./reducer";

export interface VaultSyncSummary {
  readonly sections: number;
  /** Sections whose whole sync is current (StatusView.sync.current). */
  readonly current: number;
  readonly attention: number;
  /** The outbound queue over all sections: durable batches and their units waiting. */
  readonly queue: {
    readonly batches: number;
    /** Every waiting batch has a stable identity, so `batches` may be shown. */
    readonly counted: boolean;
    readonly units: number;
  };
  /** Edits held in notes over all sections, apart from the queue. */
  readonly held: {
    /** Sections with a copy holding edits; null while some note was not checked. */
    readonly sections: number | null;
    /** Copies holding edits; null while some note was not checked yet. */
    readonly projections: number | null;
    /** Edits held; null when some count is unknown. */
    readonly edits: number | null;
    readonly causes: readonly HeldCause[];
  };
  /** Sections some of whose notes were not checked for held edits yet. */
  readonly unchecked: number;
}

/** The summary of every section's view. */
export function vaultSyncSummary(views: Iterable<StatusView>): VaultSyncSummary {
  let sections = 0;
  let current = 0;
  let attention = 0;
  let batches = 0;
  let counted = true;
  let units = 0;
  let heldSections = 0;
  let projections: number | null = 0;
  let edits: number | null = 0;
  let unchecked = 0;
  const causes = new Set<HeldCause>();
  for (const v of views) {
    const s = v.sync;
    sections++;
    if (s.current) current++;
    if (v.state === "ATTENTION" || v.state === "LOCAL_SAVE_FAILED") attention++;
    batches += s.queue.batches;
    counted &&= s.queue.counted;
    units += s.queue.units;
    if (s.held.projections === null) unchecked++;
    if (s.held.projections !== null && s.held.projections > 0) heldSections++;
    projections =
      projections === null || s.held.projections === null ? null : projections + s.held.projections;
    edits = edits === null || s.held.edits === null ? null : edits + s.held.edits;
    for (const c of s.held.causes) causes.add(c);
  }
  return {
    sections,
    current,
    attention,
    queue: { batches, counted, units },
    held: {
      sections: unchecked > 0 ? null : heldSections,
      projections,
      edits,
      causes: [...causes],
    },
    unchecked,
  };
}
