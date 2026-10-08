// Task field edits inside shared sections: the 0.1 field planner
// (projection/intents.ts) on section Tasks. A Task in a section is the same
// Shared Objects Task as in 0.1 (SSP §2), with the same owned fields and
// the same local pieces (🔁, unowned priority, an unowned glyph); only the
// planner's inputs come from the section's base instead of 0.1's.

import type { PrincipalId } from "@openlfcp/core";
import type { TaskView } from "@openlfcp/shared-objects";
import { planShare } from "../collab/markdown";
import { type FieldIssue, planIntents, type Represented } from "../projection/intents";
import { parseTaskText, statusOfGlyph } from "../projection/task-text";
import { scanRefs } from "../refs";
import { parseTaskLine } from "../refs/scanner";
import type { SectionState } from "./base";
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

/** A new section Task from its line, as 0.1 shares one (planShare's fields). */
export function newSectionTask(line: string, principal: PrincipalId, id: string): NewSectionTask {
  const state = scanRefs(line).tasks[0];
  if (state === undefined) throw new Error("not a Task line");
  const create = planShare(state, principal, id as never).intents[0];
  if (create?.intent !== "task.create") throw new Error("no task.create");
  return create.task;
}
