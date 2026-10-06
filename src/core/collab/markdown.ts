// The Markdown side of the collaboration commands (LFCP-065): which Task
// is under the cursor, the task.create intent a local Task line means,
// a fresh projection line for "Insert shared object", attaching a new ref,
// and detaching one. Pure: text in, text out, every line ending kept.
//
// Parsing is LFCP-061's (task-text.ts, the refs scanner); rendering is
// LFCP-062's (render.ts renderNewTaskLine). Nothing here talks to the network or the SDK's
// protocol layers.

import { generateObjectId, type ObjectId, type PrincipalId } from "@openlfcp/core";
import {
  createTask,
  type NewTask,
  type ReplicaIntent,
  type Task,
  type TaskStatus,
} from "@openlfcp/shared-objects";
import { lineWarnings } from "../projection/intents";
import { parseTaskText, statusOfGlyph } from "../projection/task-text";
import { attachRef, type ObjectRef, scanRefs } from "../refs";
import { splitLines } from "../refs/lines";
import type { MarkdownProjectionRef, TaskState } from "../refs/scanner";
import type { RefPlacement } from "../settings";

/** What sits on a line of a note, for the Task commands. */
export type TaskAt =
  | { readonly kind: "none" }
  /** A Task without a ref: it can be shared. */
  | { readonly kind: "local"; readonly state: TaskState }
  /** A Task with exactly one valid ref. */
  | { readonly kind: "bound"; readonly state: TaskState; readonly ref: MarkdownProjectionRef }
  /** A Task whose ref is malformed, duplicated or misplaced: nothing may act on it. */
  | { readonly kind: "blocked"; readonly state: TaskState };

/**
 * The Task the cursor is on: the Task line itself, or its child ref line.
 * `line` is 0-based.
 */
export function taskAt(markdown: string, line: number): TaskAt {
  const scan = scanRefs(markdown);
  const viaRef = scan.projections.find((p) => p.refLine === line && p.placement === "child");
  const taskLine = viaRef?.taskLine ?? line;
  const state = scan.tasks.find((t) => t.task.line === taskLine);
  if (state === undefined) return { kind: "none" };
  if (state.binding === "local") return { kind: "local", state };
  if (state.binding === "blocked") return { kind: "blocked", state };
  const ref = scan.projections.find((p) => p.taskLine === taskLine);
  return ref === undefined ? { kind: "blocked", state } : { kind: "bound", state, ref };
}

/** A local Task line as Shared Objects intents: task.create, then a completion date if any. */
export interface SharePlan {
  readonly objectId: ObjectId;
  readonly intents: readonly ReplicaIntent[];
  /** What the shared Task will not carry, or carries publicly (ST-4, ST-5). */
  readonly warnings: readonly string[];
}

/**
 * The intents that share `state` (a local Task) as a new Task created by
 * `createdBy`. What LFCP-061 owns is shared; unowned pieces (🔼, 🛫, ➕,
 * ❌, 🔁, an unowned glyph, a ^block-id) stay local in the Markdown.
 * `createdAt` (RFC 3339 UTC) becomes the Task's `created_at`, which orders
 * "Insert all tasks from collaboration".
 * Throws when the line has no title, or (ProfileError) cannot be a valid Task.
 */
export function planShare(
  state: TaskState,
  createdBy: PrincipalId,
  objectId: ObjectId = generateObjectId(),
  createdAt?: string,
): SharePlan {
  const parsed = parseTaskText(state.taskText);
  if (parsed.title === "") throw new Error("The task has no title to share.");
  const owned = statusOfGlyph(state.task.status);
  const status: TaskStatus = owned ?? "todo";
  const warnings = lineWarnings(parsed).map((w) => w.message);
  if (owned === null)
    warnings.push(
      `The checkbox [${state.task.status}] has no shared status; the shared task starts as "todo".`,
    );
  if (parsed.priority === "unowned")
    warnings.push("This priority has no shared equivalent; the shared task starts as normal.");
  for (const field of parsed.ambiguous)
    warnings.push(`The task has more than one ${field} value; none is shared.`);
  const input: NewTask = {
    id: objectId,
    title: parsed.title,
    createdBy,
    ...(createdAt === undefined ? {} : { createdAt }),
    status,
    ...(parsed.priority === "unowned" ? {} : { priority: parsed.priority }),
    ...(parsed.due === null ? {} : { due: parsed.due }),
    ...(parsed.scheduled === null ? {} : { scheduled: parsed.scheduled }),
    ...(parsed.tags.length === 0 ? {} : { tags: parsed.tags }),
  };
  const intents: ReplicaIntent[] = [createTask(input).intent];
  // ✅ is a completion date only on a done Task (ST-5).
  if (parsed.completion !== null) {
    if (status === "done")
      intents.push({ intent: "task.complete", id: objectId, completionDate: parsed.completion });
    else warnings.push("The ✅ date is kept local: the task is not done.");
  }
  return { objectId, intents, warnings };
}

/**
 * Attach `ref` to the Task whose line text is `taskText` (the line as it
 * was read), at or nearest `near`: the note may have changed while the
 * object was being created. Null when that Task is gone or no longer local.
 */
export function attachToTask(
  markdown: string,
  lineText: string,
  near: number,
  ref: ObjectRef,
  placement: RefPlacement,
): string | null {
  const lines = splitLines(markdown);
  const candidates = scanRefs(markdown)
    .tasks.filter((t) => t.binding === "local" && lines[t.task.line]?.text === lineText)
    .map((t) => t.task.line)
    .sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b);
  const line = candidates[0];
  return line === undefined ? null : attachRef(markdown, line, ref, placement);
}

/** The renderer's name for a placement setting (render.ts renderNewTaskLine). */
export const unitPlacement = (p: RefPlacement): "inline" | "child" =>
  p === "inline" ? "inline" : "child";

/**
 * Detach a projection (LFCP-065, MARKDOWN-REFS-01 §18): remove exactly the
 * ref's bytes and nothing else.
 *
 * - Inline: the comment and the single separator before it. Trailing
 *   whitespace after the comment and any further spacing stay.
 * - Child line: the whole line with its line ending. When the ref line is
 *   the note's last line and has no ending, the line ending before it goes
 *   instead, so a note ends as it did before the ref was attached.
 *
 * The visible Task, its line ending style (LF, CRLF, CR) and every other
 * byte are untouched. The Shared Object is not changed.
 */
export function detachExact(markdown: string, p: MarkdownProjectionRef): string {
  const c = p.comment;
  if (p.placement === "inline") {
    const separated = p.parts.taskGap.length > 0 ? 1 : 0;
    return markdown.slice(0, c.offsetStart - separated) + markdown.slice(c.offsetEnd);
  }
  const lines = splitLines(markdown);
  const ref = lines[p.refLine];
  if (ref === undefined) throw new Error("the ref line is outside the note");
  const lineStart = c.offsetStart - c.start;
  const lineEnd = lineStart + ref.text.length + ref.eol.length;
  if (ref.eol === "" && p.refLine > 0) {
    const before = (lines[p.refLine - 1] as { eol: string }).eol.length;
    return markdown.slice(0, lineStart - before) + markdown.slice(lineEnd);
  }
  return markdown.slice(0, lineStart) + markdown.slice(lineEnd);
}

/** A Task as rendered (helper for messages): its title, or a placeholder. */
export const titleOf = (task: Task | undefined): string => task?.title ?? "(unknown task)";
