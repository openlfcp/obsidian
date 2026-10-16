// Task field edits inside shared sections: the 0.1 field planner
// (projection/intents.ts) on section Tasks. A Task in a section is the same
// Shared Objects Task as in 0.1 (SSP §2), with the same owned fields and
// the same local pieces (🔁, unowned priority, an unowned glyph); only the
// planner's inputs come from the section's base instead of 0.1's.

import type { PrincipalId } from "@openlfcp/core";
import type { TaskView } from "@openlfcp/shared-objects";
import { planShare } from "../collab/markdown";
import { type FieldIssue, planIntents, type Represented } from "../projection/intents";
import { type RenderTarget, renderProjectedLine } from "../projection/render";
import { parseTaskText, statusOfGlyph } from "../projection/task-text";
import { scanRefs } from "../refs";
import { splitLines } from "../refs/lines";
import { parseTaskLine } from "../refs/scanner";
import type { SectionState } from "./base";
import { type ParsedSection, type SectionNode, scanSectionRefs } from "./parser";
import type { NewSectionTask, TaskFieldIntent } from "./port";

/** An inline Task ref anywhere on the line (at the end, or before the Tasks fields). */
const INLINE_REF = /[ \t]*<!--[ \t]+lfcp-ref:[^>]*-->/;

/** What a Task line represents (0.1's terms), its inline ref left out; null when it is no Task. */
export function representLine(line: string): Represented | null {
  const task = parseTaskLine(line, 0);
  if (task === undefined) return null;
  const text = line.slice(task.textStart).replace(INLINE_REF, "").trimEnd();
  return { status: statusOfGlyph(task.status), text: parseTaskText(text) };
}

/**
 * The 0.1 intents for the section's Tasks whose line the user changed since
 * the base: three-way, so a field the user did not touch is never sent.
 */
export function planTaskFields(
  note: SectionState,
  base: SectionState,
  view: (taskId: string) => TaskView | undefined,
): { intents: TaskFieldIntent[]; issues: { taskId: string; issue: FieldIssue }[] } {
  const intents: TaskFieldIntent[] = [];
  const issues: { taskId: string; issue: FieldIssue }[] = [];
  for (const [id, n] of Object.entries(note.nodes)) {
    const was = base.nodes[id];
    if (n.kind !== "task" || n.line === undefined || was?.line === undefined) continue;
    if (n.line === was.line) continue;
    const now = representLine(n.line);
    if (now === null) continue;
    const plan = planIntents(now, view(id), representLine(was.line) ?? undefined);
    intents.push(...(plan.intents as TaskFieldIntent[]));
    for (const issue of plan.issues) issues.push({ taskId: id, issue });
  }
  return { intents, issues };
}

/** Whether two Task lines represent the same shared fields (status and owned fields). */
export function sameFields(a: Represented, b: Represented): boolean {
  const tags = (r: Represented) =>
    r.text.tags
      .map((t) => t.normalize("NFC"))
      .sort()
      .join(" ");
  return (
    a.status === b.status &&
    a.text.title === b.text.title &&
    a.text.due === b.text.due &&
    a.text.scheduled === b.text.scheduled &&
    a.text.completion === b.text.completion &&
    a.text.priority === b.text.priority &&
    tags(a) === tags(b)
  );
}

/** Whether a Task's shared object can be compared with a line: here, a valid Task, not deleted. */
export function comparableView(view: TaskView | undefined): boolean {
  return view?.status === "ready" && view.task !== undefined && view.task.lifecycle !== "deleted";
}

/**
 * Whether every bound Task of `section` shows its shared object (LFCP-03-043).
 *
 * Without a base, a note seeds one only when it shows the model (MS11):
 * then the next pass renders the model onto every line the base holds. A
 * Task's fields are not in the compared state (its line is), so they are
 * compared here: the model's object rendered onto the note's own line (its
 * format, inline ref, list marker and local pieces kept) must represent the
 * same fields as the line. A difference the renderer only formats (the
 * inline ref's place) is no difference; a title, checkbox or date the note
 * changed is one. An object that is not here or not a live, valid Task
 * cannot be compared: not shown either, so no base is guessed for it.
 */
export function tasksShowModel(
  markdown: string,
  section: ParsedSection,
  tasks: (taskId: string) => RenderTarget | undefined,
  /** Only these Tasks (LFCP-03-047: a pasted one); every Task when absent. */
  only?: ReadonlySet<string>,
): boolean {
  const lines = splitLines(markdown);
  const scan = scanSectionRefs(markdown);
  const refAt = new Map(scan.projections.map((p) => [p.taskLine, p]));
  const shows = (n: SectionNode): boolean => {
    if (n.kind !== "task" || n.id === null || (only !== undefined && !only.has(n.id))) return true;
    const target = tasks(n.id);
    if (target === undefined || !comparableView(target.view)) return false;
    const p = refAt.get(n.lines.from);
    const text = lines[n.lines.from]?.text;
    if (p === undefined || p.objectId !== n.id || text === undefined) return false;
    const rendered = renderProjectedLine(text, p, scan.tasks, target)?.line;
    if (rendered === undefined) return false;
    if (rendered === text) return true;
    const now = representLine(text);
    const model = representLine(rendered);
    return now !== null && model !== null && sameFields(now, model);
  };
  const all = (nodes: readonly SectionNode[]): boolean =>
    nodes.every((n) => shows(n) && all(n.children));
  return all(section.nodes);
}

/** A new section Task from its line, as 0.1 shares one (planShare's fields). */
export function newSectionTask(line: string, principal: PrincipalId, id: string): NewSectionTask {
  // The line alone, without its list: four or more spaces of indentation
  // would read as an indented code block, though a nested Task is one. The
  // indentation carries no field.
  const state = scanRefs(line.replace(/^[ \t]+/, "")).tasks[0];
  if (state === undefined) throw new Error("not a Task line");
  const create = planShare(state, principal, id as never).intents[0];
  if (create?.intent !== "task.create") throw new Error("no task.create");
  return create.task;
}
