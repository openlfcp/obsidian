// Importing 0.1 shared Tasks into a new shared section (LFCP-02-053,
// MVP-0.2-COMPATIBILITY-AND-MIGRATION §5–§7, UX §3): an explicit copy, not a
// migration. The new section gets new Task IDs and the values observed in
// the source collaboration now; the source collaboration, its history and
// its participants stay exactly as they are, and future edits of each go
// their own way. Pure.
//
// The preflight blocks what cannot be copied faithfully (an unknown source,
// an extension it cannot carry, a damaged ref) and asks for what only the
// user can decide (a value for each source conflict, what to do with a Task
// that occurs twice). Choosing a value for the copy does not resolve the
// source's conflict. Assignees are copied as values only: they get no access
// and no invitation.

import { type PrincipalId, toBase64url } from "@openlfcp/core";
import {
  createTask,
  SCALAR_FIELDS,
  type ScalarField,
  type TaskView,
} from "@openlfcp/shared-objects";
import { type MarkdownProjectionRef, scanRefs } from "../refs";
import { splitLines } from "../refs/lines";
import type { NewSectionTask } from "./port";
import type { ShareRange } from "./share";
import { type DocChange, lineStarts } from "./source-map";

/** The source collaboration of a legacy Task, as this device holds it now. */
export interface LegacySource {
  readonly view: TaskView;
  /** The source model's revision when captured (heads), for the journal. */
  readonly revision: string;
  /** Local changes of the source not yet sent: the copy shows this device's state. */
  readonly pending: boolean;
}

export interface LegacyTask {
  readonly line: number;
  /** The source Resource (base64url) and Task. */
  readonly resource: string;
  readonly objectId: string;
}

export type LegacyBlock =
  /** The source collaboration or Task is not on this device. */
  | { readonly code: "UNKNOWN_SOURCE"; readonly line: number }
  /** An extension or unknown field the copy cannot carry (CM09). */
  | {
      readonly code: "UNMAPPABLE_EXTENSION";
      readonly line: number;
      readonly fields: readonly string[];
    }
  /** A deleted source Task: nothing to copy. */
  | { readonly code: "DELETED_SOURCE"; readonly line: number };

export type LegacyChoice =
  /** Conflicting values in the source: one has to be chosen for the copy (CM08). */
  | {
      readonly code: "CONFLICT";
      readonly objectId: string;
      readonly field: ScalarField;
      readonly values: readonly unknown[];
    }
  /** The same Task twice in the range: each occurrence becomes its own new Task (UX17). */
  | { readonly code: "REPEATED"; readonly objectId: string; readonly lines: readonly number[] };

export interface LegacyPreview {
  readonly tasks: readonly LegacyTask[];
  readonly blocks: readonly LegacyBlock[];
  readonly choices: readonly LegacyChoice[];
  /** Lines entering the shared boundary for the first time (CM04): not a legacy Task or its ref. */
  readonly newlyShared: readonly string[];
  /** Assignees copied as values; they get no access (CM12). */
  readonly assignees: readonly { readonly objectId: string; readonly refs: readonly string[] }[];
  /** Sources with local changes not yet sent: the copy reflects this device's state. */
  readonly pendingSources: readonly string[];
  /** For the journal: each source's revision as captured. */
  readonly captured: Readonly<Record<string, string>>;
}

export interface ImportChoices {
  /** objectId → field → the value for the copy. */
  readonly values?: Readonly<Record<string, Readonly<Partial<Record<ScalarField, unknown>>>>>;
  /** objectIds whose repeated occurrences become independent copies. */
  readonly copies?: readonly string[];
}

/** Every 0.1 projection inside the range. */
function inRange(markdown: string, range: ShareRange): MarkdownProjectionRef[] {
  return scanRefs(markdown).projections.filter(
    (p) => p.taskLine > range.headingLine && p.taskLine <= range.lastLine,
  );
}

const KNOWN = new Set([
  "id",
  "type",
  "lifecycle",
  "created_by",
  "created_at",
  "title",
  "status",
  "due",
  "scheduled",
  "completion_date",
  "priority",
  "tags",
  "assignees",
  "extensions",
]);

