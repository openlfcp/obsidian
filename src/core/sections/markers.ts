// Bindings for nodes that just got their IDs (LFCP-02-039's "projected"
// step, MARKDOWN-SECTIONS-01 §4.3, decisions M1 and M5). Pure; not wired in.
//
// - paragraph and raw: a node marker on the line before the block, at the
//   block's indentation;
// - item: a node marker after the item's last line, at its content column
//   (where the parser looks for it);
// - task: a child-line Task ref at the Task's content column, as 0.1's
//   attachRef writes it. The canonical inline form inside sections (the ref
//   before the Tasks fields, spec bb4ba6f) needs the ref scanner to accept
//   a ref that is not at the end of the line (MS42–MS45); until then every
//   new Task ref in a section is written on its child line.
//
// The changes only add lines: no Text changes, every line ending kept.

import type { Line } from "../refs/lines";
import { splitLines } from "../refs/lines";
import { parseTaskLine, visualWidth } from "../refs/scanner";
import { formatRefComment } from "../refs/serializer";
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
      const pad = " ".repeat(task.contentColumn - visualWidth(task.indent));
      const comment = formatRefComment({ resourceId, objectType: "task", objectId: b.id });
      changes.push(after(node.lines.from, `${task.indent}${pad}${comment}`));
    }
  }
  return { changes: changes.sort((a, b) => a.from - b.from), missed };
}
