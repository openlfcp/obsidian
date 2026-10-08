// The 0.1 Task engine's view of a note in 0.4 (ADR 0001 §1): every line a
// shared section owns, valid or damaged, belongs to the section engine.
// Task refs inside a section look like ordinary lfcp-refs (decision M1
// keeps them on their child line); the Shared Objects engine processing
// them would send its intents to a section's Resource. So it scans the note
// as before and drops whatever lies in a section's claimed lines.

import { type ScanResult, scanRefs } from "../refs";
import { type LineRange, parseSections } from "../sections/parser";

const inside = (claimed: readonly LineRange[], line: number) =>
  claimed.some((r) => line >= r.from && line <= r.to);

/** scanRefs without the Tasks, refs and diagnostics inside shared sections. */
export function scanLegacy(markdown: string): ScanResult {
  const scan = scanRefs(markdown);
  // Cheap when the note has no section marker: nothing to claim.
  if (!markdown.includes("lfcp-section")) return scan;
  const { claimed } = parseSections(markdown);
  if (claimed.length === 0) return scan;
  return {
    projections: scan.projections.filter(
      (p) => !inside(claimed, p.taskLine) && !inside(claimed, p.refLine),
    ),
    diagnostics: scan.diagnostics.filter((d) => !inside(claimed, d.line)),
    tasks: scan.tasks.filter((t) => !inside(claimed, t.task.line)),
  };
}
