// The editor's own line moves inside shared sections (the owner's checks of
// 0.4.0-beta.10 on macOS, step 6): Move line up/down, Tab and Shift+Tab on a
// list line, and a paste that runs into the text around it. Obsidian edits
// lines; a section's node is a Task line with its ref on the child line, and
// its subtree. Each rule turns the editor's change into the same change made
// to whole nodes, so a ref stays with its Task, and says which node the user
// moved. Pure, over the parser's output; section-editor.ts applies them in
// the transaction itself (one undo step).

import { joinLines, type Line, splitLines } from "../refs/lines";
import { parseNodeMarker } from "./grammar";
import { type ParsedSection, parseSections, type SectionNode } from "./parser";
import { lineStarts } from "./source-map";

export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** The last line of `node`'s subtree (its own lines, then its descendants'). */
function subtreeEnd(node: SectionNode): number {
  let end = node.lines.to;
  for (const c of node.children) end = Math.max(end, subtreeEnd(c));
  return end;
}

/** The section of `scan` whose inside holds lines [a, b], or undefined. */
function sectionAround(markdown: string, a: number, b: number): ParsedSection | undefined {
  return parseSections(markdown).sections.find((s) => s.startLine < a && b < s.endLine);
}

/**
 * The siblings a line range [a, b] moves among: the deepest sibling list
 * whose run of consecutive nodes covers it, the run's first and last index.
 * A range inside one node's own lines (its Task line, its ref) is that node;
 * one inside its children goes down to them.
 */
function runOf(
  siblings: readonly SectionNode[],
  a: number,
  b: number,
): {
  readonly siblings: readonly SectionNode[];
  readonly first: number;
  readonly last: number;
} | null {
  const hit = siblings.flatMap((n, i) => (n.lines.from <= b && subtreeEnd(n) >= a ? [i] : []));
  const first = hit[0];
  const last = hit.at(-1);
  if (first === undefined || last === undefined) return null;
  const only = siblings[first] as SectionNode;
  if (first === last && a > only.lines.to && b <= subtreeEnd(only))
    return runOf(only.children, a, b) ?? { siblings, first, last };
  return { siblings, first, last };
}

/** IDs of the nodes `run` names (bound ones only). */
const idsOf = (ns: readonly SectionNode[]): string[] =>
  ns.flatMap((n) => (n.id === null ? [] : [n.id]));

/**
 * Move line up or down (Obsidian's editor:swap-line-up/down, Alt+Up/Down)
 * with lines [a, b] selected, inside a section of `before`: the nodes those
 * lines belong to move past their previous or next sibling, each with its
 * ref line and subtree. Null outside sections (the editor's move stands);
 * `{ changes: [] }` when there is no sibling to move past (the first or last
 * of its list: a line move would split a Task from its ref, or leave the
 * section). `moved`: the nodes the user moved; `shift`: how far the
 * selection moves with them.
 */
export function moveNodeLines(
  before: string,
  a: number,
  b: number,
  dir: "up" | "down",
): { readonly changes: TextChange[]; readonly moved: string[]; readonly shift: number } | null {
  const section = sectionAround(before, a, b);
  if (section === undefined) return null;
  const run = runOf(section.nodes, a, b);
  if (run === null) return { changes: [], moved: [], shift: 0 };
  const nodes = run.siblings.slice(run.first, run.last + 1);
  const other = run.siblings[dir === "up" ? run.first - 1 : run.last + 1];
  if (other === undefined) return { changes: [], moved: [], shift: 0 };
  const lines = splitLines(before);
  const starts = lineStarts(lines);
  const block = {
    from: (nodes[0] as SectionNode).lines.from,
    to: subtreeEnd(nodes.at(-1) as SectionNode),
  };
  const near = { from: other.lines.from, to: subtreeEnd(other) };
  // Every line moved ends with its line break (the end marker follows them).
  const slice = (r: { from: number; to: number }) => lines.slice(r.from, r.to + 1);
  if (slice(dir === "up" ? block : near).some((l) => l.eol === "")) return null;
  const up = dir === "up";
  const top = up ? near : block;
  const bottom = up ? block : near;
  const gap = lines.slice(top.to + 1, bottom.from);
  const text = (ls: readonly Line[]) => joinLines(ls);
  const from = starts[top.from] as number;
  const to =
    (starts[bottom.to] as number) +
    (lines[bottom.to] as Line).text.length +
    (lines[bottom.to] as Line).eol.length;
  const insert = text([...slice(bottom), ...gap, ...slice(top)]);
  const movedLength = text(slice(block)).length;
  const span = to - from;
  return {
    changes: [{ from, to, insert }],
    moved: idsOf(nodes),
    shift: up ? -(span - movedLength) : span - movedLength,
  };
}

