// What a bound Markdown Task line represents (LFCP-061): the adapter's
// reading of the checkbox glyph and of the Obsidian Tasks-style suffix
// metadata. Obsidian-free; no Shared Objects semantics beyond the field
// values (the SDK owns those).
//
// Owned (sent as intents): title, status (owned glyphs only), due 📅,
// scheduled ⏳, completion date ✅ (ST-5), priority 🔺 ⏫ 🔽 ⏬ (absent:
// normal). Kept local and never sent: start 🛫, created ➕, cancelled ❌,
// medium priority 🔼 (no profile equivalent), recurrence 🔁 (ST-5: not
// synced), the ^block-id. Tags (ruling a, LFCP-062): the trailing contiguous
// run of valid Obsidian tags is the Task's tag set and not part of the
// title; a #tag inside the text is title text.

import type { TaskPriority, TaskStatus } from "@openlfcp/shared-objects";

/** ST-1: the glyphs the adapter owns. Any other glyph is not owned (no status intent). */
export function statusOfGlyph(glyph: string): TaskStatus | null {
  switch (glyph) {
    case " ":
      return "todo";
    case "x":
    case "X":
      return "done";
    case "/":
      return "in_progress";
    case "-":
      return "cancelled";
    default:
      return null;
  }
}

/** The glyph the adapter writes for an owned status (LFCP-062 renders with it). */
export function glyphOfStatus(status: TaskStatus): string | null {
  switch (status) {
    case "todo":
      return " ";
    case "done":
      return "x";
    case "in_progress":
      return "/";
    case "cancelled":
      return "-";
    default:
      return null;
  }
}

const PRIORITIES: Readonly<Record<string, TaskPriority | null>> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": null, // Obsidian Tasks "medium": no profile value, not owned
  "🔽": "low",
  "⏬": "lowest",
};

/** The emoji LFCP-062 writes for an owned priority ("normal" writes none). */
export const PRIORITY_EMOJI: Readonly<Partial<Record<TaskPriority, string>>> = {
  highest: "🔺",
  high: "⏫",
  low: "🔽",
  lowest: "⏬",
};

export type DateField = "due" | "scheduled" | "completion" | "start" | "created" | "cancelled";
const DATE_EMOJI: Readonly<Record<string, DateField>> = {
  "📅": "due",
  "⏳": "scheduled",
  "✅": "completion",
  "🛫": "start",
  "➕": "created",
  "❌": "cancelled",
};
/** The emoji LFCP-062 writes for an owned date field. */
export const DATE_FIELD_EMOJI: Readonly<Record<"due" | "scheduled" | "completion", string>> = {
  due: "📅",
  scheduled: "⏳",
  completion: "✅",
};

/** One recognized piece of a Task's suffix, with its exact text (leading whitespace included). */
export type Segment =
  | { readonly kind: "block"; readonly value: string; readonly raw: string }
  | {
      readonly kind: "date";
      readonly field: DateField;
      readonly value: string;
      readonly raw: string;
    }
  | {
      readonly kind: "priority";
      readonly value: TaskPriority | "unowned";
      readonly raw: string;
    }
  | { readonly kind: "recurrence"; readonly value: string; readonly raw: string }
  /** A tag of the trailing run, without "#". */
  | { readonly kind: "tag"; readonly value: string; readonly raw: string };

export interface SegmentedTaskText {
  /** The description: everything before the first suffix segment. */
  readonly description: string;
  /** The suffix segments in document order. */
  readonly segments: readonly Segment[];
  /** Whitespace after the last segment (or after the description). */
  readonly trailing: string;
}

export interface ParsedTaskText {
  /** The title: the description without the suffix metadata, the tag run and the ^block-id (item 6). */
  readonly title: string;
  /** The trailing tag run (ruling a), without "#", in document order. */
  readonly tags: readonly string[];
  readonly due: string | null;
  readonly scheduled: string | null;
  /** ✅ date (ST-5). */
  readonly completion: string | null;
  /** The priority the line represents, or "unowned" (🔼). Absent emoji: "normal". */
  readonly priority: TaskPriority | "unowned";
  /** 🔁 rule, never synced (ST-5). */
  readonly recurrence: string | null;
  readonly blockId: string | null;
  /** Owned fields written more than once with different values: ambiguous, not sent. */
  readonly ambiguous: readonly ("due" | "scheduled" | "completion" | "priority")[];
  /** The title links to notes ([[…]]): their names would be shared (ST-4). */
  readonly wikilinks: boolean;
}

/** Obsidian's tag grammar: letters, digits, _, - and /, with at least one non-digit (#123 is no tag). */
export const isObsidianTag = (tag: string): boolean =>
  /^[\p{L}\p{N}_/-]+$/u.test(tag) && /[^\p{N}]/u.test(tag);

