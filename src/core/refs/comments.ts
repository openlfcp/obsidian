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
  const inSpan = within(spans);
  for (let at = text.indexOf("%%"); at >= 0; at = text.indexOf("%%", at + 2)) {
    if (!inSpan(at)) marks.push(at);
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
  // The next run of the same length after each run, found in one pass from
  // the right (a forward search per unmatched run was quadratic).
  const next = new Array<number>(runs.length).fill(-1);
  const latest = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = (runs[i] as [number, number])[1];
    next[i] = latest.get(length) ?? -1;
    latest.set(length, i);
  }
  for (let i = 0; i < runs.length; i++) {
    const close = next[i] as number;
    if (close < 0) continue;
    const [open, length] = runs[i] as [number, number];
    const [closeAt] = runs[close] as [number, number];
    spans.push([open, closeAt + length]);
    i = close;
  }
  return spans;
}

/**
 * Membership in a set of [start, end) ranges in O(log n) per query (ranges
 * may overlap): sorted by start, with the running maximum of their ends.
 */
export function within(ranges: readonly (readonly [number, number])[]): (at: number) => boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const starts = sorted.map((r) => r[0]);
  const maxEnd: number[] = [];
  for (const [, e] of sorted) maxEnd.push(Math.max(e, maxEnd.at(-1) ?? -Infinity));
  return (at) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && (maxEnd[lo - 1] as number) > at;
  };
}

/**
 * MR-A2, normative since baseline.5 (§6): the comment is `<!--`, spaces or
 * tabs, the literal `lfcp-ref:`, spaces or tabs, the object reference,
 * spaces or tabs, `-->`. One space at each separator is canonical; more is
 * accepted and flagged non-canonical. A recognized comment of any other
 * shape (for example `<!--lfcp-ref:` or `lfcp-ref :`) is MALFORMED_LFCP_REF.
 */
const SHAPE = /^<!--([ \t]+)lfcp-ref:([ \t]+)(\S+)([ \t]+)-->$/;

/**
 * Whether an HTML comment is an `lfcp-ref` comment, well-formed or not: its
 * content contains `lfcp-ref:` (§6), or starts with `lfcp-ref` after spaces
 * or tabs (MR-A2: so `<!-- lfcp-ref : … -->` is reported as malformed, not
 * silently ignored).
 */
const isRefComment = (content: string): boolean =>
  content.includes("lfcp-ref:") || /^[ \t]*lfcp-ref/.test(content);

/**
 * The `lfcp-ref` comments of one line, outside inline code spans and
 * Obsidian `%%` comments (§13.1 rule 3).
 */
export function findRefComments(text: string): LineComments {
  const spans = codeSpans(text);
  const obsidian = obsidianComments(text, spans);
  const inLiteral = within([...spans, ...obsidian.ranges]);
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
    if (isRefComment(comment.slice(4, -3))) refs.push(describe(comment, start, end));
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
  const rawRef = shape[3] as string;
  const canonical = shape[1] === " " && shape[2] === " " && shape[4] === " ";
  const parsed = parseObjectRef(rawRef);
  return parsed.ok
    ? { start, end, text, rawRef, ref: parsed.ref, error: undefined, canonical }
    : { start, end, text, rawRef, ref: undefined, error: parsed.code, canonical };
}
