// Copying shared sections (LFCP-02-063, OBSIDIAN-SHARED-SECTIONS-UX-01 §8,
// OBSIDIAN-SYNC-INDICATORS-01 §9). Pure.
//
// - Native source copy is the editor's own: the selected source, bindings
//   included; the plugin adds nothing to it.
// - "Copy readable text": the selection with LFCP metadata removed and
//   nothing else (boundary and node markers, Task refs); private text and
//   formatting stay as they are.
// - "Copy shared section": the section's whole projection, every binding
//   kept, to paste as another projection of the same section. A ref gives
//   no access.

import { splitLines } from "../refs/lines";
import { parseSections } from "./parser";

const LINE_MARKER = /^[ \t]*<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->[ \t]*$/;
const INLINE_REF = /[ \t]*<!--[ \t]+lfcp-ref:[^>]*-->/g;

/** `text` without LFCP metadata: marker lines dropped, inline refs cut. */
export function readableText(text: string): string {
  const out: string[] = [];
  for (const l of splitLines(text)) {
    if (LINE_MARKER.test(l.text)) continue;
    out.push(l.text.replace(INLINE_REF, "") + l.eol);
  }
  return out.join("");
}

/** The whole projection of the section at `line` (heading to end marker), or null. */
export function sharedSectionText(markdown: string, line: number): string | null {
  const s = parseSections(markdown).sections.find(
    (x) => line >= x.heading.line && line <= x.endLine,
  );
  if (s === undefined) return null;
  return splitLines(markdown)
    .slice(s.heading.line, s.endLine + 1)
    .map((l) => l.text + l.eol)
    .join("");
}
