// What a bound Markdown Task line represents (LFCP-061): the adapter's
// reading of the checkbox glyph and of the Obsidian Tasks-style suffix
// metadata. Obsidian-free; no Shared Objects semantics beyond the field
// values (the SDK owns those).
//
// Owned (sent as intents): title, status (owned glyphs only), due 📅,
// scheduled ⏳, completion date ✅ (ST-5), priority 🔺 ⏫ 🔽 ⏬ (absent:
// normal). Kept local and never sent: start 🛫, created ➕, cancelled ❌,
// medium priority 🔼 (no profile equivalent), recurrence 🔁 (ST-5: not
// synced), the ^block-id. Tags stay part of the title text in 061: the
// Markdown cannot tell a tag meant as Task metadata from one in the prose.

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

type DateField = "due" | "scheduled" | "completion" | "start" | "created" | "cancelled";
const DATE_EMOJI: Readonly<Record<string, DateField>> = {
  "📅": "due",
  "⏳": "scheduled",
  "✅": "completion",
  "🛫": "start",
  "➕": "created",
  "❌": "cancelled",
};

export interface ParsedTaskText {
  /** The title: the text without the suffix metadata and the ^block-id (item 6). */
  readonly title: string;
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

const VS16 = "️?";
const BLOCK_ID = /(^|\s+)\^([A-Za-z0-9-]+)$/;
const TRAILING_TAG = /(^|\s+)(#[^\s#]+)$/;
const DATE = new RegExp(`\\s*(📅|⏳|✅|🛫|➕|❌)${VS16}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u");
const PRIORITY = new RegExp(`\\s*(🔺|⏫|🔼|🔽|⏬)${VS16}$`, "u");
const RECURRENCE = new RegExp(`\\s*🔁${VS16}\\s*([a-zA-Z0-9, !]+?)\\s*$`, "u");

/**
 * Reads a Task's text (after the checkbox, without the inline ref) from the
 * end, the way Obsidian Tasks reads its suffix: block ID, dates, priority,
 * recurrence and trailing tags in any order. Trailing tags stay in the
 * title; everything else recognized is metadata.
 */
export function parseTaskText(text: string): ParsedTaskText {
  let rest = text.trimEnd();
  let blockId: string | null = null;
  const tags: string[] = [];
  const dates = new Map<DateField, Set<string>>();
  const priorities = new Set<TaskPriority | "unowned">();
  let recurrence: string | null = null;
  for (;;) {
    let m = BLOCK_ID.exec(rest);
    if (m !== null && blockId === null) {
      blockId = m[2] as string;
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    m = DATE.exec(rest);
    if (m !== null) {
      const field = DATE_EMOJI[m[1] as string] as DateField;
      const seen = dates.get(field) ?? new Set<string>();
      seen.add(m[2] as string);
      dates.set(field, seen);
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    m = PRIORITY.exec(rest);
    if (m !== null) {
      priorities.add(PRIORITIES[m[1] as string] ?? "unowned");
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    m = RECURRENCE.exec(rest);
    if (m !== null && recurrence === null) {
      recurrence = (m[1] as string).trim();
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    m = TRAILING_TAG.exec(rest);
    if (m !== null && m.index > 0) {
      tags.unshift(m[2] as string);
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    break;
  }
  const title = [rest.trim(), ...tags].filter((x) => x !== "").join(" ");
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
  return {
    title,
    due: one("due"),
    scheduled: one("scheduled"),
    completion: one("completion"),
    priority,
    recurrence,
    blockId,
    ambiguous,
    wikilinks: /\[\[[^\]]+\]\]/.test(title),
  };
}
