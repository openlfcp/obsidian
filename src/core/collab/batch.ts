// Many Tasks at once (POST-018): which Task lines "Share selected tasks"
// acts on, attaching all their refs in one write, and which Tasks "Insert
// all tasks from collaboration" adds to a note. Pure: text in, text out,
// every line ending kept. No protocol change: each Task is still its own
// Shared Object; a section or a list stays local presentation.

import type { ResourceId } from "@openlfcp/core";
import { parseTaskText } from "../projection/task-text";
import { type ObjectRef, scanRefs } from "../refs";
import { splitLines } from "../refs/lines";
import type { TaskState } from "../refs/scanner";
import type { RefPlacement } from "../settings";
import { attachToTask } from "./markdown";

/** The most Tasks one command shares or inserts; above it, nothing is written. */
export const MAX_BATCH = 200;

/** 0-based lines, both ends included. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** The ATX heading level of each line (0: not a heading), outside fences and front matter. */
function headingLevels(markdown: string): number[] {
  const lines = splitLines(markdown);
  let fence: { char: string; length: number } | undefined;
  let frontMatter = lines[0]?.text === "---";
  return lines.map(({ text }, i) => {
    if (frontMatter) {
      if (i > 0 && (text === "---" || text === "...")) frontMatter = false;
      return 0;
    }
    if (fence !== undefined) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (close?.[1]?.[0] === fence.char && (close[1]?.length ?? 0) >= fence.length)
        fence = undefined;
      return 0;
    }
    const open = FENCE.exec(text);
    if (open !== null && !(open[1]?.startsWith("`") && open[2]?.includes("`"))) {
      fence = { char: open[1]?.[0] ?? "`", length: open[1]?.length ?? 3 };
      return 0;
    }
    return ATX.exec(text)?.[1]?.length ?? 0;
  });
}

/**
 * The section of the heading at or above `line`: the lines after it, down
 * to the next heading of the same or a higher level (or the end). Null when
 * no heading is at or above `line`. Headings in fenced code and front
 * matter do not count; only ATX headings (`#` … `######`) do.
 */
export function headingSection(markdown: string, line: number): LineRange | null {
  const levels = headingLevels(markdown);
  let at = Math.min(line, levels.length - 1);
  while (at >= 0 && (levels[at] ?? 0) === 0) at--;
  if (at < 0) return null;
  const level = levels[at] ?? 0;
  let end = at + 1;
  while (end < levels.length && ((levels[end] ?? 0) === 0 || (levels[end] ?? 0) > level)) end++;
  return { from: at + 1, to: end - 1 };
}

/** What "Share selected tasks" does with the Task lines of a range. */
export interface SharePlanBatch {
  /** Local Tasks to share, in note order (nested ones too: nesting stays local). */
  readonly share: readonly TaskState[];
  /** Tasks with a valid ref already: skipped. */
  readonly skipped: number;
  /** Tasks with a malformed or duplicated ref, or without a title: refused. */
  readonly refused: number;
}

/** The Task lines of `range` in `markdown`, sorted into share, skip and refuse. */
export function planBatchShare(markdown: string, range: LineRange): SharePlanBatch {
  const share: TaskState[] = [];
  let skipped = 0;
  let refused = 0;
  for (const state of scanRefs(markdown).tasks) {
    const line = state.task.line;
    if (line < range.from || line > range.to) continue;
    if (state.binding === "bound") skipped++;
    else if (state.binding === "blocked") refused++;
    else if (parseTaskText(state.taskText).title === "") refused++;
    else share.push(state);
  }
  return { share, skipped, refused };
}

/** A ref to attach: to the local Task whose line read `lineText` near line `near`. */
export interface PendingRef {
  readonly lineText: string;
  readonly near: number;
  readonly ref: ObjectRef;
}

/**
 * Attach every ref in one pass (one `vault.process`), bottom-up so that a
 * child-line ref never shifts a line still to be found. A Task that moved
 * is found by its text nearest its old line; one that is gone gets no ref.
 */
export function attachAll(
  markdown: string,
  pending: readonly PendingRef[],
  placement: RefPlacement,
): { readonly markdown: string; readonly attached: number } {
  let text = markdown;
  let attached = 0;
  for (const p of [...pending].sort((a, b) => b.near - a.near)) {
    const next = attachToTask(text, p.lineText, p.near, p.ref, placement);
    if (next !== null) {
      text = next;
      attached++;
    }
  }
  return { markdown: text, attached };
}

/** A collaboration's Task as "Insert all tasks from collaboration" orders it. */
export interface InsertCandidate {
  readonly objectId: string;
  /** RFC 3339 UTC, when the creator stamped one. */
  readonly createdAt?: string;
}

/**
 * The Tasks of collaboration `R` this note does not show yet, ordered by
 * `created_at` (unstamped first) and then Object ID (UUIDv7: creation order).
 */
export function tasksToInsert(
  markdown: string,
  R: ResourceId,
  tasks: readonly InsertCandidate[],
): InsertCandidate[] {
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const shown = new Set(
    scanRefs(markdown)
      .projections.filter((p) => same(p.resourceId, R))
      .map((p) => p.objectId),
  );
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return tasks
    .filter((t) => !shown.has(t.objectId))
    .sort((a, b) => cmp(a.createdAt ?? "", b.createdAt ?? "") || cmp(a.objectId, b.objectId));
}