export function legacyPreflight(
  markdown: string,
  range: ShareRange,
  source: (resource: string, objectId: string) => LegacySource | undefined,
): LegacyPreview {
  const refs = inRange(markdown, range);
  const tasks: LegacyTask[] = refs.map((p) => ({
    line: p.taskLine,
    resource: toBase64url(p.resourceId),
    objectId: p.objectId,
  }));
  const blocks: LegacyBlock[] = [];
  const choices: LegacyChoice[] = [];
  const assignees: { objectId: string; refs: string[] }[] = [];
  const pendingSources = new Set<string>();
  const captured: Record<string, string> = {};
  const seen = new Map<string, number[]>();
  for (const t of tasks) seen.set(t.objectId, [...(seen.get(t.objectId) ?? []), t.line]);
  const done = new Set<string>();
  for (const t of tasks) {
    if (done.has(t.objectId)) continue;
    done.add(t.objectId);
    const s = source(t.resource, t.objectId);
    const task = s?.view.task;
    if (s === undefined || task === undefined) {
      blocks.push({ code: "UNKNOWN_SOURCE", line: t.line });
      continue;
    }
    captured[t.resource] = s.revision;
    if (s.pending) pendingSources.add(t.resource);
    if (task.lifecycle === "deleted") {
      blocks.push({ code: "DELETED_SOURCE", line: t.line });
      continue;
    }
    const unknown = [
      ...Object.keys(task).filter((k) => !KNOWN.has(k)),
      ...Object.keys(task.extensions).map((ns) => `extensions.${ns}`),
    ];
    if (unknown.length > 0)
      blocks.push({ code: "UNMAPPABLE_EXTENSION", line: t.line, fields: unknown });
    for (const field of SCALAR_FIELDS) {
      // The copy is a new, active Task: the source's lifecycle is not copied.
      if (field === "lifecycle") continue;
      const f = s.view.fields[field];
      if (f.conflicted)
        choices.push({ code: "CONFLICT", objectId: t.objectId, field, values: f.values });
    }
    const refsOf = Object.keys(task.assignees);
    if (refsOf.length > 0) assignees.push({ objectId: t.objectId, refs: refsOf });
    const lines = seen.get(t.objectId) ?? [];
    if (lines.length > 1) choices.push({ code: "REPEATED", objectId: t.objectId, lines });
  }
  // Text entering the boundary: everything in the range but the legacy Task lines and their refs.
  const lines = splitLines(markdown);
  const legacyLines = new Set(refs.flatMap((p) => [p.taskLine, p.refLine]));
  const newlyShared: string[] = [];
  for (let l = range.headingLine + 1; l <= range.lastLine; l++) {
    const text = lines[l]?.text ?? "";
    if (!legacyLines.has(l) && text.trim() !== "") newlyShared.push(text);
  }
  return {
    tasks,
    blocks,
    choices,
    newlyShared,
    assignees,
    pendingSources: [...pendingSources],
    captured,
  };
}

/** The choices still missing for `preview`, or none: the import may go on. */
export function missingChoices(preview: LegacyPreview, chosen: ImportChoices): LegacyChoice[] {
  return preview.choices.filter((c) =>
    c.code === "REPEATED"
      ? !(chosen.copies ?? []).includes(c.objectId)
      : chosen.values?.[c.objectId]?.[c.field] === undefined,
  );
}

/**
 * The note changes removing the legacy refs of the range: each child ref
 * line, or each inline comment with the spaces before it (as §18 detaches).
 */
export function legacyStrip(markdown: string, range: ShareRange): DocChange[] {
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  return inRange(markdown, range)
    .map((p): DocChange => {
      if (p.placement === "child") {
        const from = starts[p.refLine] ?? markdown.length;
        const line = lines[p.refLine];
        const to = from + (line?.text.length ?? 0) + (line?.eol.length ?? 0);
        // A last line without an ending: remove the ending before it instead.
        if (line !== undefined && line.eol === "" && p.refLine > 0) {
          const prev = lines[p.refLine - 1];
          return { from: from - (prev?.eol.length ?? 0), to, insert: "" };
        }
        return { from, to, insert: "" };
      }
      const at = starts[p.taskLine] ?? 0;
      const text = lines[p.taskLine]?.text ?? "";
      const head = text.slice(0, p.comment.start).trimEnd().length;
      return { from: at + head, to: at + p.comment.end, insert: "" };
    })
    .sort((a, b) => a.from - b.from);
}

/**
 * The new section Task of a legacy one: a new ID, created by the importing
 * Principal, with the source's observed values and the chosen ones for its
 * conflicts. Assignees are kept as values (CM12).
 */
export function importedTask(
  view: TaskView,
  id: string,
  createdBy: PrincipalId,
  values: Readonly<Partial<Record<ScalarField, unknown>>> = {},
): NewSectionTask {
  const task = view.task;
  if (task === undefined) throw new Error("the source Task has no valid value");
  const pick = <T>(field: ScalarField, own: T): T =>
    (values[field] !== undefined ? values[field] : own) as T;
  const due = pick<string | null | undefined>("due", task.due);
  const scheduled = pick<string | null | undefined>("scheduled", task.scheduled);
  return createTask({
    id: id as never,
    createdBy,
    title: pick("title", task.title),
    status: pick("status", task.status),
    priority: pick("priority", task.priority),
    ...(due === null || due === undefined ? {} : { due }),
    ...(scheduled === null || scheduled === undefined ? {} : { scheduled }),
    tags: Object.keys(task.tags),
    assignees: Object.keys(task.assignees) as never,
  }).task;
}
