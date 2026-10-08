// Bindings for nodes that just got their IDs (LFCP-02-039's "projected"
// step, MARKDOWN-SECTIONS-01 §4.3, decisions M1 and M5). Pure; not wired in.
//
// - paragraph and raw: a node marker on the line before the block, at the
//   block's indentation;
// - item: a node marker after the item's last line, at its content column
//   (where the parser looks for it);
// - task: by the binding placement setting (§4.1): a child-line Task ref
//   at the Task's content column, as 0.1's attachRef writes it (the
//   default), or inline in the canonical form inside sections, before the
//   Task's Tasks fields.
//
// The changes only add lines: no Text changes, every line ending kept.

import { fieldsStart } from "../projection/task-text";
import type { Line } from "../refs/lines";
import { splitLines } from "../refs/lines";
import { parseTaskLine, visualWidth } from "../refs/scanner";
import { formatRefComment } from "../refs/serializer";
import type { RefPlacement } from "../settings";
import { formatNodeMarker } from "./grammar";
import type { ParsedSection, SectionNode, SectionNodeKind } from "./parser";
import { type DocChange, lineStarts, nodeSource } from "./source-map";

export interface NewBinding {
  /** The node's first line in the note the IDs were allocated against. */
  readonly line: number;
  readonly kind: SectionNodeKind;
  readonly id: string;
}

/** The unbound node of `kind` starting at `line`, if the note still has it. */
function unboundAt(
  nodes: readonly SectionNode[],
  line: number,
  kind: SectionNodeKind,
): SectionNode | undefined {
  for (const n of nodes) {
    if (n.id === null && n.lines.from === line && n.kind === kind) return n;
    const inner: SectionNode | undefined = unboundAt(n.children, line, kind);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/**
 * The note changes that bind each new node of `section` to its ID, and the
 * bindings whose node is no longer there unbound (the source moved on:
 * the caller re-reads and projects again; the IDs stay in the journal).
 */
export function bindingChanges(
  markdown: string,
  section: ParsedSection,
  bindings: readonly NewBinding[],
  resourceId: Uint8Array,
  placement: RefPlacement = "child-line",
): { changes: DocChange[]; missed: NewBinding[] } {
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const newline = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const changes: DocChange[] = [];
  const missed: NewBinding[] = [];
  /** A new line after `l`: its ending goes first, the new line takes the original one. */
  const after = (l: number, text: string): DocChange => {
    const line = lines[l] as Line;
    const at = (starts[l] ?? 0) + line.text.length;
    return { from: at, to: at, insert: `${line.eol === "" ? newline : line.eol}${text}` };
  };
  for (const b of bindings) {
    const node = unboundAt(section.nodes, b.line, b.kind);
    // A local comment being shared (§4.5): a raw marker on its own line before it.
    if (
      node === undefined &&
      b.kind === "raw" &&
      section.localBlocks.some((x) => x.from === b.line)
    ) {
      const line = lines[b.line] as Line;
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
      const at = starts[b.line] ?? 0;
      changes.push({
        from: at,
        to: at,
        insert: `${formatNodeMarker("raw", b.id, indent)}${line.eol === "" ? newline : line.eol}`,
      });
      continue;
    }
    if (node === undefined) {
      missed.push(b);
      continue;
    }
    const first = lines[node.lines.from] as Line;
    if (b.kind === "paragraph" || b.kind === "raw") {
      const indent = /^[ \t]*/.exec(first.text)?.[0] ?? "";
      const at = starts[node.lines.from] ?? 0;
      const eol = first.eol === "" ? newline : first.eol;
      changes.push({
        from: at,
        to: at,
        insert: `${indent}${formatNodeMarker(b.kind, b.id)}${eol}`,
      });
    } else if (b.kind === "item") {
      const indent = nodeSource(markdown, node)?.indent ?? "";
      changes.push(after(node.lines.to, formatNodeMarker("item", b.id, indent)));
    } else {
      const task = parseTaskLine(first.text, node.lines.from);
      if (task === undefined) {
        missed.push(b);
        continue;
      }
      const comment = formatRefComment({ resourceId, objectType: "task", objectId: b.id });
      if (placement === "inline") {
        const at =
          (starts[node.lines.from] ?? 0) +
          task.textStart +
          fieldsStart(first.text.slice(task.textStart));
        changes.push({ from: at, to: at, insert: ` ${comment}` });
        continue;
      }
      const pad = " ".repeat(task.contentColumn - visualWidth(task.indent));
      changes.push(after(node.lines.from, `${task.indent}${pad}${comment}`));
    }
  }
  return { changes: changes.sort((a, b) => a.from - b.from), missed };
}
