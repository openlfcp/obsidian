// Context-aware delete, detach, duplicate and cut/paste inside shared
// sections (LFCP-02-046, MARKDOWN-SECTIONS-01 §7, §10). Pure rules over the
// parser's output and the editor transaction's facts; not wired in.

import { joinLines, type Line, splitLines } from "../refs/lines";
import { parseNodeMarker, type SectionRef, sameSection } from "./grammar";
import {
  type LineRange,
  type ParsedSection,
  parseSections,
  type SectionNode,
  scanSectionRefs,
} from "./parser";

/** The note's lines that only carry bindings of `section`, and its inline refs. */
function bindingsOf(markdown: string, section: ParsedSection) {
  const lines = splitLines(markdown);
  const drop = new Set<number>([section.startLine, section.endLine]);
  for (let i = section.startLine + 1; i < section.endLine; i++)
    if (parseNodeMarker(lines[i]?.text ?? "")?.kind !== undefined) drop.add(i);
  const inline = new Map<number, { start: number; end: number }>();
  for (const p of scanSectionRefs(markdown).projections) {
    if (p.taskLine <= section.startLine || p.taskLine >= section.endLine) continue;
    if (p.placement === "child") drop.add(p.refLine);
    else inline.set(p.taskLine, { start: p.comment.start, end: p.comment.end });
  }
  return { lines, drop, inline };
}

/** A line without its inline ref (the comment and the whitespace before it). */
function withoutInlineRef(line: Line, at: { start: number; end: number } | undefined): Line {
  if (at === undefined) return line;
  return { text: line.text.slice(0, at.start).trimEnd() + line.text.slice(at.end), eol: line.eol };
}

/**
 * Detach this projection (§10): the same note with every binding of the
 * section removed, its readable text kept. No shared change follows; other
 * projections and the Resource are untouched (fixture MS10-detach).
 */
export function detachSection(markdown: string, section: ParsedSection): string {
  const { lines, drop, inline } = bindingsOf(markdown, section);
  const kept: Line[] = [];
  lines.forEach((l, i) => {
    if (!drop.has(i)) kept.push(withoutInlineRef(l, inline.get(i)));
  });
  // A dropped last line passes its (missing) ending to the line before it.
  if (drop.has(lines.length - 1) && lines.at(-1)?.eol === "" && kept.length > 0) {
    const last = kept.at(-1) as Line;
    kept[kept.length - 1] = { text: last.text, eol: "" };
  }
  return joinLines(kept);
}

/**
 * "Detach this section" at a line (§10): the section whose heading or body
 * holds the line, detached; null when the line is in none. The other
 * sections of the note keep their bindings.
 */
export function detachAt(
  markdown: string,
  line: number,
): { readonly markdown: string; readonly section: SectionRef; readonly title: string } | null {
  const section = parseSections(markdown).sections.find(
    (s) => line >= s.heading.line && line <= s.endLine,
  );
  if (section === undefined) return null;
  return {
    markdown: detachSection(markdown, section),
    section: section.ref,
    title: section.heading.title,
  };
}

/**
 * The "Copy readable text" output (§10, fixture MS25): the heading and the
 * section's content without bindings, LF line breaks, ending with one. The
 * note itself is not changed.
 */
export function readableSection(markdown: string, section: ParsedSection): string {
  const { lines, drop, inline } = bindingsOf(markdown, section);
  const out: string[] = [];
  for (let i = section.heading.line; i < section.endLine; i++)
    if (!drop.has(i)) out.push(withoutInlineRef(lines[i] as Line, inline.get(i)).text);
  return `${out.join("\n")}\n`;
}

/** Lines a transaction removed from the note, in the note's lines before it (null: no transaction known). */
export type Removed = readonly LineRange[] | null;

/**
 * Why a bound node is missing from the note (§7). A deletion only when the
 * editor transaction removed every line the node owned (its marker and ref
 * lines included), so the node and its binding went together: node.delete,
 * recoverable (fixture MS10-delete). Without a transaction (an external
 * edit), or when only part of it went (a lost marker, MS21), it is
 * NODE_BINDING_LOST, and the text is kept (MS18).
 */
