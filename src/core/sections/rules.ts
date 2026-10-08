// Context-aware delete, detach, duplicate and cut/paste inside shared
// sections (LFCP-02-046, MARKDOWN-SECTIONS-01 §7, §10). Pure rules over the
// parser's output and the editor transaction's facts; not wired in.

import { joinLines, type Line, splitLines } from "../refs/lines";
import { parseNodeMarker, type SectionRef, sameSection } from "./grammar";
import { type LineRange, type ParsedSection, type SectionNode, scanSectionRefs } from "./parser";

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
