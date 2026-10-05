// ST-2 (LFCP-061): a child-line ref can slide under the wrong Task. The
// common case: the user presses Enter at the end of a shared Task's line,
// so a new Task line lands between the Task and its child ref:
//
//   - [ ] Prepare API contract        - [ ] Prepare API contract
//     <!-- lfcp-ref: … -->      →     - [ ] (new)
//                                       <!-- lfcp-ref: … -->
//
// MARKDOWN-REFS-01 then binds the ref to the new Task, whose text would
// overwrite the shared title. The adapter never rebinds silently: when the
// Task just above the ref's new owner is a local Task whose title matches
// the Shared Object and the owner's does not, it sends nothing for that
// ref, reports REF_REASSOCIATION_SUSPECTED and offers a repair that moves
// the ref line back under the matching Task.

import { joinLines, splitLines } from "../refs/lines";
import type { MarkdownProjectionRef, TaskState } from "../refs/scanner";
import { parseTaskText } from "./task-text";

/** Moves the ref line `from` so it sits right after Task line `after`. */
export interface MoveRefRepair {
  readonly kind: "move-ref";
  readonly from: number;
  readonly after: number;
}

/**
 * The repair, if the projection's ref looks re-associated: the owner is a
 * child-placement Task whose title differs from the shared one, and the
 * Task line right above it is local with exactly the shared title.
 */
export function suspectReassociation(
  projection: MarkdownProjectionRef,
  tasks: readonly TaskState[],
  sharedTitle: string,
): MoveRefRepair | null {
  if (projection.placement !== "child") return null;
  if (parseTaskText(projection.taskText).title === sharedTitle) return null;
  const above = tasks.find((t) => t.task.line === projection.taskLine - 1);
  if (above === undefined || above.binding !== "local") return null;
  if (parseTaskText(above.taskText).title !== sharedTitle) return null;
  return { kind: "move-ref", from: projection.refLine, after: above.task.line };
}

/** Applies a repair to the Markdown, keeping every line ending (CRLF or LF). */
export function applyRepair(markdown: string, repair: MoveRefRepair): string {
  const lines = splitLines(markdown);
  const { from, after } = repair;
  if (from <= after || from >= lines.length) return markdown;
  const last = from === lines.length - 1;
  const moved = lines[from] as { text: string; eol: string };
  // A last line without an ending gets the ending of the line before it;
  // that line then becomes the last one and ends the text as before.
  const eol = last ? (lines[from - 1]?.eol ?? "\n") : moved.eol;
  const rest = lines.filter((_, i) => i !== from);
  if (last) {
    const before = rest[from - 1] as { text: string; eol: string };
    rest[from - 1] = { text: before.text, eol: moved.eol };
  }
  rest.splice(after + 1, 0, { text: moved.text, eol });
  return joinLines(rest);
}
