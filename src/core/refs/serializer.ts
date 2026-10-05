// Writing refs (MARKDOWN-REFS-01 §6, §12, §18–§21, §28). Every edit touches
// only the lines it must and keeps every line ending as it was.

import { DEFAULT_SETTINGS, type RefPlacement } from "../settings";
import { joinLines, type Line, splitLines } from "./lines";
import { formatObjectRef, type ObjectRef } from "./object-ref";
import { type MarkdownProjectionRef, scanRefs, visualWidth } from "./scanner";

/** §6: the canonical comment, the same for both placements. */
export function formatRefComment(ref: ObjectRef): string {
  return `<!-- lfcp-ref: ${formatObjectRef(ref)} -->`;
}

/** The line ending to use for a new line: the text's first one, else "\n". */
function newlineOf(lines: readonly Line[]): string {
  return lines.find((l) => l.eol !== "")?.eol ?? "\n";
}

/**
 * Bind the Task on `taskLine` (0-based) to `ref`. Placement defaults to the
 * Obsidian default, child-line (§21, §28); `inline` appends the comment as
 * the last element of the Task line (§11). The Task must be unbound: an
 * existing valid, malformed or duplicate ref is never overwritten.
 */
export function attachRef(
  markdown: string,
  taskLine: number,
  ref: ObjectRef,
  placement: RefPlacement = DEFAULT_SETTINGS.refPlacement,
): string {
  const scan = scanRefs(markdown);
  const state = scan.tasks.find((t) => t.task.line === taskLine);
  if (!state) throw new Error(`line ${taskLine} is not a Task line`);
  if (state.binding !== "local") throw new Error(`the Task on line ${taskLine} already has a ref`);

  const lines = splitLines(markdown);
  const line = lines[taskLine] as Line;
  const comment = formatRefComment(ref);
  if (placement === "inline") {
    lines[taskLine] = { text: `${line.text.trimEnd()} ${comment}`, eol: line.eol };
  } else {
    // §12: the child line is indented to the Task's content column, reusing
    // the Task's own leading whitespace.
    const task = state.task;
    const pad = " ".repeat(task.contentColumn - visualWidth(task.indent));
    const eol = line.eol === "" ? newlineOf(lines) : line.eol;
    lines.splice(
      taskLine,
      1,
      { text: line.text, eol },
      { text: `${task.indent}${pad}${comment}`, eol: line.eol },
    );
  }
  return joinLines(lines);
}

/**
 * §18: detach a projection by removing its comment: the child line
 * (with its line ending), or the inline comment and the spaces before it.
 * The Shared Object is untouched.
 */
export function detachRef(markdown: string, projection: MarkdownProjectionRef): string {
  const lines = splitLines(markdown);
  if (projection.placement === "child") {
    const removed = lines[projection.refLine] as Line;
    lines.splice(projection.refLine, 1);
    // A removed last line passes its (missing) ending to the line before.
    const before = lines[projection.refLine - 1];
    if (removed.eol === "" && before && projection.refLine === lines.length) {
      lines[projection.refLine - 1] = { text: before.text, eol: "" };
    }
  } else {
    const line = lines[projection.taskLine] as Line;
    const head = line.text.slice(0, projection.comment.start).trimEnd();
    lines[projection.taskLine] = {
      text: head + line.text.slice(projection.comment.end),
      eol: line.eol,
    };
  }
  return joinLines(lines);
}

/**
 * Re-emit a projection unit in its original placement (§19, MR§29 case 14):
 * the Task line, and for child placement its line ending and the ref line,
 * byte for byte as parsed when `taskText` is the parsed one. The unit's
 * text is `markdown.slice(unit.offsetStart, unit.offsetEnd)`.
 */
export function emitUnit(
  projection: MarkdownProjectionRef,
  taskText = projection.taskText,
): string {
  const p = projection.parts;
  const comment = projection.comment.text;
  return projection.placement === "inline"
    ? p.taskHead + taskText + p.taskGap + comment + p.refTrail
    : p.taskHead + taskText + p.taskGap + p.taskEol + p.refIndent + comment + p.refTrail;
}

/**
 * Replace the Task's semantic text (after the checkbox) and keep the ref
 * where and as it is (§19, §20): the comment stays byte-identical in its
 * placement and only the Task text changes.
 */
export function replaceTaskText(
  markdown: string,
  projection: MarkdownProjectionRef,
  taskText: string,
): string {
  const { offsetStart, offsetEnd } = projection.unit;
  return (
    markdown.slice(0, offsetStart) + emitUnit(projection, taskText) + markdown.slice(offsetEnd)
  );
}