// The suffix is read with hand-written scanners from the end, not regexes:
// end-anchored patterns with whitespace quantifiers backtrack super-linearly
// on adversarial text (a collaborator's title is rendered into the line and
// read again; security review H3, M9). Each scanner looks only at the last
// token and the whitespace before it, and a successful one removes exactly
// those, so a whole parse is linear. They reproduce the patterns they
// replaced (kept in test/core/projection/task-text-linear.test.ts and
// compared on random lines):
//   block       (?:^|\s+)\^([A-Za-z0-9-]+)$
//   date        \s*(📅|⏳|✅|🛫|➕|❌)\uFE0F?\s*(\d{4}-\d{2}-\d{2})$
//   priority    \s*(🔺|⏫|🔼|🔽|⏬)\uFE0F?$
//   recurrence  \s*🔁\uFE0F?\s*([a-zA-Z0-9, !]+?)\s*$
//   tag         (?:^|\s+)#([\p{L}\p{N}_/-]+)$

/** JavaScript's \s: the same code units. */
const WS = new Set(
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
);
const isWs = (c: string | undefined): boolean => c !== undefined && WS.has(c);
const VS = "\uFE0F";
const DATE_EMOJIS = Object.keys(DATE_EMOJI);
const PRIORITY_EMOJIS = Object.keys(PRIORITIES);
const REPEAT = "🔁";

/** The start of the whitespace run that ends at `at` (exclusive). */
function wsStart(s: string, at: number): number {
  let i = at;
  while (i > 0 && isWs(s[i - 1])) i--;
  return i;
}

/** Which of `options` ends exactly at `at`, if any. */
const endingAt = (s: string, at: number, options: readonly string[]): string | undefined =>
  options.find((o) => at >= o.length && s.startsWith(o, at - o.length));

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isIdChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9-]/.test(c);
const isRepeatChar = (c: string | undefined): boolean =>
  c !== undefined && /[a-zA-Z0-9, !]/.test(c);
const TAG_CHAR = /^[\p{L}\p{N}_/-]$/u;

type Cut = { readonly start: number; readonly segment: Segment };

// Each scanner reads the token that ends at `e` in `s` (no copies of the
// remaining text, so many segments stay linear too).

function blockAtEnd(s: string, e: number): Cut | null {
  let i = e;
  while (i > 0 && isIdChar(s[i - 1])) i--;
  if (i === e || s[i - 1] !== "^") return null;
  const caret = i - 1;
  if (caret !== 0 && !isWs(s[caret - 1])) return null;
  const start = caret === 0 ? 0 : wsStart(s, caret);
  return { start, segment: { kind: "block", value: s.slice(i, e), raw: s.slice(start, e) } };
}

function dateAtEnd(s: string, e: number): Cut | null {
  if (e < 10) return null;
  const at = e - 10;
  const c = (k: number) => s[at + k];
  if (
    !(
      isDigit(c(0)) &&
      isDigit(c(1)) &&
      isDigit(c(2)) &&
      isDigit(c(3)) &&
      c(4) === "-" &&
      isDigit(c(5)) &&
      isDigit(c(6)) &&
      c(7) === "-" &&
      isDigit(c(8)) &&
      isDigit(c(9))
    )
  )
    return null;
  let i = wsStart(s, at);
  if (s[i - 1] === VS) i--;
  const emoji = endingAt(s, i, DATE_EMOJIS);
  if (emoji === undefined) return null;
  const start = wsStart(s, i - emoji.length);
  return {
    start,
    segment: {
      kind: "date",
      field: DATE_EMOJI[emoji] as DateField,
      value: s.slice(at, e),
      raw: s.slice(start, e),
    },
  };
}

function priorityAtEnd(s: string, e: number): Cut | null {
  let i = e;
  if (s[i - 1] === VS) i--;
  const emoji = endingAt(s, i, PRIORITY_EMOJIS);
  if (emoji === undefined) return null;
  const start = wsStart(s, i - emoji.length);
  return {
    start,
    segment: { kind: "priority", value: PRIORITIES[emoji] ?? "unowned", raw: s.slice(start, e) },
  };
}

function recurrenceAtEnd(s: string, e: number): Cut | null {
  // After 🔁 (and an optional VS16): whitespace, a run of [a-zA-Z0-9, !],
  // whitespace. Every character after it is one of those; the run holds
  // every non-whitespace character, with no whitespace other than spaces
  // inside it, and at least one character.
  let i = e;
  while (i > 0 && (isRepeatChar(s[i - 1]) || isWs(s[i - 1]))) i--;
  let mark = i;
  if (s[mark - 1] === VS) mark--;
  if (!(mark >= REPEAT.length && s.startsWith(REPEAT, mark - REPEAT.length))) return null;
  let first = -1;
  let last = -1;
  for (let k = i; k < e; k++)
    if (!isWs(s[k])) {
      if (first < 0) first = k;
      last = k;
    }
  if (first < 0) {
    if (!s.slice(i, e).includes(" ")) return null; // the run is at least one character
  } else {
    for (let k = first; k <= last; k++) if (!isRepeatChar(s[k])) return null;
  }
  const start = wsStart(s, mark - REPEAT.length);
  return {
    start,
    segment: { kind: "recurrence", value: s.slice(i, e).trim(), raw: s.slice(start, e) },
  };
}

