// What the editor shows of shared sections (LFCP-02-048, decision M5).
// Pure: from a note's text, the lines that only carry a section's bindings
// (hidden in Live Preview unless the user shows sharing metadata) and the
// lines of each section (its quiet boundary). Damaged sections hide
// nothing: their markers stay visible so the problem can be seen and fixed.

import { scanRefs } from "../refs/scanner";
import { parseNodeMarker } from "./grammar";
import { type LineRange, parseSections } from "./parser";

export interface SectionPresentation {
  /** 0-based lines that only carry bindings of a valid section, ascending. */
  readonly bindingLines: readonly number[];
  /** Each valid section, its heading through its end marker. */
  readonly sections: readonly LineRange[];
}

const EMPTY: SectionPresentation = { bindingLines: [], sections: [] };

export function sectionPresentation(markdown: string): SectionPresentation {
  if (!markdown.includes("lfcp-section")) return EMPTY;
  const { sections } = parseSections(markdown);
  if (sections.length === 0) return EMPTY;
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
  };
}
