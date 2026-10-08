// The canonical inline form inside a shared section (MARKDOWN-SECTIONS-01
// §4.1, host fact H8, MS45): the Task text, the ref, then the Tasks fields.
// An inline ref at the end of a line after Tasks fields is valid but hides
// those fields from the Tasks plugin, so the adapter moves it before them
// when the line is idle. A source rewrite only: nothing is published.

import { fieldsStart } from "../projection/task-text";
import { parseTaskLine } from "../refs/scanner";

const REF_AT_END = /([ \t]*)(<!--[ \t]+lfcp-ref:[^>]*-->)([ \t]*)$/;

/** The line with its end-of-line inline ref moved before its Tasks fields, or null (nothing to move). */
export function canonicalInline(line: string): string | null {
  const task = parseTaskLine(line, 0);
  if (task === undefined) return null;
  const m = REF_AT_END.exec(line);
  if (m === null || m.index < task.textStart) return null;
  const text = line.slice(task.textStart, m.index);
  const at = fieldsStart(text);
  if (at >= text.trimEnd().length) return null;
  return `${line.slice(0, task.textStart)}${text.slice(0, at)} ${m[2]}${text.slice(at).trimEnd()}${m[3] ?? ""}`;
}
