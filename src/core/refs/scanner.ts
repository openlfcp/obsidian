// The `lfcp-ref` scanner (MARKDOWN-REFS-01 §4, §11–§17, §25–§27).
//
// Two passes over the physical lines: the first classifies each line
// (literal context, blockquote, Task, other) and finds its `lfcp-ref`
// comments; the second associates comments with Tasks and diagnoses the
// rest. The scanner takes text only: no file path, no server (§23, §24).
//
// Positions: lines are 0-based; `start`/`end` are UTF-16 offsets within the
// line's text (JS string indices, line ending excluded); `offsetStart` /
// `offsetEnd` are UTF-16 offsets in the whole input. A line ending (CRLF,
// LF or CR) belongs to the line before it and is never inside a range. See
// README.md for the adapter choices.

import { findRefComments, type RefComment } from "./comments";
import { indentWidth, isBlank, type Line, splitLines } from "./lines";
import type { ObjectRef } from "./object-ref";

/** §26: where the ref sits. */
export type Placement = "inline" | "child";

/** §27 codes, plus this adapter's own (the last two). */
export type RefDiagnosticCode =
  | "MALFORMED_LFCP_REF"
  | "DUPLICATE_LFCP_REF"
  | "ORPHAN_LFCP_REF"
  | "OBJECT_TYPE_MISMATCH"
  | "OBJECT_ID_INVALID"
  | "RESOURCE_ID_INVALID"
  /** A well-formed object type this adapter does not project (§9, §27). */
  | "OBJECT_TYPE_UNSUPPORTED"
  /** An inline comment followed by more text on the Task line (§11, §13.1 rule 4). */
  | "LFCP_REF_NOT_AT_LINE_END"
  /** A ref in a context this adapter does not bind, such as a blockquote. */
  | "LFCP_REF_UNSUPPORTED_CONTEXT";

/** A range on one line, also as offsets in the whole text. */
export interface Range {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly offsetStart: number;
  readonly offsetEnd: number;
}

export interface RefDiagnostic extends Range {
  readonly code: RefDiagnosticCode;
  /** The offending comment's exact text. */
  readonly text: string;
}

/** A recognized Markdown Task line (README, "Task lines"). */
export interface TaskLine {
  readonly line: number;
  /** Leading whitespace before the list marker. */
  readonly indent: string;
  /** The list marker: `-`, `*`, `+`, `1.` or `1)`. */
  readonly marker: string;
  /** The single character between the brackets. */
  readonly status: string;
  /** The visual column of `[`: the Task's content indentation (§12). */
  readonly contentColumn: number;
  /** Line column where the text after the checkbox starts. */
  readonly textStart: number;
}

/**
 * The exact pieces of a projection unit (§4), so it can be re-emitted byte
 * for byte in its original placement ([`emitUnit`](./serializer.ts)).
 */
export interface UnitParts {
  /** The Task line up to its text: indent, marker, checkbox, spaces. */
  readonly taskHead: string;
  /** Whitespace between the Task text and the inline comment, or at the end of the Task line. */
  readonly taskGap: string;
  /** Child placement: the Task line's ending and the ref line's indentation. */
  readonly taskEol: string;
  readonly refIndent: string;
  /** Whitespace after the comment on its line. */
  readonly refTrail: string;
}

/** §26: one valid projection, the same binding for either placement. */
export interface MarkdownProjectionRef extends ObjectRef {
  readonly placement: Placement;
  readonly taskLine: number;
  /** Equals taskLine for inline placement. */
  readonly refLine: number;
  /** The object reference as written. */
  readonly rawRef: string;
  /** The comment's exact text and range on refLine. */
  readonly comment: Range & { readonly text: string };
  /** Whether the comment's spacing is canonical (§6). */
  readonly canonical: boolean;
  /** The Task's semantic text: after the checkbox, without the inline comment (§5, §11). */
  readonly taskText: string;
  /** The whole unit: the Task line to the end of the comment's line, line ending excluded. */
  readonly unit: { readonly offsetStart: number; readonly offsetEnd: number };
  readonly parts: UnitParts;
}

/**
 * Each recognized Task and its binding state: `local` has no ref and must
 * never produce Shared Object mutations (§17); `bound` has exactly one valid
 * ref; `blocked` has a ref that is malformed, duplicated, misplaced or of an
 * unsupported type: it is neither shared nor local, and nothing may act on
 * it until the user repairs the Markdown.
 */
export interface TaskState {
  readonly task: TaskLine;
  readonly binding: "local" | "bound" | "blocked";
  /** The Task's semantic text, without any inline comment. */
  readonly taskText: string;
}

export interface ScanResult {
  readonly projections: MarkdownProjectionRef[];
  readonly diagnostics: RefDiagnostic[];
  readonly tasks: TaskState[];
}

