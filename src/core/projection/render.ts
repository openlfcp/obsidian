// Shared Object → Markdown (LFCP-062): rewrite the represented fields of
// every bound Task line in a note from the current Shared Objects state.
// Obsidian-free and pure: Markdown in, Markdown out.
//
// Only the Task line changes, and only its owned pieces: the checkbox glyph
// (owned statuses), the title, the tag run, the owned priority emoji, 📅,
// ⏳ and ✅ (ST-5: exactly one on a done Task, none otherwise). A piece
// whose value already matches keeps its exact bytes; a new one goes where
// Obsidian Tasks puts it. The ref comment, child lines, the ^block-id,
// unowned tokens (🛫 ➕ ❌ 🔼 🔁), indentation, surrounding text and line
// endings are untouched. Conflicted fields render their visible value and
// are reported for an indicator outside the text; no conflict marker is ever
// written. Objects that are not valid live Tasks are not rewritten.

import { toBase64url } from "@openlfcp/core";
import {
  SCALAR_FIELDS,
  type ScalarField,
  type Task,
  type TaskView,
} from "@openlfcp/shared-objects";
import { scanRefs } from "../refs";
import { joinLines, splitLines } from "../refs/lines";
import type { ObjectRef } from "../refs/object-ref";
import type { MarkdownProjectionRef } from "../refs/scanner";
import { formatRefComment } from "../refs/serializer";
import { suspectReassociation } from "./reassociation";
import {
  DATE_FIELD_EMOJI,
  type DateField,
  glyphOfStatus,
  isObsidianTag,
  PRIORITY_EMOJI,
  parseTaskText,
  type Segment,
  segmentTaskText,
  statusOfGlyph,
} from "./task-text";

export type RenderIssueCode =
  | "OBJECT_UNKNOWN"
  | "OBJECT_PROFILE_INVALID"
  | "OBJECT_ID_COLLISION"
  | "OBJECT_DELETED"
  /** A shared tag that is not an Obsidian tag: not written (and never removed by an edit). */
  | "TAG_NOT_RENDERABLE"
  /** A G-EP7 rebuild changed what the line shows (e.g. done back to todo). */
  | "STATE_REGRESSED"
  /** ST-2: the ref seems to sit under the wrong Task; the line is left until it is repaired. */
  | "REF_REASSOCIATION_SUSPECTED";

export interface RenderIssue {
  readonly code: RenderIssueCode;
  readonly message: string;
}

export interface RenderedProjection {
  readonly line: number;
  /** `<resource base64url>#<object id>`. */
  readonly key: string;
  /** Fields whose rendering changed. */
  readonly changed: readonly string[];
  /** Conflicted fields (the visible value is rendered). */
  readonly conflicts: readonly ScalarField[];
  readonly issues: readonly RenderIssue[];
}

export interface RenderResult {
  readonly text: string;
  readonly changed: boolean;
  readonly projections: readonly RenderedProjection[];
}

/** What the renderer knows of one object: its view, and whether a rebuild just changed it. */
export interface RenderTarget {
  readonly view: TaskView | undefined;
  readonly regressed?: boolean;
}

export const projectionKey = (p: { resourceId: Uint8Array; objectId: string }): string =>
  `${toBase64url(p.resourceId)}#${p.objectId}`;

/** Where Obsidian Tasks writes each piece (description first). */
const RANK: Readonly<Record<string, number>> = {
  tag: 0,
  priority: 1,
  recurrence: 2,
  created: 3,
  start: 4,
  scheduled: 5,
  due: 6,
  cancelled: 7,
  completion: 8,
  block: 9,
};
const rankOf = (s: Segment): number =>
  RANK[s.kind === "date" ? s.field : s.kind] ?? Number.MAX_SAFE_INTEGER;

/** Inserts `added` where Obsidian Tasks would put that kind of piece. */
function insertAt(segments: Segment[], added: Segment[], rank: number, at?: number): void {
  const index =
    at ??
    (() => {
      const i = segments.findIndex((s) => rankOf(s) > rank);
      return i < 0 ? segments.length : i;
    })();
  segments.splice(index, 0, ...added);
}

/** Sets the pieces matching `match` to exactly `wanted` (none, or one), keeping a matching piece's bytes. */
function setPieces(
  segments: Segment[],
  match: (s: Segment) => boolean,
  wanted: Segment | null,
  same: (s: Segment) => boolean,
  rank: number,
  retarget?: (existing: Segment) => Segment,
): void {
  const found = segments.map((s, i) => [s, i] as const).filter(([s]) => match(s));
  if (wanted === null) {
    for (const [, i] of [...found].reverse()) segments.splice(i, 1);
    return;
  }
  if (found.length === 1) {
    const [existing, at] = found[0] as readonly [Segment, number];
    if (same(existing)) return;
    // LFCP-064: change only the value inside the existing token (its spacing
    // and emoji variant stay), the smallest safe range.
    if (retarget !== undefined) {
      segments[at] = retarget(existing);
      return;
    }
  }
  const first = found[0]?.[1];
  for (const [, i] of [...found].reverse()) segments.splice(i, 1);
  insertAt(segments, [wanted], rank, first);
}

