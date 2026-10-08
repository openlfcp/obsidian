// Source maps for shared sections (LFCP-02-036): a node's Text as the
// profile holds it, extracted from the note's lines, and the mapping
// between positions in that Text (Unicode scalars, SSP §10) and offsets in
// the note (UTF-16, as editors and CodeMirror count). Pure; not wired in.
//
// Text extraction (SHARED-SECTIONS-PROFILE-01 §4.2, MARKDOWN-SECTIONS-01
// §4–§5; working answers pending the frozen grammar):
// - paragraph and raw: the node's lines without its marker line, each with
//   its indentation stripped to the node's column, joined with LF;
// - item: the inline text after the list marker, then its continuation
//   lines (lazy ones too) stripped to the content column, joined with LF;
// - task: no Text (its fields are scalars, read by the 0.1 Task parser).
// Line endings in Text are LF; the note's CRLF is local presentation. A tab
// that reaches past the column being stripped leaves the remainder as
// spaces (CommonMark), which map back to the tab's position.

import { type Line, splitLines } from "../refs/lines";
import { visualWidth } from "../refs/scanner";
import type { SectionNode } from "./parser";
import { scalarToUtf16, type TextEdit, utf16ToScalar } from "./text";

/** One line's piece of a node's Text. */
interface Segment {
  /** UTF-16 offset in the note where the piece's real characters start. */
  readonly docFrom: number;
  /** UTF-16 offset in the note just after the piece (its line ending excluded). */
  readonly docTo: number;
  /** UTF-16 offset in the Text where the piece starts (virtual spaces first). */
  readonly textFrom: number;
  /** Spaces standing for the part of a tab past the stripped column. */
  readonly virtual: number;
}

export interface NodeSource {
  readonly node: SectionNode;
  /** The node's Text: LF line breaks, no indentation, no markers. */
  readonly text: string;
  readonly segments: readonly Segment[];
  /** The indentation a new line of this Text gets in the note (the first line's own). */
  readonly indent: string;
  /** The note's line ending at this node, for new lines. */
  readonly eol: string;
}

/** Line start offsets (UTF-16) of a note, for lines of `splitLines`. */
export function lineStarts(lines: readonly Line[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.text.length + l.eol.length;
  }
  return starts;
}

/** Strips indentation up to visual `column`: the rest, its UTF-16 start in `text`, and virtual spaces. */
export function stripIndent(
  text: string,
  column: number,
): { rest: string; from: number; virtual: number } {
  let col = 0;
  let i = 0;
  while (col < column && i < text.length) {
    const c = text[i];
    if (c === " ") col++;
    else if (c === "\t") {
      const next = col + 4 - (col % 4);
      if (next > column) {
        const virtual = next - column;
        return { rest: " ".repeat(virtual) + text.slice(i + 1), from: i + 1, virtual };
      }
      col = next;
    } else break;
    i++;
  }
  return { rest: text.slice(i), from: i, virtual: 0 };
}

const LIST_PREFIX = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/** The source of a node's Text, or null for a Task node. */
export function nodeSource(markdown: string, node: SectionNode): NodeSource | null {
  if (node.kind === "task") return null;
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const pieces: { line: number; from: number; rest: string; virtual: number }[] = [];
  let indent: string | null = null;
  const first = lines[node.lines.from]?.text ?? "";
  const isMarker = (l: number) => /^[ \t]*<!--[ \t]+lfcp-node:/.test(lines[l]?.text ?? "");
  const markerFirst = node.kind !== "item" && isMarker(node.lines.from);
  if (node.kind === "item") {
    const m = LIST_PREFIX.exec(first);
    const prefix = m === null ? "" : `${m[1]}${m[2]}${m[3] || " "}`;
    const from = m === null ? 0 : (m[0] as string).length;
    pieces.push({ line: node.lines.from, from, rest: first.slice(from), virtual: 0 });
    const contentColumn = visualWidth(prefix);
    // New lines continue at the content column: as an existing continuation line does, or in spaces.
    const second = lines[node.lines.from + 1]?.text ?? "";
    indent =
      node.lines.to > node.lines.from && !isMarker(node.lines.from + 1)
        ? second.slice(0, stripIndent(second, contentColumn).from)
        : " ".repeat(contentColumn);
    const last = isMarker(node.lines.to) ? node.lines.to - 1 : node.lines.to;
    for (let l = node.lines.from + 1; l <= last; l++) {
      const s = stripIndent(lines[l]?.text ?? "", contentColumn);
      pieces.push({ line: l, from: s.from, rest: s.rest, virtual: s.virtual });
    }
  } else {
    for (let l = node.lines.from + (markerFirst ? 1 : 0); l <= node.lines.to; l++) {
      const s = stripIndent(lines[l]?.text ?? "", node.column);
      pieces.push({ line: l, from: s.from, rest: s.rest, virtual: s.virtual });
    }
  }
  const segments: Segment[] = [];
  let text = "";
  pieces.forEach((p, k) => {
    if (k > 0) text += "\n";
    const lineStart = starts[p.line] ?? 0;
    const lineText = lines[p.line]?.text ?? "";
    segments.push({
      docFrom: lineStart + p.from,
      docTo: lineStart + lineText.length,
      textFrom: text.length,
      virtual: p.virtual,
    });
    text += p.rest;
  });
  const firstText = lines[pieces[0]?.line ?? node.lines.from]?.text ?? "";
  return {
    node,
    text,
    segments,
    indent: indent ?? firstText.slice(0, pieces[0]?.from ?? 0),
    eol: lines[node.lines.from]?.eol || "\n",
  };
}

/** The note offset (UTF-16) of scalar `index` in the node's Text. */
export function textToDoc(src: NodeSource, index: number): number {
  const u = scalarToUtf16(src.text, index);
  let found: Segment | undefined;
  for (const s of src.segments) if (s.textFrom <= u) found = s;
  const s = found ?? (src.segments[0] as Segment);
  const within = u - s.textFrom;
  // Inside a tab's virtual spaces: the tab itself.
  if (within < s.virtual) return s.docFrom - 1;
  return Math.min(s.docFrom + within - s.virtual, s.docTo);
}

/**
 * The scalar position in the node's Text of note offset `offset`, or null
 * when the offset is not inside the Text (indentation, a marker, another node).
 */
export function docToText(src: NodeSource, offset: number): number | null {
  for (const s of src.segments)
    if (offset >= s.docFrom && offset <= s.docTo)
      return utf16ToScalar(src.text, s.textFrom + s.virtual + (offset - s.docFrom));
  return null;
}

/** A change to the note in UTF-16 offsets. */
export interface DocChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * The note change for a Text edit (a remote one, to project): positions
 * mapped through the source map; a line break in the inserted text becomes
 * the note's line ending plus the node's indentation.
 */
export function textEditToDoc(src: NodeSource, edit: TextEdit): DocChange {
  const end = edit.index + edit.deleteCount;
  return {
    from: textToDoc(src, edit.index),
    to: textToDoc(src, end),
    insert: edit.insert.replaceAll("\n", `${src.eol}${src.indent}`),
  };
}
