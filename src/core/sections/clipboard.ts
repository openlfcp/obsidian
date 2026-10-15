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
import type { TargetCapture } from "./target";

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

/** The offset of a (line, ch) position in `markdown` (lines split as the editor counts them). */
function offsetOf(markdown: string, line: number, ch: number): number {
  let at = 0;
  const lines = splitLines(markdown);
  for (let i = 0; i < line && i < lines.length; i++) {
    const l = lines[i];
    if (l !== undefined) at += l.text.length + l.eol.length;
  }
  return Math.min(at + ch, markdown.length);
}

/**
 * What "Copy readable text" copies from a note as an action captured it
 * (LFCP-03-013; the palette's command and the pane run the same): its
 * selected text, else the section at the cursor, without LFCP metadata;
 * null when there is neither.
 */
export function readableCopy(at: TargetCapture): string | null {
  const parts = at.selections
    .map((s) => {
      const a = offsetOf(at.text, s.anchor.line, s.anchor.ch);
      const h = offsetOf(at.text, s.head.line, s.head.ch);
      return at.text.slice(Math.min(a, h), Math.max(a, h));
    })
    .filter((t) => t !== "");
  const text = parts.length > 0 ? parts.join("\n") : sharedSectionText(at.text, at.cursorLine);
  return text === null || text === "" ? null : readableText(text);
}
