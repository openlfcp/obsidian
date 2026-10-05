// Recognizing `lfcp-ref` comments on one line (MARKDOWN-REFS-01 §6).

import { type ObjectRef, type ObjectRefError, parseObjectRef } from "./object-ref";

/** A recognized `lfcp-ref` comment on a line. */
export interface RefComment {
  /** Column of `<!--` (UTF-16 code units). */
  readonly start: number;
  /** Column just after `-->`. */
  readonly end: number;
  /** The comment's exact text. */
  readonly text: string;
  /** The object reference as written, when the comment has the §6 shape. */
  readonly rawRef: string | undefined;
  /** The parsed binding, when valid. */
  readonly ref: ObjectRef | undefined;
  /** Why it is invalid, when it is. */
  readonly error: ObjectRefError | undefined;
  /** Whether the spacing is exactly canonical (§6); tolerated spacing is flagged. */
  readonly canonical: boolean;
}

export interface LineComments {
  readonly refs: RefComment[];
  /** A `<!--` without `-->` on this line opens a multi-line HTML comment. */
  readonly opensComment: boolean;
  /** An unpaired `%%` on this line opens a multi-line Obsidian comment. */
  readonly opensObsidianComment: boolean;
}

/**
 * Obsidian comments `%% … %%` on one line as [start, end) column pairs,
 * outside code spans, and whether a last unpaired `%%` opens a comment that
 * continues on the next lines.
 */
export function obsidianComments(
  text: string,
  spans: Array<[number, number]>,
): { ranges: Array<[number, number]>; opens: boolean } {
  const marks: number[] = [];
  for (let at = text.indexOf("%%"); at >= 0; at = text.indexOf("%%", at + 2)) {
    if (!spans.some(([s, e]) => at >= s && at < e)) marks.push(at);
  }
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i + 1 < marks.length; i += 2)
    ranges.push([marks[i] as number, (marks[i + 1] as number) + 2]);
  if (marks.length % 2 === 1) ranges.push([marks[marks.length - 1] as number, text.length]);
  return { ranges, opens: marks.length % 2 === 1 };
}

/** Inline code spans of a line as [start, end) column pairs (CommonMark backtick runs). */
export function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const runs: Array<[number, number]> = [];
  for (const m of text.matchAll(/`+/g)) runs.push([m.index, m[0].length]);
  for (let i = 0; i < runs.length; i++) {
    const [open, length] = runs[i] as [number, number];
    const close = runs.findIndex((r, j) => j > i && r[1] === length);
    if (close < 0) continue;
    const [closeAt] = runs[close] as [number, number];
    spans.push([open, closeAt + length]);
    i = close;
  }
  return spans;
}

/**
 * PROVISIONAL (MR-A2): a recognized comment is any HTML comment whose
 * content, after leading spaces or tabs, starts with `lfcp-ref`. It is
 * well-formed only as `<!-- lfcp-ref:` + spaces/tabs + the object
 * reference + spaces/tabs + `-->`; one space on each side is canonical,
 * more is tolerated and flagged, anything else is MALFORMED_LFCP_REF.
 */
const SHAPE = /^<!-- lfcp-ref:([ \t]+)(\S+)([ \t]+)-->$/;

/**
 * The `lfcp-ref` comments of one line, outside inline code spans and
 * Obsidian `%%` comments (§13.1 rule 3).
 */
export function findRefComments(text: string): LineComments {
  const spans = codeSpans(text);
  const obsidian = obsidianComments(text, spans);
  const literal = [...spans, ...obsidian.ranges];
  const inLiteral = (at: number) => literal.some(([s, e]) => at >= s && at < e);
  const refs: RefComment[] = [];
  const done = (opensComment: boolean) => ({
    refs,
    opensComment,
    opensObsidianComment: obsidian.opens,
  });
  let from = 0;
  for (;;) {
    const start = text.indexOf("<!--", from);
    if (start < 0) return done(false);
    if (inLiteral(start)) {
      from = start + 4;
      continue;
    }
    const close = text.indexOf("-->", start + 4);
    if (close < 0) return done(true);
    const end = close + 3;
    const comment = text.slice(start, end);
    if (/^[ \t]*lfcp-ref/.test(comment.slice(4, -3))) refs.push(describe(comment, start, end));
    from = end;
  }
}

function describe(text: string, start: number, end: number): RefComment {
  const shape = SHAPE.exec(text);
  if (!shape) {
    return {
      start,
      end,
      text,
      rawRef: undefined,
      ref: undefined,
      error: "MALFORMED_LFCP_REF",
      canonical: false,
    };
  }
  const rawRef = shape[2] as string;
  const canonical = shape[1] === " " && shape[3] === " ";
  const parsed = parseObjectRef(rawRef);
  return parsed.ok
    ? { start, end, text, rawRef, ref: parsed.ref, error: undefined, canonical }
    : { start, end, text, rawRef, ref: undefined, error: parsed.code, canonical };
}
