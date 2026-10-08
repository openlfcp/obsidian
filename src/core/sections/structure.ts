// Nodes a collaborator created or moved, written into the note
// (MARKDOWN-SECTIONS-01 §4–§6). Pure; the engine composes it after the
// Text patches (remote.ts). "A task a collaborator added appears in my
// section by itself."
//
// - New nodes go in the model's order: after their visible predecessor's
//   subtree, or first under their parent (right after the parent's own
//   lines, or the start marker), in preorder, so a new parent's new
//   children follow it.
// - Each kind is written in its binding form (§4.1–§4.4): a Task as 0.1
//   renders a new one with its ref on the child line, an item with its
//   marker after its text, a paragraph or raw block after its marker.
//   Children go at the parent's content column; under a tab-indented parent,
//   one more tab (decision M2). Ordered items are numbered from 1 in their
//   run (§5).
// - Paragraphs and raw blocks are set apart by a blank line from their
//   neighbours, except as the first child of a Task or item (§6).
// - A moved node takes its whole subtree, re-indented for its new parent,
//   only when none of it changed here and no local comment sits in it.
// - With a model problem, nothing structural is written (MS14). A node whose
//   predecessor or parent is not in the note yet waits for a later pass.

import type { Task } from "@openlfcp/shared-objects";
import { renderNewTaskLine } from "../projection/render";
import { isBlank, splitLines } from "../refs/lines";
import type { RefPlacement } from "../settings";
import { markdownState, ROOT, type SectionState } from "./base";
import { formatNodeMarker } from "./grammar";
import type { LineRange, ParsedSection, SectionNode } from "./parser";
import type { ModelNode, SectionSnapshot } from "./port";
import { unprojected } from "./remote";
import { type DocChange, lineStarts } from "./source-map";

export type StructureDefer =
  | "frozen"
  /** Its predecessor or parent is not in the note yet. */
  | "no-anchor"
  /** A new Task whose Shared Objects Task is not here yet. */
  | "no-task"
  /** A moved node changed here since the base: the local edit goes first. */
  | "local-edit"
  /** A moved node holds a local comment. */
  | "private-text";

export interface StructurePlan {
  /** Changes against the note, ascending, not overlapping. */
  readonly changes: readonly DocChange[];
  /** Nodes created or moved by these changes. */
  readonly placed: readonly string[];
  readonly deferred: readonly { readonly nodeId: string; readonly reason: StructureDefer }[];
}

const LIST_PREFIX = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const PR = (kind: string | undefined) => kind === "paragraph" || kind === "raw";

/** The indentation of a child of the list line `text`: one more tab, or spaces to its content column. */
function childIndent(text: string): string {
  const m = LIST_PREFIX.exec(text);
  if (m === null) return /^[ \t]*/.exec(text)?.[0] ?? "";
  const indent = m[1] as string;
  return indent.includes("\t") ? `${indent}\t` : indent + " ".repeat((m[2] as string).length + 1);
}

function subtreeEnd(n: SectionNode): number {
  let to = n.lines.to;
  for (const c of n.children) to = Math.max(to, subtreeEnd(c));
  return to;
}

function* subtree(n: SectionNode): Generator<SectionNode> {
  yield n;
  for (const c of n.children) yield* subtree(c);
}

interface Chunk {
  readonly id: string;
  readonly kind: string;
  readonly lines: readonly string[];
  /** Right after its parent's own lines (no blank line before it, §6). */
  readonly firstChild: boolean;
}

