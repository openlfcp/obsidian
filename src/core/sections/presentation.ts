// What the editor shows of shared sections (LFCP-02-048, decision M5).
// Pure: from a note's text, the lines that only carry a section's bindings
// (hidden in Live Preview unless the user shows sharing metadata) and the
// lines of each section (its quiet boundary). Damaged sections hide
// nothing: their markers stay visible so the problem can be seen and fixed,
// and only the line where each starts is named, never a range (LFCP-03-020).

import { scanRefs } from "../refs/scanner";
import { parseNodeMarker } from "./grammar";
import { type LineRange, parseSections } from "./parser";

export interface SectionPresentation {
  /** 0-based lines that only carry bindings of a valid section, ascending. */
  readonly bindingLines: readonly number[];
  /** Each valid section, its heading through its end marker. */
  readonly sections: readonly LineRange[];
  /**
   * The line of each damaged copy's boundary cue (LFCP-03-020): its heading,
   * else its start marker. Its extent is not known, so no line is marked as
   * inside it.
   */
  readonly damaged: readonly number[];
}

const EMPTY: SectionPresentation = { bindingLines: [], sections: [], damaged: [] };

export function sectionPresentation(markdown: string): SectionPresentation {
  if (!markdown.includes("lfcp-section")) return EMPTY;
  const scan = parseSections(markdown);
  const { sections } = scan;
  const damaged = scan.damaged.map((d) => d.heading?.line ?? d.startLine).sort((a, b) => a - b);
  if (sections.length === 0) return damaged.length === 0 ? EMPTY : { ...EMPTY, damaged };
  const lines = markdown.split(/\r\n|\n|\r/);
  const childRefLines = new Set(
    scanRefs(markdown)
      .projections.filter((p) => p.placement === "child")
      .map((p) => p.refLine),
  );
  const hidden: number[] = [];
  for (const s of sections) {
    hidden.push(s.startLine);
    for (let i = s.startLine + 1; i < s.endLine; i++)
      if (childRefLines.has(i) || parseNodeMarker(lines[i] ?? "")?.kind !== undefined)
        hidden.push(i);
    hidden.push(s.endLine);
  }
  return {
    bindingLines: hidden.sort((a, b) => a - b),
    sections: sections.map((s) => ({ from: s.heading.line, to: s.endLine })),
    damaged,
  };
}

/** A short cue at the end of a line (LFCP-03-020, UX §8): never in the note's text. */
export interface BoundaryCue {
  readonly line: number;
  readonly kind: "inside" | "outside" | "unknown";
}

export const BOUNDARY_CUE_TEXT: Readonly<Record<BoundaryCue["kind"], string>> = {
  inside: "Inside the shared section",
  outside: "Outside the shared section",
  unknown: "Section boundary not determined",
};

/**
 * Where a section visibly ends, and the cues to show (UX §8). `hidden`
 * holds the lines the editor hides; `cursor` is the line of an idle cursor
 * (null while typing, or with a selection). The end of a section is its
 * last visible line before the end marker. An idle cursor on that line is
 * inside it; on the line right after the end marker, outside it. A damaged
 * copy is named at its start, whatever the cursor: where it ends is unknown,
 * so no line after it is said to be inside.
 */
export function boundaryCues(
  model: SectionPresentation,
  hidden: ReadonlySet<number>,
  cursor: number | null,
  lineCount: number,
): { readonly ends: readonly number[]; readonly cues: readonly BoundaryCue[] } {
  const ends: number[] = [];
  const cues: BoundaryCue[] = [];
  for (const s of model.sections) {
    let end = s.to - 1;
    while (end > s.from && hidden.has(end)) end--;
    ends.push(end);
    if (cursor === end) cues.push({ line: end, kind: "inside" });
    else if (cursor === s.to + 1 && s.to + 1 < lineCount)
      cues.push({ line: s.to + 1, kind: "outside" });
  }
  for (const line of model.damaged) cues.push({ line, kind: "unknown" });
  return { ends, cues: cues.sort((a, b) => a.line - b.line) };
}