/** The object types this adapter projects. */
export const SUPPORTED_TYPES: readonly string[] = ["task"];

const TASK = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([^\]])\](?=[ \t]|$)/;
const LIST_ITEM = /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]|$)/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const BLOCKQUOTE = /^[ \t]*>/;

/** The visual width of `prefix`, tabs advancing to the next multiple of 4. */
export function visualWidth(prefix: string): number {
  let w = 0;
  for (const c of prefix) w = c === "\t" ? w + 4 - (w % 4) : w + 1;
  return w;
}

export function parseTaskLine(text: string, line: number): TaskLine | undefined {
  const m = TASK.exec(text);
  if (!m) return undefined;
  const [all, indent = "", marker = "", , status = ""] = m;
  const bracket = all.length - 3;
  const after = /^[ \t]*/.exec(text.slice(all.length))?.[0] ?? "";
  return {
    line,
    indent,
    marker,
    status,
    contentColumn: visualWidth(text.slice(0, bracket)),
    textStart: all.length + after.length,
  };
}

/** A physical line's lexical kind (pass 1). */
export type LineKind = "literal" | "blockquote" | "task" | "other";
type Kind = LineKind;

interface Classified {
  readonly kind: Kind;
  readonly refs: RefComment[];
  readonly task: TaskLine | undefined;
}

/**
 * Pass 1: literal contexts (§13.2 rule 5, §25: fences, front matter,
 * multi-line HTML and Obsidian comments, top-level indented code),
 * blockquotes and Tasks.
 */
function classify(lines: readonly Line[]): Classified[] {
  const out: Classified[] = [];
  let fence: { char: string; length: number } | undefined;
  let frontMatter = lines[0]?.text === "---";
  let htmlComment = false;
  let obsidianComment = false;
  let inList = false;
  let previousBlankOrCode = true;
  const literal: Classified = { kind: "literal", refs: [], task: undefined };

  lines.forEach(({ text }, i) => {
    if (frontMatter) {
      if (i > 0 && (text === "---" || text === "...")) frontMatter = false;
      out.push(literal);
      return;
    }
    if (fence) {
      // An unterminated fence stays open to the end of the text.
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (close && close[1]?.[0] === fence.char && (close[1]?.length ?? 0) >= fence.length)
        fence = undefined;
      out.push(literal);
      return;
    }
    if (htmlComment) {
      if (text.includes("-->")) htmlComment = false;
      out.push(literal);
      return;
    }
    if (obsidianComment) {
      if (text.includes("%%")) obsidianComment = false;
      out.push(literal);
      return;
    }
    const open = FENCE_OPEN.exec(text);
    if (open && !(open[1]?.startsWith("`") && open[2]?.includes("`"))) {
      fence = { char: open[1]?.[0] ?? "`", length: open[1]?.length ?? 3 };
      out.push(literal);
      return;
    }
    if (isBlank(text)) {
      previousBlankOrCode = true;
      out.push({ kind: "other", refs: [], task: undefined });
      return;
    }
    // A top-level indented code block: 4+ columns after a blank line,
    // outside a list.
    if (!inList && previousBlankOrCode && indentWidth(text) >= 4) {
      out.push(literal);
      return;
    }
    previousBlankOrCode = false;
    if (LIST_ITEM.test(text)) inList = true;
    else if (indentWidth(text) === 0) inList = false;

    const { refs, opensComment, opensObsidianComment } = findRefComments(text);
    if (opensComment) htmlComment = true;
    if (opensObsidianComment) obsidianComment = true;
    if (BLOCKQUOTE.test(text)) {
      out.push({ kind: "blockquote", refs, task: undefined });
      return;
    }
    const task = parseTaskLine(text, i);
    out.push({ kind: task ? "task" : "other", refs, task });
  });
  return out;
}

/**
 * The lexical kind of each line, as this scanner sees it: "literal" inside
 * fences, front matter, indented code and multi-line HTML or Obsidian
 * comments. For other parsers of the same note (shared sections), so that
 * both agree on what is live Markdown.
 */
export function lineKinds(lines: readonly Line[]): LineKind[] {
  return classify(lines).map((c) => c.kind);
}

/** A line holding exactly one `lfcp-ref` comment and only whitespace besides. */
function refOnly(text: string, c: Classified): RefComment | undefined {
  const [only] = c.refs;
  if (c.kind !== "other" || c.refs.length !== 1 || !only) return undefined;
  return isBlank(text.slice(0, only.start) + text.slice(only.end)) ? only : undefined;
}