export function planStructure(
  markdown: string,
  section: ParsedSection,
  base: SectionState,
  model: SectionSnapshot,
  opts: {
    readonly resourceId: Uint8Array;
    readonly task: (taskId: string) => Task | undefined;
    /** Where a new Task's ref goes (§4.1): its child line (default) or inline, canonically. */
    readonly placement?: RefPlacement;
  },
): StructurePlan {
  const noteState = markdownState(markdown, section).state;
  const todo = unprojected(base, noteState, model);
  if (todo.length === 0) return { changes: [], placed: [], deferred: [] };
  if (model.problems.length > 0)
    return {
      changes: [],
      placed: [],
      deferred: todo.map((nodeId) => ({ nodeId, reason: "frozen" as const })),
    };

  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const offsetOf = (line: number) => starts[line] ?? markdown.length;
  const inNote = new Map<string, SectionNode>();
  const walkNote = (ns: readonly SectionNode[]) => {
    for (const n of ns) {
      if (n.id !== null) inNote.set(n.id, n);
      walkNote(n.children);
    }
  };
  walkNote(section.nodes);

  const wanted = new Set(todo);
  const chunks = new Map<number, Chunk[]>();
  /** Where each placed node's text goes, and its children's indentation. */
  const placed = new Map<string, { offset: number; childIndent: string }>();
  const removed: { range: LineRange; change: DocChange }[] = [];
  /** Lines the moves take away (a moved subtree and the blank line after it). */
  const gone = new Set<number>();
  const carried = new Set<string>();
  const deferred: { nodeId: string; reason: StructureDefer }[] = [];
  const insideRemoved = (offset: number) =>
    removed.some((r) => offset > r.change.from && offset < r.change.to);

  /** Where a node goes: after its predecessor's subtree, or first under its parent. */
  const position = (parent: string | null, pred: string | null) => {
    if (pred !== null) {
      const p = placed.get(pred);
      if (p !== undefined) return { offset: p.offset, firstChild: false };
      const n = inNote.get(pred);
      if (n === undefined || carried.has(pred)) return null;
      return { offset: offsetOf(subtreeEnd(n) + 1), firstChild: false };
    }
    if (parent === null) return { offset: offsetOf(section.startLine + 1), firstChild: true };
    const p = placed.get(parent);
    if (p !== undefined) return { offset: p.offset, firstChild: true };
    const n = inNote.get(parent);
    if (n === undefined || carried.has(parent)) return null;
    return { offset: offsetOf(n.lines.to + 1), firstChild: true };
  };

  const indentFor = (parent: string | null): string | null => {
    if (parent === null) return "";
    const p = placed.get(parent);
    if (p !== undefined) return p.childIndent;
    const n = inNote.get(parent);
    return n === undefined ? null : childIndent(lines[n.lines.from]?.text ?? "");
  };

  /** The run position of an ordered item among its siblings: 1 for the first. */
  const ordinal = (siblings: readonly string[], at: number) => {
    let n = 1;
    for (let k = at - 1; k >= 0 && model.nodes[siblings[k] as string]?.listStyle === "ordered"; k--)
      n++;
    return n;
  };

  const render = (
    id: string,
    m: ModelNode,
    indent: string,
    marker: string,
  ): { lines: string[]; childIndent: string } | "no-task" => {
    const text = m.text ?? "";
    const content = indent.includes("\t") ? `${indent}\t` : indent + " ".repeat(marker.length + 1);
    if (m.kind === "paragraph" || m.kind === "raw")
      return {
        lines: [
          formatNodeMarker(m.kind, id, indent),
          ...text.split("\n").map((l) => (l === "" ? "" : indent + l)),
        ],
        childIndent: indent,
      };
    if (m.kind === "item") {
      const [first = "", ...rest] = text.split("\n");
      return {
        lines: [
          `${indent}${marker} ${first}`,
          ...rest.map((l) => (l === "" ? "" : content + l)),
          formatNodeMarker("item", id, content),
        ],
        childIndent: content,
      };
    }
    const task = opts.task(id);
    if (task === undefined) return "no-task";
    const rendered = renderNewTaskLine(task, {
      placement: opts.placement === "inline" ? "inline" : "child",
      inSection: true,
      ref: { resourceId: opts.resourceId, objectType: "task", objectId: id },
      indent,
      marker,
      eol: "\n",
    });
    return { lines: rendered.replace(/\n$/, "").split("\n"), childIndent: content };
  };

  const unchanged = (n: SectionNode) => {
    for (const d of subtree(n)) {
      if (d.id === null) return false;
      const now = noteState.nodes[d.id];
      const was = base.nodes[d.id];
      if (now === undefined || was === undefined || now.text !== was.text || now.line !== was.line)
        return false;
    }
    return true;
  };

  const add = (offset: number, chunk: Chunk) =>
    chunks.set(offset, [...(chunks.get(offset) ?? []), chunk]);

  const visit = (parent: string | null) => {
    const siblings = (model.order[parent ?? ROOT] ?? []).filter(
      (s) => model.nodes[s] !== undefined && model.nodes[s]?.hidden !== true,
    );
    siblings.forEach((id, at) => {
      const m = model.nodes[id] as ModelNode;
      if (wanted.has(id) && !carried.has(id)) {
        const pred = at > 0 ? (siblings[at - 1] as string) : null;
        const pos = position(parent, pred);
        const indent = indentFor(parent);
        const marker = m.listStyle === "ordered" ? `${ordinal(siblings, at)}.` : "-";
        if (pos === null || indent === null || insideRemoved(pos.offset)) {
          deferred.push({ nodeId: id, reason: "no-anchor" });
          return;
        }
        const existing = inNote.get(id);
        if (existing === undefined) {
          const r = render(id, m, indent, marker);
          if (r === "no-task") {
            deferred.push({ nodeId: id, reason: "no-task" });
            return;
          }
          add(pos.offset, { id, kind: m.kind, lines: r.lines, firstChild: pos.firstChild });
          placed.set(id, { offset: pos.offset, childIndent: r.childIndent });
        } else {
          // A move: the subtree's lines, re-indented, at the new place.
          const range = { from: existing.lines.from, to: subtreeEnd(existing) };
          if (!unchanged(existing)) {
            deferred.push({ nodeId: id, reason: "local-edit" });
            return;
          }
          if (section.localBlocks.some((b) => b.from <= range.to && b.to >= range.from)) {
            deferred.push({ nodeId: id, reason: "private-text" });
            return;
          }
          const old = /^[ \t]*/.exec(lines[range.from]?.text ?? "")?.[0] ?? "";
          const moved: string[] = [];
          for (let l = range.from; l <= range.to; l++) {
            const t = lines[l]?.text ?? "";
            moved.push(
              isBlank(t) ? "" : indent + (t.startsWith(old) ? t.slice(old.length) : t.trimStart()),
            );
          }
          const blankAfter = isBlank(lines[range.to + 1]?.text ?? "x") ? 1 : 0;
          for (let l = range.from; l <= range.to + blankAfter; l++) gone.add(l);
          removed.push({
            range,
            change: {
              from: offsetOf(range.from),
              to: offsetOf(range.to + 1 + blankAfter),
              insert: "",
            },
          });
          for (const d of subtree(existing)) if (d.id !== null) carried.add(d.id);
          carried.delete(id);
          add(pos.offset, { id, kind: m.kind, lines: moved, firstChild: pos.firstChild });
          placed.set(id, {
            offset: pos.offset,
            childIndent:
              m.kind === "task" || m.kind === "item" ? childIndent(moved[0] ?? "") : indent,
          });
          for (const d of subtree(existing)) if (d.id !== null && d.id !== id) carried.add(d.id);
          return;
        }
      }
      if (!carried.has(id)) visit(id);
    });
  };
  visit(null);

  const changes: DocChange[] = removed.map((r) => r.change);
  for (const [offset, list] of chunks) {
    const lineAt = starts.indexOf(offset);
    // The lines around the insertion that stay: moved ones are gone.
    let prev = lineAt - 1;
    while (prev >= 0 && gone.has(prev)) prev--;
    let next = lineAt;
    while (next >= 0 && gone.has(next)) next++;
    const before = prev >= 0 ? (lines[prev]?.text ?? "") : "";
    const after = next >= 0 ? lines[next]?.text : undefined;
    const out: string[] = [];
    let prevKind: string | undefined = model.nodes[placedPred(list[0]?.id) ?? ""]?.kind;
    list.forEach((c, k) => {
      const prevBlank = k === 0 ? isBlank(before) || prev === section.startLine : false;
      if (!c.firstChild && !prevBlank && (PR(c.kind) || PR(prevKind))) out.push("");
      out.push(...c.lines);
      prevKind = c.kind;
    });
    const last = list.at(-1);
    if (
      last !== undefined &&
      PR(last.kind) &&
      after !== undefined &&
      !isBlank(after) &&
      next !== section.endLine
    )
      out.push("");
    changes.push({ from: offset, to: offset, insert: out.map((l) => l + eol).join("") });
  }

  /** The model predecessor of a node, to know what kind of block the text before it ends with. */
  function placedPred(id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    const m = model.nodes[id];
    if (m === undefined) return undefined;
    const siblings = model.order[m.parent ?? ROOT] ?? [];
    const at = siblings.indexOf(id);
    return at > 0 ? siblings[at - 1] : undefined;
  }

  return {
    changes: changes.sort((a, b) => a.from - b.from || (a.to === a.from ? -1 : 1)),
    placed: [...placed.keys()],
    deferred,
  };
}