const date = (field: DateField, value: string): Segment => ({
  kind: "date",
  field,
  value,
  raw: ` ${DATE_FIELD_EMOJI[field as "due" | "scheduled" | "completion"]} ${value}`,
});

/** `text` with the last occurrence of `from` replaced by `to`. */
const replaceLast = (text: string, from: string, to: string): string => {
  const at = text.lastIndexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
};

const OWNED_STATUS = new Set(["todo", "done", "in_progress", "cancelled"]);

/** The Task's text rewritten for `task` (the visible values). */
export function renderTaskText(text: string, task: Task, issues: RenderIssue[]): string {
  const parsed = parseTaskText(text);
  const { description, segments: original, trailing } = segmentTaskText(text);
  const segments = [...original];

  // Title and tags (with the LFCP-061 legacy layout, ruling a).
  const run = parsed.tags.map((t) => `#${t}`).join(" ");
  const legacy = parsed.tags.length > 0 && task.title === `${parsed.title} ${run}`;
  let nextDescription = description;
  if (!legacy && parsed.title !== task.title) {
    const lead = /^\s*/.exec(description)?.[0] ?? "";
    nextDescription = `${lead}${task.title}`;
  }
  if (!legacy) {
    const shared = Object.keys(task.tags).sort();
    const renderable = shared.filter(isObsidianTag);
    for (const t of shared.filter((x) => !isObsidianTag(x)))
      issues.push({
        code: "TAG_NOT_RENDERABLE",
        message: `The shared tag "${t}" cannot be written as an Obsidian tag; it is kept but not shown.`,
      });
    const current = parsed.tags.map((t) => t.normalize("NFC"));
    const sameSet =
      current.length === renderable.length &&
      new Set(current).size === current.length &&
      renderable.every((t) => current.includes(t));
    if (!sameSet) {
      // LFCP-064: the user's tags stay where and as they are; removed ones
      // go, duplicates collapse, new ones (sorted) follow the last kept tag.
      const seen = new Set<string>();
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] as Segment;
        if (seg.kind !== "tag") continue;
        const t = seg.value.normalize("NFC");
        if (!renderable.includes(t) || seen.has(t)) segments.splice(i--, 1);
        else seen.add(t);
      }
      const added = renderable
        .filter((t) => !seen.has(t))
        .map((t): Segment => ({ kind: "tag", value: t, raw: ` #${t}` }));
      const lastTag = segments.map((x) => x.kind).lastIndexOf("tag");
      insertAt(segments, added, RANK.tag as number, lastTag < 0 ? undefined : lastTag + 1);
    }
  }

  // Priority: 🔼 is never written; an extension priority leaves the pieces alone.
  if (!task.priority.startsWith("x/")) {
    const emoji = PRIORITY_EMOJI[task.priority];
    if (emoji === undefined) {
      // normal: no owned emoji (a 🔼 stays, it is not owned).
      setPieces(
        segments,
        (s) => s.kind === "priority" && s.value !== "unowned",
        null,
        () => false,
        1,
      );
    } else {
      setPieces(
        segments,
        (s) => s.kind === "priority",
        { kind: "priority", value: task.priority, raw: ` ${emoji}` },
        (s) => s.kind === "priority" && s.value === task.priority,
        RANK.priority as number,
        (s) => ({
          kind: "priority",
          value: task.priority,
          raw: s.raw.replace(/🔺|⏫|🔼|🔽|⏬/u, emoji),
        }),
      );
    }
  }

  // Dates, and ✅ only when the status is an owned one (ST-5).
  const wanted: [DateField, string | null][] = [
    ["scheduled", task.scheduled ?? null],
    ["due", task.due ?? null],
  ];
  if (OWNED_STATUS.has(task.status))
    wanted.push(["completion", task.status === "done" ? (task.completion_date ?? null) : null]);
  for (const [field, value] of wanted)
    setPieces(
      segments,
      (s) => s.kind === "date" && s.field === field,
      value === null ? null : date(field, value),
      (s) => s.kind === "date" && s.value === value,
      RANK[field] as number,
      (s) =>
        s.kind === "date" && value !== null
          ? { ...s, value, raw: replaceLast(s.raw, s.value, value) }
          : date(field, value as string),
    );

  return nextDescription + segments.map((s) => s.raw).join("") + trailing;
}

function changedFields(before: string, after: string, glyphBefore: string, glyphAfter: string) {
  const a = parseTaskText(before);
  const b = parseTaskText(after);
  const out: string[] = [];
  if (statusOfGlyph(glyphBefore) !== statusOfGlyph(glyphAfter)) out.push("status");
  for (const f of ["title", "due", "scheduled", "completion", "priority"] as const)
    if (a[f] !== b[f]) out.push(f === "completion" ? "completion_date" : f);
  if (a.tags.join(" ") !== b.tags.join(" ")) out.push("tags");
  return out;
}

/**
 * The note with every bound Task whose object `lookup` knows rendered from
 * it. Objects `lookup` does not cover (undefined) are left as they are.
 */
