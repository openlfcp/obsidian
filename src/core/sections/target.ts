// The target of a section action, captured when the action starts
// (LFCP-03-009, F-06, F-07; UX contract 0.3 §4): the note (its path, held
// as one identity by NoteTargets while the flow runs), its text and
// revision then, the editor mode, the cursor and the selection. The flow
// works from this snapshot, never from a live editor: switching tabs or
// notes, or focus moving to a pane, does not move it. Before each side
// effect the executor reads the note again through the host adapter and
// checks it against the snapshot (`invalidation`).
//
// "Share section…" with a selection shares exactly the selected lines when
// they are an eligible range (§4.2), else it is refused with one reason and,
// where the contract gives one, an explicit fallback that opens a new
// preview. Nothing here widens a selection by itself (S1). Pure: no
// Obsidian, no I/O.

import { contentHash } from "../projection/guard";
import { isBlank, splitLines } from "../refs/lines";
import {
  DAMAGED_BOUNDARY_TEXT,
  preflight,
  proposeRange,
  type ShareProblem,
  type ShareRange,
} from "./share";

/** A position in a note: 0-based line, UTF-16 column. */
export interface TextPos {
  readonly line: number;
  readonly ch: number;
}

/** One selection range as the editor reports it (anchor where it began, head where it ends). */
export interface TextSelection {
  readonly anchor: TextPos;
  readonly head: TextPos;
}

/** Source and Live Preview edit the note; Reading view does not (T4). */
export type EditorMode = "source" | "live-preview" | "reading";

/** What the editor adapter reads when an action starts: a snapshot, not a handle on the editor. */
export interface TargetCapture {
  /** The note's path when the action started. */
  readonly path: string;
  /** The note's text then, unsaved changes included. */
  readonly text: string;
  readonly mode: EditorMode;
  /** 0-based line of the cursor (the main selection's head). */
  readonly cursorLine: number;
  /** Every selection range, empty ones included; [] when the editor reports none. */
  readonly selections: readonly TextSelection[];
  /** An input method is composing: the text holds a transient composition (IME). */
  readonly composing: boolean;
}

/** A captured target with its revision (SHA-256 of `text`), as the executor checks it. */
export interface CapturedTarget extends TargetCapture {
  readonly revision: string;
}

export const captured = (c: TargetCapture): CapturedTarget => ({
  ...c,
  revision: contentHash(c.text),
});

/**
 * Why a captured target no longer holds (P3, T3): the executor stops
 * before any side effect and says so.
 */
export type TargetInvalidation =
  /** The note was deleted: nothing is written at its old path. */
  | "deleted"
  /** The note's text is not the captured one. */
  | "changed"
  /** An input method is composing in the note: its text is not final yet. */
  | "composing"
  /** The note is shown in Reading view: a source-changing action opens it for editing first. */
  | "reading";

/** The note as the host adapter reads it now (open editor first, else the file), or null when gone. */
export interface NoteNow {
  readonly text: string;
  /** Whether it is open in an editor (Source or Live Preview). */
  readonly open: boolean;
  readonly composing: boolean;
}

/**
 * Whether `target`, now at `path` (null once deleted) and read as `now`,
 * still holds: null when it does, else why not. `exact` false skips the
 * text check (a flow whose own revalidation decides, e.g. a moved range).
 */
export function invalidation(
  target: CapturedTarget,
  path: string | null,
  now: NoteNow | null,
  exact = true,
): TargetInvalidation | null {
  if (path === null || now === null) return "deleted";
  if (now.composing) return "composing";
  if (exact && contentHash(now.text) !== target.revision) return "changed";
  return null;
}

/** The capture itself refuses a source-changing action: Reading view, or a composition under way. */
export function captureRefusal(c: TargetCapture): TargetInvalidation | null {
  if (c.mode === "reading") return "reading";
  if (c.composing) return "composing";
  return null;
}