function tagAtEnd(s: string, e: number): Cut | null {
  let i = e;
  // Code point by code point: a tag may hold letters outside the BMP.
  for (;;) {
    if (i === 0) break;
    const low = s.charCodeAt(i - 1);
    const pair = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? s.charCodeAt(i - 2) : 0;
    const width = pair >= 0xd800 && pair <= 0xdbff ? 2 : 1;
    if (!TAG_CHAR.test(s.slice(i - width, i))) break;
    i -= width;
  }
  if (i === e || s[i - 1] !== "#") return null;
  const hash = i - 1;
  if (hash !== 0 && !isWs(s[hash - 1])) return null;
  const start = hash === 0 ? 0 : wsStart(s, hash);
  return { start, segment: { kind: "tag", value: s.slice(i, e), raw: s.slice(start, e) } };
}

/**
 * Splits a Task's text (after the checkbox, without the inline ref) the way
 * Obsidian Tasks reads its suffix, from the end: block ID, dates, priority,
 * recurrence and the trailing run of tags, in any order. The description is
 * what is left. Segments keep their exact text, so a renderer can rewrite
 * owned ones and leave the rest byte for byte. Linear in the text length.
 */
export function segmentTaskText(text: string): SegmentedTaskText {
  const end = text.trimEnd();
  const trailing = text.slice(end.length);
  let e = end.length;
  const reversed: Segment[] = [];
  let block = false;
  let recurrence = false;
  for (;;) {
    const tag = tagAtEnd(end, e);
    const cut =
      (!block ? blockAtEnd(end, e) : null) ??
      dateAtEnd(end, e) ??
      priorityAtEnd(end, e) ??
      (!recurrence ? recurrenceAtEnd(end, e) : null) ??
      (tag !== null && tag.start > 0 && isObsidianTag(tag.segment.value) ? tag : null);
    if (cut === null) break;
    if (cut.segment.kind === "block") block = true;
    if (cut.segment.kind === "recurrence") recurrence = true;
    reversed.push(cut.segment);
    e = cut.start;
  }
  return { description: end.slice(0, e), segments: reversed.reverse(), trailing };
}

/** Whether the text holds a wikilink, [[…]] with no ] inside (one linear pass). */
export function hasWikilink(text: string): boolean {
  let firstOpen = -1; // the first "[[" since the last "]"
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "]") {
      if (text[k + 1] === "]" && firstOpen >= 0 && firstOpen + 2 < k) return true;
      firstOpen = -1;
    } else if (c === "[" && text[k + 1] === "[" && firstOpen < 0) firstOpen = k;
  }
  return false;
}

/** What a Task's text represents (LFCP-061, tags per ruling a). */
export function parseTaskText(text: string): ParsedTaskText {
  const { description, segments } = segmentTaskText(text);
  const title = description.trim();
  const dates = new Map<DateField, Set<string>>();
  const priorities = new Set<TaskPriority | "unowned">();
  for (const x of segments) {
    if (x.kind === "date") dates.set(x.field, (dates.get(x.field) ?? new Set()).add(x.value));
    if (x.kind === "priority") priorities.add(x.value);
  }
  const ambiguous: ParsedTaskText["ambiguous"][number][] = [];
  const one = (field: "due" | "scheduled" | "completion"): string | null => {
    const values = dates.get(field);
    if (values === undefined) return null;
    if (values.size > 1) {
      ambiguous.push(field);
      return null;
    }
    return [...values][0] as string;
  };
  if (priorities.size > 1) ambiguous.push("priority");
  const priority: TaskPriority | "unowned" =
    priorities.size === 0
      ? "normal"
      : priorities.size > 1
        ? "unowned"
        : ([...priorities][0] as TaskPriority | "unowned");
  const recurrence = segments.find((x) => x.kind === "recurrence");
  const block = segments.find((x) => x.kind === "block");
  return {
    title,
    tags: segments.filter((x) => x.kind === "tag").map((x) => x.value),
    due: one("due"),
    scheduled: one("scheduled"),
    completion: one("completion"),
    priority,
    recurrence: recurrence?.value ?? null,
    blockId: block?.value ?? null,
    ambiguous,
    wikilinks: hasWikilink(title),
  };
}