export function renderNote(
  markdown: string,
  lookup: (key: string) => RenderTarget | undefined,
): RenderResult {
  const scan = scanRefs(markdown);
  const lines = splitLines(markdown);
  const projections: RenderedProjection[] = [];
  let changed = false;
  for (const p of scan.projections) {
    const key = projectionKey(p);
    const target = lookup(key);
    if (target === undefined) continue;
    const issues: RenderIssue[] = [];
    const leave = (code: RenderIssueCode, message: string) =>
      projections.push({
        line: p.taskLine,
        key,
        changed: [],
        conflicts: [],
        issues: [{ code, message }],
      });
    const view = target.view;
    if (view === undefined) {
      leave("OBJECT_UNKNOWN", "The shared Task is not here yet; the line is left as it is.");
      continue;
    }
    if (view.status === "object_id_collision") {
      leave("OBJECT_ID_COLLISION", "Two shared objects use this ID; the line is left as it is.");
      continue;
    }
    if (view.status !== "ready" || view.task === undefined) {
      leave("OBJECT_PROFILE_INVALID", "The shared Task is not valid; the line is left as it is.");
      continue;
    }
    const task = view.task;
    if (task.lifecycle === "deleted") {
      leave("OBJECT_DELETED", "The shared Task was deleted; the line is kept.");
      continue;
    }
    if (suspectReassociation(p, scan.tasks, task.title) !== null) {
      leave(
        "REF_REASSOCIATION_SUSPECTED",
        "The ref seems to sit under another Task; nothing is rendered until it is repaired.",
      );
      continue;
    }
    const conflicts = SCALAR_FIELDS.filter((f) => view.fields[f].conflicted);
    const line = lines[p.taskLine] as { text: string; eol: string };
    const next = renderLine(
      line.text,
      p,
      scan.tasks.find((t) => t.task.line === p.taskLine)?.task.status,
      task,
      issues,
    );
    if (next === null) continue;
    const fields = changedFields(p.taskText, next.text, next.glyphBefore, next.glyphAfter);
    if (next.line !== line.text) {
      lines[p.taskLine] = { text: next.line, eol: line.eol };
      changed = true;
      if (target.regressed === true)
        issues.push({
          code: "STATE_REGRESSED",
          message: `An earlier change was withdrawn (a Key Epoch cutoff), so this task shows older values again (${fields.join(", ")}).`,
        });
    }
    projections.push({
      line: p.taskLine,
      key,
      changed: next.line !== line.text ? fields : [],
      conflicts,
      issues,
    });
  }
  return { text: changed ? joinLines(lines) : markdown, changed, projections };
}

function renderLine(
  lineText: string,
  p: MarkdownProjectionRef,
  glyph: string | undefined,
  task: Task,
  issues: RenderIssue[],
): { line: string; text: string; glyphBefore: string; glyphAfter: string } | null {
  const head = p.parts.taskHead;
  const suffix =
    p.placement === "inline"
      ? `${p.parts.taskGap}${p.comment.text}${p.parts.refTrail}`
      : p.parts.taskGap;
  // Defensive: only rewrite a line whose pieces reassemble exactly.
  if (glyph === undefined || head + p.taskText + suffix !== lineText) return null;
  // ST-1: an unowned glyph ([>], [?], …) is the user's local presentation:
  // never overwritten, as no intent was ever sent for it.
  const owned = statusOfGlyph(glyph);
  const glyphAfter =
    owned !== null && OWNED_STATUS.has(task.status) && owned !== task.status
      ? (glyphOfStatus(task.status) as string)
      : glyph;
  const bracket = head.indexOf("[");
  const nextHead = `${head.slice(0, bracket + 1)}${glyphAfter}${head.slice(bracket + 2)}`;
  const text = renderTaskText(p.taskText, task, issues);
  return { line: nextHead + text + suffix, text, glyphBefore: glyph, glyphAfter };
}

export interface NewTaskLineOptions {
  readonly placement: "inline" | "child";
  readonly ref: ObjectRef;
  /** Leading whitespace of the Task line (default none). */
  readonly indent?: string;
  /** The list marker (default "-"). */
  readonly marker?: string;
  /** The line ending of every written line (default "\n"). */
  readonly eol?: string;
}

/**
 * A new projection unit for a Shared Task, as the renderer would write it
 * (LFCP-065 "Insert shared object"): the Task line with its glyph and owned
 * fields, and the canonical ref comment inline or on a child line indented
 * to the Task's content column. Ends with `eol`. Scanning it gives back the
 * same binding, and it represents the Task exactly (no intents).
 */
export function renderNewTaskLine(task: Task, o: NewTaskLineOptions): string {
  const indent = o.indent ?? "";
  const marker = o.marker ?? "-";
  const eol = o.eol ?? "\n";
  const glyph = glyphOfStatus(task.status) ?? " ";
  const text = renderTaskText("", task, []).trimStart();
  const line = `${indent}${marker} [${glyph}] ${text}`;
  const comment = formatRefComment(o.ref);
  return o.placement === "inline"
    ? `${line} ${comment}${eol}`
    : `${line}${eol}${indent}${" ".repeat(marker.length + 1)}${comment}${eol}`;
}