export function classifyRemoval(node: SectionNode, removed: Removed): "delete" | "lost" {
  if (removed === null) return "lost";
  for (let l = node.lines.from; l <= node.lines.to; l++)
    if (!removed.some((r) => l >= r.from && l <= r.to)) return "lost";
  return "delete";
}

/**
 * A node ID that occurs more than once in one projection (§4.5): the
 * occurrence that was there before keeps the identity; the others are
 * offered "Duplicate as new" (fixture MS08). Publication waits.
 */
export function duplicates(
  section: ParsedSection,
  before: ReadonlySet<string>,
): { readonly id: string; readonly keep: SectionNode | null; readonly copies: SectionNode[] }[] {
  const seen = new Map<string, SectionNode[]>();
  const walk = (ns: readonly SectionNode[]) => {
    for (const n of ns) {
      if (n.id !== null) seen.set(n.id, [...(seen.get(n.id) ?? []), n]);
      walk(n.children);
    }
  };
  walk(section.nodes);
  return [...seen]
    .filter(([, ns]) => ns.length > 1)
    .map(([id, ns]) => {
      // Without a base, no occurrence is the original: all are offered.
      const keep = before.has(id) ? (ns[0] as SectionNode) : null;
      return { id, keep, copies: keep === null ? ns : ns.slice(1) };
    });
}

/** A cut this session made of bound nodes (local, in memory). */
export interface CutRecord {
  readonly section: SectionRef;
  readonly ids: readonly string[];
}

/**
 * What a paste of bound nodes means (§10). A same-session paste of a cut,
 * into the same section, keeps the identities: a move (the cut's
 * recoverable delete is then compensated). Into another section or
 * Resource it is an explicit copy with new identities, never one atomic
 * move. Anything else (no matching cut) is not inferred: the pasted
 * bindings are duplicates or foreign refs for the parser to report.
 */
export function pasteDecision(
  cut: CutRecord | null,
  into: SectionRef,
  pastedIds: readonly string[],
): "move" | "copy-with-new-identities" | "not-a-cut" {
  if (cut === null || pastedIds.length === 0 || !pastedIds.every((id) => cut.ids.includes(id)))
    return "not-a-cut";
  return sameSection(cut.section, into) ? "move" : "copy-with-new-identities";
}

/**
 * Enter at the end of a Task line whose ref is on its child line
 * (MARKDOWN-SECTIONS-01 §4.1, MS27, MS28): the editor inserts the new line
 * between the Task and its ref, so the ref would bind the new line and the
 * Task would look new. The insertion moves past the Task's subtree (its ref,
 * its children), keeping the ref with its Task, in the same transaction.
 * Null when `change` is not such an insertion in a section of `before`.
 */
export function keepRefWithTask(
  before: string,
  change: { readonly from: number; readonly to: number; readonly insert: string },
): { readonly from: number; readonly to: number; readonly insert: string } | null {
  if (change.to !== change.from || !/^\r?\n/.test(change.insert)) return null;
  const lines = splitLines(before);
  let at = 0;
  let line = -1;
  for (let i = 0; i < lines.length; i++) {
    const end = at + (lines[i]?.text.length ?? 0);
    if (change.from === end) {
      line = i;
      break;
    }
    at = end + (lines[i]?.eol.length ?? 0);
  }
  if (line < 0) return null;
  const p = scanSectionRefs(before).projections.find(
    (x) => x.taskLine === line && x.placement === "child",
  );
  if (p === undefined) return null;
  const node = parseSections(before)
    .sections.flatMap((s) => [...walkNodes(s.nodes)])
    .find((n) => n.id === p.objectId && n.lines.from === line);
  if (node === undefined) return null;
  let last = node.lines.to;
  for (const d of walkNodes(node.children)) last = Math.max(last, d.lines.to);
  let end = 0;
  for (let i = 0; i <= last; i++)
    end += (lines[i]?.text.length ?? 0) + (i < last ? (lines[i]?.eol.length ?? 0) : 0);
  return { from: end, to: end, insert: change.insert };
}

function* walkNodes(nodes: readonly SectionNode[]): Generator<SectionNode> {
  for (const n of nodes) {
    yield n;
    yield* walkNodes(n.children);
  }
}