/**
 * Tab or Shift+Tab on a node's first line (input.indent, delete.dedent):
 * Obsidian indents or dedents that line only, so a Task's ref line and its
 * subtree would stay where they were, the ref binding the Task's old parent.
 * The same whitespace is added to, or taken from, the node's other lines
 * and its subtree (lines the editor already changed are left as they are).
 * Null when nothing is added.
 */
export function indentWithNode(
  before: string,
  changes: readonly TextChange[],
): TextChange[] | null {
  if (!before.includes("lfcp-section:")) return null;
  const lines = splitLines(before);
  const starts = lineStarts(lines);
  const lineOf = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && (starts[i + 1] as number) <= pos) i++;
    return i;
  };
  const touched = new Set(changes.map((c) => lineOf(c.from)));
  const scan = parseSections(before);
  const extra: TextChange[] = [];
  for (const c of changes) {
    const line = lineOf(c.from);
    const text = lines[line]?.text ?? "";
    const lead = /^[ \t]*/.exec(text)?.[0] ?? "";
    const start = starts[line] as number;
    const at = c.from - start;
    const removed = before.slice(c.from, c.to);
    // Whitespace added or removed inside the line's leading whitespace.
    if (c.to - start > lead.length || !/^[ \t]*$/.test(c.insert) || !/^[ \t]*$/.test(removed))
      continue;
    if (c.insert === "" && removed === "") continue;
    const node = scan.sections
      .filter((s) => s.startLine < line && line < s.endLine)
      .flatMap((s) => [...walk(s.nodes)])
      .find((n) => n.lines.from === line);
    if (node === undefined) continue;
    const prefix = lead.slice(0, at);
    for (let i = line + 1; i <= subtreeEnd(node); i++) {
      if (touched.has(i)) continue;
      const own = lines[i]?.text ?? "";
      if (own.trim() === "") continue;
      const s = starts[i] as number;
      const where = own.startsWith(prefix) ? prefix.length : 0;
      if (removed === "") extra.push({ from: s + where, to: s + where, insert: c.insert });
      else if (own.startsWith(removed, where))
        extra.push({ from: s + where, to: s + where + removed.length, insert: "" });
      else if (own.startsWith(removed)) extra.push({ from: s, to: s + removed.length, insert: "" });
      touched.add(i);
    }
  }
  return extra.length === 0 ? null : [...changes, ...extra].sort((x, y) => x.from - y.from);
}

function* walk(nodes: readonly SectionNode[]): Generator<SectionNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

/** A binding comment alone on its line (a Task's ref line, a node marker). */
const BINDING_LINE = /^[ \t]*<!--[ \t]+(?:lfcp-ref:|lfcp-node:)[^>]*-->[ \t]*$/;
/** A list item's line. */
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;

/**
 * A paste of whole lines with bindings that runs into the text around it in
 * a section (the owner's check of 0.4.0-beta.10 on macOS, M1): a Task and its
 * ref line selected without the trailing newline, cut, and pasted at the
 * start of another Task's line, glue the ref to that line ("<!-- lfcp-ref …
 * -->- [ ] Beta"); pasted at the end of a line, the Task's line runs on from
 * it. The pasted lines go on lines of their own: a line break after a paste
 * that ends with a binding line, before one that starts with a list line.
 * Null when the paste stands as it is.
 */
export function pasteOnOwnLines(before: string, change: TextChange): TextChange | null {
  if (!change.insert.includes("<!--") || !change.insert.includes("\n")) return null;
  const lines = splitLines(before);
  const starts = lineStarts(lines);
  const lineOf = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && (starts[i + 1] as number) <= pos) i++;
    return i;
  };
  const a = lineOf(change.from);
  const b = lineOf(change.to);
  if (sectionAround(before, a, b) === undefined) return null;
  const pre = before.slice(starts[a], change.from);
  const post = before.slice(change.to, (starts[b] as number) + (lines[b]?.text.length ?? 0));
  const pasted = splitLines(change.insert);
  const firstLine = pasted[0]?.text ?? "";
  const lastLine = pasted.at(-1)?.text ?? "";
  const eol = pasted.find((l) => l.eol !== "")?.eol ?? "\n";
  const lastIsBinding = pasted.at(-1)?.eol === "" && BINDING_LINE.test(lastLine);
  const after = lastIsBinding && post.trim() !== "";
  const before_ =
    pre.trim() !== "" &&
    LIST_LINE.test(firstLine) &&
    pasted.some((l) => parseNodeMarker(l.text) !== null || BINDING_LINE.test(l.text));
  if (!after && !before_) return null;
  return {
    from: change.from,
    to: change.to,
    insert: `${before_ ? eol : ""}${change.insert}${after ? eol : ""}`,
  };
}