/** What a refused action says, in the user's words; `action` is "shared", "inserted", … */
export function invalidationText(reason: TargetInvalidation, nothing: string): string {
  switch (reason) {
    case "deleted":
      return `Shared Tasks: the note was deleted. Nothing was ${nothing}.`;
    case "changed":
      return `Shared Tasks: the note changed since you started. Nothing was ${nothing}; try again.`;
    case "composing":
      return `Shared Tasks: finish typing first (text is still being composed). Nothing was ${nothing}.`;
    case "reading":
      return `Shared Tasks: open the note for editing first (it is in Reading view). Nothing was ${nothing}.`;
  }
}

/** Why a selection is not an exact eligible range (UX contract §4.2). */
export type SelectionReason =
  | "no-heading-start"
  | "partial-line"
  | "crossing"
  | "nested-heading"
  | "partial-block"
  | "unclosed-fence"
  | "already-bound"
  | "legacy-tasks"
  | "broken-ref"
  | "damaged-boundary"
  | "multiple-selections"
  | "heading-only";

/** What "Share section…" acts on, from the cursor or the selection. */
export type ShareScope =
  /** No selection: the heading at or above the cursor proposes its section (0.4.0). */
  | { readonly kind: "heading"; readonly range: ShareRange }
  /** No selection and no heading at or above the cursor. */
  | { readonly kind: "no-heading" }
  /** An exact eligible selection: previewed and shared as it is. */
  | { readonly kind: "exact"; readonly range: ShareRange }
  /**
   * An ineligible selection. `line` (0-based) is the line the reason names.
   * `fallback` is the whole heading section "Share the whole section…"
   * proposes, previewed anew (S2); `range` is the selection's own range
   * when it has one (legacy-tasks: the explicit import of that range).
   */
  | {
      readonly kind: "ineligible";
      readonly reason: SelectionReason;
      readonly line: number | null;
      readonly fallback: ShareRange | null;
      readonly range: ShareRange | null;
    };

const before = (a: TextPos, b: TextPos) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

/** The heading at or above `line` and its proposed range, or null. */
function headingAbove(markdown: string, line: number): ShareRange | null {
  for (let l = line; l >= 0; l--) {
    const r = proposeRange(markdown, l);
    if (r !== null) return r;
  }
  return null;
}

/** Which problem a selection names when the preflight reports several (the most protective first). */
const PROBLEM_ORDER: readonly ShareProblem["code"][] = [
  "DAMAGED_BOUNDARY",
  "ALREADY_BOUND",
  "BROKEN_REF",
  "UNCLOSED_FENCE",
  "NESTED_HEADING",
  "PARTIAL_BLOCK",
  "LEGACY_SHARED_TASKS",
];
const REASON_OF: Record<ShareProblem["code"], SelectionReason> = {
  NOT_A_HEADING: "no-heading-start",
  NESTED_HEADING: "nested-heading",
  UNCLOSED_FENCE: "unclosed-fence",
  PARTIAL_BLOCK: "partial-block",
  ALREADY_BOUND: "already-bound",
  LEGACY_SHARED_TASKS: "legacy-tasks",
  BROKEN_REF: "broken-ref",
  DAMAGED_BOUNDARY: "damaged-boundary",
};

/**
 * What "Share section…" acts on in `markdown`, given the cursor and the
 * selections (UX contract §4.2). A non-empty selection is exact and
 * eligible only when it starts at a heading, ends after the last non-blank
 * character of a line (or at column 0 of the next line, which ends it on
 * the line before), stays inside that heading's section and has no
 * preflight problem. Trailing blank lines are trimmed. Never widened.
 */