/** Scan a Markdown text for `lfcp-ref` projections and diagnostics. */
export function scanRefs(markdown: string): ScanResult {
  const lines = splitLines(markdown);
  const lineStart: number[] = [];
  lines.reduce((offset, l) => {
    lineStart.push(offset);
    return offset + l.text.length + l.eol.length;
  }, 0);
  const range = (line: number, start: number, end: number): Range => ({
    line,
    start,
    end,
    offsetStart: (lineStart[line] ?? 0) + start,
    offsetEnd: (lineStart[line] ?? 0) + end,
  });

  const kinds = classify(lines);
  const projections: MarkdownProjectionRef[] = [];
  const diagnostics: RefDiagnostic[] = [];
  const tasks: TaskState[] = [];
  const consumed = new Set<RefComment>();
  const diagnose = (code: RefDiagnosticCode, line: number, c: RefComment) =>
    diagnostics.push({ code, text: c.text, ...range(line, c.start, c.end) });

  kinds.forEach((k, i) => {
    const task = k.task;
    if (k.kind !== "task" || !task) return;
    const text = lines[i]?.text ?? "";

    // §13.2 and MR-A3, normative since baseline.5: the unbroken run of ref-only lines
    // directly under the Task, with compatible indentation (README: from
    // the content column up to content column + 3), is the Task's unit.
    const children: Array<{ line: number; comment: RefComment }> = [];
    for (let j = i + 1; j < lines.length; j++) {
      const childText = lines[j]?.text ?? "";
      const kj = kinds[j];
      const comment = kj ? refOnly(childText, kj) : undefined;
      if (!comment) break;
      const w = indentWidth(childText);
      if (w < task.contentColumn || w >= task.contentColumn + 4) break;
      children.push({ line: j, comment });
    }

    const unit = [...k.refs.map((comment) => ({ line: i, comment })), ...children];
    for (const { comment } of unit) consumed.add(comment);
    const textEnd = k.refs.length > 0 ? Math.min(...k.refs.map((c) => c.start)) : text.length;
    const taskText = text.slice(task.textStart, textEnd).trimEnd();
    const blocked = () => tasks.push({ task, binding: "blocked", taskText });

    if (unit.length === 0) {
      tasks.push({ task, binding: "local", taskText });
      return;
    }
    if (unit.length > 1) {
      // §13.1 "exactly one", §14, MR-A4, normative since baseline.5: every ref of the unit
      // is a duplicate; malformed ones also get their own code. Nothing is
      // bound and nothing is chosen.
      for (const { line, comment } of unit) {
        diagnose("DUPLICATE_LFCP_REF", line, comment);
        if (comment.error) diagnose(comment.error, line, comment);
      }
      blocked();
      return;
    }
    const [{ line, comment }] = unit as [{ line: number; comment: RefComment }];
    const inline = line === i;
    if (inline && text.slice(comment.end).trim() !== "") {
      diagnose("LFCP_REF_NOT_AT_LINE_END", line, comment);
      if (comment.error) diagnose(comment.error, line, comment);
      blocked();
      return;
    }
    if (comment.error || !comment.ref || comment.rawRef === undefined) {
      diagnose(comment.error ?? "MALFORMED_LFCP_REF", line, comment);
      blocked();
      return;
    }
    if (!SUPPORTED_TYPES.includes(comment.ref.objectType)) {
      // MR-A1, normative since baseline.5 (§9): a well-formed type other than `task` is parsed
      // but not projected.
      diagnose("OBJECT_TYPE_UNSUPPORTED", line, comment);
      blocked();
      return;
    }
    const refText = lines[line]?.text ?? "";
    const taskEnd = task.textStart + taskText.length;
    projections.push({
      ...comment.ref,
      placement: inline ? "inline" : "child",
      taskLine: i,
      refLine: line,
      rawRef: comment.rawRef,
      comment: { text: comment.text, ...range(line, comment.start, comment.end) },
      canonical: comment.canonical,
      taskText,
      unit: {
        offsetStart: lineStart[i] ?? 0,
        offsetEnd: (lineStart[line] ?? 0) + refText.length,
      },
      parts: {
        taskHead: text.slice(0, task.textStart),
        taskGap: text.slice(taskEnd, inline ? comment.start : text.length),
        taskEol: inline ? "" : (lines[i]?.eol ?? ""),
        refIndent: inline ? "" : refText.slice(0, comment.start),
        refTrail: refText.slice(comment.end),
      },
    });
    tasks.push({ task, binding: "bound", taskText });
  });

  // §16: every other ref is an orphan; refs in blockquotes are an
  // unsupported context (README).
  kinds.forEach((k, i) => {
    for (const comment of k.refs) {
      if (consumed.has(comment)) continue;
      diagnose(
        k.kind === "blockquote" ? "LFCP_REF_UNSUPPORTED_CONTEXT" : "ORPHAN_LFCP_REF",
        i,
        comment,
      );
      if (comment.error) diagnose(comment.error, i, comment);
    }
  });

  diagnostics.sort((a, b) => a.offsetStart - b.offsetStart);
  return { projections, diagnostics, tasks };
}
