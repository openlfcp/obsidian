// A recurring Task's next occurrence written by the Obsidian Tasks plugin
// (MARKDOWN-SECTIONS-01 §4.1, host fact H8, MS43): completing a recurring
// Task whose inline ref precedes its fields, the Tasks plugin inserts the
// next occurrence on a new line with a copy of the ref, in the same edit
// that marks the original done. That copy is new content, not a second
// occurrence of the Task: its ref is removed, so the new line gets a new
// identity in the configured placement and is published as a new Task;
// the completed Task keeps its ref. Only for an external plugin edit (no
// editor userEvent); any other copy stays NODE_BINDING_DUPLICATE.

import { statusOfGlyph } from "../projection/task-text";
import { splitLines } from "../refs/lines";
import type { SectionState } from "./base";
import { type ParsedSection, scanSectionRefs } from "./parser";
import { type DocChange, lineStarts } from "./source-map";

/** The changes that strip the copied ref from a recurring Task's next occurrence in `section`. */
export function recurringCopyRepair(
  markdown: string,
  section: ParsedSection,
  base: SectionState,
): DocChange[] {
  const scan = scanSectionRefs(markdown);
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const glyphAt = (line: number) => scan.tasks.find((t) => t.task.line === line)?.task.status;
  const byId = new Map<string, (typeof scan.projections)[number][]>();
  for (const p of scan.projections)
    if (p.taskLine > section.startLine && p.taskLine < section.endLine)
      byId.set(p.objectId, [...(byId.get(p.objectId) ?? []), p]);
  const out: DocChange[] = [];
  for (const [id, group] of byId) {
    if (group.length !== 2) continue;
    // The Task was open at the base, and this edit completed it.
    const was = base.nodes[id]?.line;
    const wasGlyph = was === undefined ? undefined : /\[(.)\]/.exec(was)?.[1];
    if (wasGlyph === undefined || statusOfGlyph(wasGlyph) === "done") continue;
    const done = group.filter((p) => statusOfGlyph(glyphAt(p.taskLine) ?? " ") === "done");
    const open = group.filter((p) => statusOfGlyph(glyphAt(p.taskLine) ?? " ") !== "done");
    const copy = open[0];
    if (done.length !== 1 || open.length !== 1 || copy === undefined) continue;
    const at = starts[copy.refLine] ?? 0;
    if (copy.placement === "inline") {
      // The comment and the whitespace before it.
      const from = at + copy.comment.start - copy.parts.taskGap.length;
      out.push({ from, to: at + copy.comment.end, insert: "" });
    } else {
      out.push({ from: at, to: starts[copy.refLine + 1] ?? markdown.length, insert: "" });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}
