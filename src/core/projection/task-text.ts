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

const VS16 = "\uFE0F?";
const BLOCK_ID = /(?:^|\s+)\^([A-Za-z0-9-]+)$/;
const DATE = new RegExp(`\\s*(📅|⏳|✅|🛫|➕|❌)${VS16}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u");
const PRIORITY = new RegExp(`\\s*(🔺|⏫|🔼|🔽|⏬)${VS16}$`, "u");
const RECURRENCE = new RegExp(`\\s*🔁${VS16}\\s*([a-zA-Z0-9, !]+?)\\s*$`, "u");
/** Obsidian's tag grammar: letters, digits, _, - and /, with at least one non-digit (#123 is no tag). */
const TAG = /(?:^|\s+)#([\p{L}\p{N}_/-]+)$/u;
export const isObsidianTag = (tag: string): boolean =>
  /^[\p{L}\p{N}_/-]+$/u.test(tag) && /[^\p{N}]/u.test(tag);

/**
 * Splits a Task's text (after the checkbox, without the inline ref) the way
 * Obsidian Tasks reads its suffix, from the end: block ID, dates, priority,
 * recurrence and the trailing run of tags, in any order. The description is
 * what is left. Segments keep their exact text, so a renderer can rewrite
 * owned ones and leave the rest byte for byte.
 */
export function segmentTaskText(text: string): SegmentedTaskText {
  const end = text.trimEnd();
  const trailing = text.slice(end.length);
  let rest = end;
  const segments: Segment[] = [];
  let block = false;
  for (;;) {
    const cut = (m: RegExpExecArray, segment: Segment) => {
      segments.unshift(segment);
      rest = rest.slice(0, m.index);
    };
    let m = BLOCK_ID.exec(rest);
    if (m !== null && !block) {
      block = true;
      cut(m, { kind: "block", value: m[1] as string, raw: m[0] });
      continue;
    }
    m = DATE.exec(rest);
    if (m !== null) {
      cut(m, {
        kind: "date",
        field: DATE_EMOJI[m[1] as string] as DateField,
        value: m[2] as string,
        raw: m[0],
      });
      continue;
    }
    m = PRIORITY.exec(rest);
    if (m !== null) {
      cut(m, { kind: "priority", value: PRIORITIES[m[1] as string] ?? "unowned", raw: m[0] });
      continue;
    }
    m = RECURRENCE.exec(rest);
    if (m !== null && !segments.some((x) => x.kind === "recurrence")) {
      cut(m, { kind: "recurrence", value: (m[1] as string).trim(), raw: m[0] });
      continue;
    }
    m = TAG.exec(rest);
    if (m !== null && m.index > 0 && isObsidianTag(m[1] as string)) {
      cut(m, { kind: "tag", value: m[1] as string, raw: m[0] });
      continue;
    }
    break;
  }
  return { description: rest, segments, trailing };
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
    wikilinks: /\[\[[^\]]+\]\]/.test(title),
  };
}