export function shareScope(
  markdown: string,
  cursorLine: number,
  selections: readonly TextSelection[],
): ShareScope {
  const chosen = selections.filter(
    (s) => s.anchor.line !== s.head.line || s.anchor.ch !== s.head.ch,
  );
  if (chosen.length === 0) {
    const range = headingAbove(markdown, cursorLine);
    return range === null ? { kind: "no-heading" } : { kind: "heading", range };
  }
  const refused = (
    reason: SelectionReason,
    line: number | null,
    fallback: ShareRange | null = null,
    range: ShareRange | null = null,
  ): ShareScope => ({ kind: "ineligible", reason, line, fallback, range });
  if (chosen.length > 1) return refused("multiple-selections", null);
  const s = chosen[0] as TextSelection;
  const [from, to] = before(s.head, s.anchor) ? [s.head, s.anchor] : [s.anchor, s.head];
  const lines = splitLines(markdown);
  // Column 0 of a later line ends the selection on the line before (rule 2).
  const atLineStart = to.ch === 0 && to.line > from.line;
  let last = atLineStart ? to.line - 1 : to.line;
  const lastText = lines[last]?.text ?? "";
  const partialLine = !atLineStart && to.ch < lastText.replace(/[ \t]+$/, "").length;
  while (last > from.line && isBlank(lines[last]?.text ?? "")) last--;

  const own = proposeRange(markdown, from.line);
  if (own === null) {
    // Rule 1. The whole section only when one heading's section holds the whole selection.
    const around = headingAbove(markdown, from.line);
    const fallback = around !== null && around.lastLine >= last ? around : null;
    return refused("no-heading-start", from.line, fallback);
  }
  if (last > own.lastLine) {
    // The line it runs into: the first non-blank one after the section (the next heading).
    let next = own.lastLine + 1;
    while (next < last && isBlank(lines[next]?.text ?? "")) next++;
    return refused("crossing", next);
  }
  if (partialLine) return refused("partial-line", last, own);
  // S7 (owner D13): the heading alone, over a section with a body, is not an empty section.
  if (last === from.line && own.lastLine > from.line)
    return refused("heading-only", from.line, own);
  const range: ShareRange = { headingLine: from.line, lastLine: last };
  const { problems } = preflight(markdown, range);
  for (const code of PROBLEM_ORDER) {
    const p = problems.find((x) => x.code === code);
    if (p === undefined) continue;
    const line = "line" in p ? p.line : (p.lines[0] ?? null);
    if (code === "PARTIAL_BLOCK") return refused("partial-block", line, own);
    if (code === "LEGACY_SHARED_TASKS") return refused("legacy-tasks", line, null, range);
    return refused(REASON_OF[code], line);
  }
  return { kind: "exact", range };
}

/** The reason's sentence (UX contract §4.2), the same on the pane and in the preview. */
export function selectionReasonText(reason: SelectionReason, line: number | null): string {
  const n = (line ?? 0) + 1;
  switch (reason) {
    case "no-heading-start":
      return "A shared section starts at its heading. Your selection does not.";
    case "partial-line":
      return "The selection ends in the middle of a line. Select whole lines.";
    case "crossing":
      return "The selection runs past the end of the heading's section.";
    case "nested-heading":
      return `Line ${n} is a heading inside the selection. Share each part as its own section.`;
    case "partial-block":
      return `The selection ends in the middle of a paragraph or list item (line ${n}). End it at a blank line.`;
    case "unclosed-fence":
      return `A code block from line ${n} is not closed. Close it before sharing.`;
    case "already-bound":
      return `Line ${n} is already part of a shared section.`;
    case "legacy-tasks":
      return "Tasks in the selection are already shared in another collaboration.";
    case "broken-ref":
      return `The shared task marker on line ${n} is damaged. Repair it before sharing.`;
    case "damaged-boundary":
      return DAMAGED_BOUNDARY_TEXT(line ?? 0);
    case "multiple-selections":
      return "Several parts of the note are selected. Select one range of lines.";
    case "heading-only":
      return "Only the heading is selected. Select the lines to share with it.";
  }
}

/** The explicit fallback's label (UX contract §3, `share-whole-section`). */
export const SHARE_WHOLE_SECTION = "Share the whole section…";
