// What an insert preview shows (LFCP-03-020, UX contract C5, U03-27, F-09).
// Pure and display-only: the block that is written is not changed here.
//
// - The readable text hides only the binding lines the parser recognises
//   as this section's: its boundary markers, well-formed node markers and
//   Task refs. Unknown comments, raw blocks and other text stay as they are.
// - The exact source, every marker included, is kept for a collapsed
//   "technical source" view.
// - Metadata the parser cannot read is never hidden: it stays in the
//   readable text, and a problem sentence says where. A block that does not
//   read back as one section hides nothing.

import { lineKinds } from "../refs";
import { type Line, splitLines } from "../refs/lines";
import { parseNodeMarker } from "./grammar";
import { parseSections, type SectionDiagnosticCode, scanSectionRefs } from "./parser";

export interface PreviewDisplay {
  /** What the user reads: the section without its recognised bindings. */
  readonly readable: string;
  /** The exact lines that would be written, every marker included. */
  readonly source: string;
  /** How many recognised bindings (marker lines and inline Task refs) `readable` leaves out. */
  readonly hidden: number;
  /** Why some metadata is shown as it is; null when every binding was read. */
  readonly problem: string | null;
}

/** Parser findings that leave sharing metadata unread (shown, never hidden). */
const UNREAD: ReadonlySet<SectionDiagnosticCode> = new Set([
  "SECTION_MARKER_MALFORMED",
  "NODE_MARKER_MALFORMED",
  "NODE_BINDING_ORPHAN",
  "NODE_BINDING_LOST",
  "NODE_KIND_MISMATCH",
  "NODE_BINDING_DUPLICATE",
  "FOREIGN_RESOURCE_REF",
]);

/** The boundary of the block could not be read: nothing is hidden. */
export const BOUNDARY_UNREAD =
  "The boundary of these lines could not be read, so nothing is hidden: they are shown exactly as they would be written.";

const unreadAt = (line: number) =>
  `Line ${line + 1} has sharing metadata that could not be read. It is shown as it is.`;

/** The readable view of an insert preview's `block`. */
export function insertDisplay(block: string): PreviewDisplay {
  const scan = parseSections(block);
  const section = scan.sections[0];
  if (scan.sections.length !== 1 || scan.damaged.length > 0 || section === undefined)
    return { readable: block, source: block, hidden: 0, problem: BOUNDARY_UNREAD };
  const lines = splitLines(block);
  // Lines the parser has a finding on: a well-formed marker or ref there is
  // still a problem (an orphan, a duplicate, another Resource, the wrong
  // kind), so it is shown, never hidden as if it were read.
  const findings = scan.diagnostics.filter((d) => UNREAD.has(d.code));
  const flagged = new Set(findings.map((d) => d.line));
  const drop = new Set<number>([section.startLine, section.endLine]);
  const kinds = lineKinds(lines);
  for (let i = section.startLine + 1; i < section.endLine; i++) {
    // Inside a fence or a multi-line comment a marker is text, not a binding.
    if (kinds[i] === "literal" || flagged.has(i)) continue;
    const kind = parseNodeMarker(lines[i]?.text ?? "")?.kind;
    if (kind !== undefined && kind !== "malformed") drop.add(i);
  }
  const inline = new Map<number, { start: number; end: number }>();
  for (const p of scanSectionRefs(block).projections) {
    if (p.taskLine <= section.startLine || p.taskLine >= section.endLine) continue;
    if (flagged.has(p.taskLine) || flagged.has(p.refLine)) continue;
    if (p.placement === "child") drop.add(p.refLine);
    else inline.set(p.taskLine, { start: p.comment.start, end: p.comment.end });
  }
  const out: Line[] = [];
  lines.forEach((l, i) => {
    if (drop.has(i)) return;
    const at = inline.get(i);
    out.push(
      at === undefined
        ? l
        : { text: l.text.slice(0, at.start).trimEnd() + l.text.slice(at.end), eol: l.eol },
    );
  });
  const unread = findings[0];
  return {
    readable: out
      .map((l) => l.text + l.eol)
      .join("")
      .replace(/\s+$/, "\n"),
    source: block,
    hidden: drop.size + inline.size,
    problem: unread === undefined ? null : unreadAt(unread.line),
  };
}
