// The semantic diff of LFCP-061: what a bound Markdown Task represents,
// compared with the current Shared Object, as the Shared Objects intents
// that make the object match. Obsidian-free; intents come from the SDK's
// builders only (no Automerge, no whole-object rewrite).
//
// - Only changed owned fields produce an intent (G-SC4: an unchanged value
//   is never re-put by a projection).
// - A conflicted field produces none: a visible value equal to the Markdown
//   is not a resolution, and an edit does not resolve it either. Resolution
//   is an explicit resolve_field_conflict (a UI command), never a Markdown
//   echo.
// - An object that is not a valid Task (PROFILE_INVALID, an Object ID
//   collision) or is deleted produces none, with a diagnostic.

import {
  addTag,
  cancel,
  clearDue,
  clearScheduled,
  complete,
  ProfileError,
  type ReplicaIntent,
  removeTag,
  reopen,
  type ScalarField,
  setDue,
  setPriority,
  setScheduled,
  setStatus,
  setTitle,
  type Task,
  type TaskChange,
  type TaskStatus,
  type TaskView,
} from "@openlfcp/shared-objects";
import { isObsidianTag, type ParsedTaskText } from "./task-text";

export type ProjectionDiagnosticCode =
  /** The bound object is not a valid Task: nothing is sent (item 10). */
  | "OBJECT_PROFILE_INVALID"
  /** Two concurrent objects under the Object ID (§21): nothing is sent. */
  | "OBJECT_ID_COLLISION"
  /** The object is deleted: nothing is sent. */
  | "OBJECT_DELETED"
  /** The object is not in the local replica (yet): nothing is sent. */
  | "OBJECT_UNKNOWN"
  /** The Resource is not stored locally: nothing is sent. */
  | "RESOURCE_UNKNOWN"
  /** The field is conflicted: no intent until it is explicitly resolved (item 8). */
  | "FIELD_CONFLICTED"
  /** The checkbox glyph or the shared status is not owned by the adapter (ST-1). */
  | "STATUS_NOT_OWNED"
  /** A field is written twice with different values on the line. */
  | "FIELD_AMBIGUOUS"
  /** A value the profile refuses (e.g. an impossible date, an empty title). */
  | "FIELD_INVALID"
  /** The shared title links to notes; their names are shared (ST-4). */
  | "TITLE_WIKILINK"
  /** 🔁 recurrence stays local (ST-5). */
  | "RECURRENCE_NOT_SYNCED"
  /** ✅ on a Task that is not done is not a completion date. */
  | "COMPLETION_IGNORED"
  /** The same object's projections in one file disagree: nothing is sent for the field. */
  | "PROJECTIONS_DISAGREE"
  /** A child ref seems to have slid under a new Task (ST-2): nothing is sent; repair offered. */
  | "REF_REASSOCIATION_SUSPECTED"
  /** A Task shared under LFCP-061 with tags in its title was migrated with a user edit (ruling a). */
  | "LEGACY_TAGS_MIGRATED";

export interface FieldIssue {
  readonly code: ProjectionDiagnosticCode;
  readonly field?: ScalarField | "tags" | "recurrence";
  readonly message: string;
}

export interface Plan {
  readonly intents: readonly ReplicaIntent[];
  readonly issues: readonly FieldIssue[];
  /** Whether the object could be compared at all (valid, live Task). */
  readonly comparable: boolean;
}

/** The Markdown side: the glyph's status (null: not owned) and the parsed text. */
export interface Represented {
  readonly status: TaskStatus | null;
  readonly text: ParsedTaskText;
}

const issue = (
  code: ProjectionDiagnosticCode,
  message: string,
  field?: FieldIssue["field"],
): FieldIssue => (field === undefined ? { code, message } : { code, field, message });

/** Warnings about what the line shares or keeps local, whatever the diff. */
export function lineWarnings(text: ParsedTaskText): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (text.wikilinks)
    out.push(
      issue(
        "TITLE_WIKILINK",
        "The title links to notes: their names are shared with collaborators.",
        "title",
      ),
    );
  if (text.recurrence !== null)
    out.push(
      issue(
        "RECURRENCE_NOT_SYNCED",
        "Recurrence (🔁) is not shared; collaborators do not see it.",
        "recurrence",
      ),
    );
  return out;
}

/** The intents that make `view` match what the Markdown represents. */
export function planIntents(represented: Represented, view: TaskView | undefined): Plan {
  const issues: FieldIssue[] = lineWarnings(represented.text);
  const none = (code: ProjectionDiagnosticCode, message: string): Plan => ({
    intents: [],
    issues: [...issues, issue(code, message)],
    comparable: false,
  });
  if (view === undefined) return none("OBJECT_UNKNOWN", "The shared Task is not here yet.");
  if (view.status === "object_id_collision")
    return none("OBJECT_ID_COLLISION", "Two shared objects use this ID; nothing is sent.");
  if (view.status !== "ready" || view.task === undefined)
    return none(
      "OBJECT_PROFILE_INVALID",
      `The shared Task is not valid (${view.problems.map((p) => p.diagnostic).join(", ")}); nothing is sent.`,
    );
  const shared = view.task;
  if (shared.lifecycle === "deleted")
    return none("OBJECT_DELETED", "The shared Task was deleted; nothing is sent.");
  // Ruling (a): a Task shared under LFCP-061 kept its trailing tags in the
  // title. While the shared title still ends with the Markdown's tag run, the
  // object is compared as if already migrated, and the migration (title
  // without the run, the run as tags) is sent only with a real user edit.
  const runText = represented.text.tags.map((t) => `#${t}`).join(" ");
  const legacy =
    represented.text.tags.length > 0 &&
    !view.fields.title.conflicted &&
    shared.title === `${represented.text.title} ${runText}`;
  const task: Task = legacy
    ? {
        ...shared,
        title: represented.text.title,
        tags: {
          ...shared.tags,
          ...Object.fromEntries(represented.text.tags.map((t) => [t.normalize("NFC"), true])),
        },
      }
    : shared;

  const intents: ReplicaIntent[] = [];
  const conflicted = (field: ScalarField): boolean => {
    if (!view.fields[field].conflicted) return false;
    issues.push(
      issue(
        "FIELD_CONFLICTED",
        `${field} has concurrent values; resolve the conflict to change it.`,
        field,
      ),
    );
    return true;
  };
  // A field written twice with different values is reported once and not sent.
  for (const field of represented.text.ambiguous)
    issues.push(issue("FIELD_AMBIGUOUS", `${field} is written twice with different values.`));
  const ambiguous = (field: ParsedTaskText["ambiguous"][number]): boolean =>
    represented.text.ambiguous.includes(field);
  const add = (
    field: ScalarField,
    build: () => TaskChange,
    reported: FieldIssue["field"] = field,
  ): void => {
    try {
      intents.push(build().intent);
    } catch (e) {
      if (!(e instanceof ProfileError)) throw e;
      issues.push(
        issue(
          "FIELD_INVALID",
          `${reported}: ${e.problems.map((p) => p.diagnostic).join(", ")}`,
          reported,
        ),
      );
    }
  };
  const { text } = represented;

  // Title.
  if (!conflicted("title") && text.title !== task.title)
    add("title", () => setTitle(task, text.title));

  // Status and completion date (ST-1, ST-5).
  const target = represented.status;
  const extension = task.status.startsWith("x/");
  let statusSent = false;
  if (target === null || extension) {
    issues.push(
      issue(
        "STATUS_NOT_OWNED",
        target === null
          ? "This checkbox state is not one the plugin shares; the shared status is unchanged."
          : `The shared status ${task.status} is not one the plugin edits.`,
        "status",
      ),
    );
  } else if (!conflicted("status") && target !== task.status) {
    statusSent = true;
    const date =
      target === "done" && !ambiguous("completion") && !view.fields.completion_date.conflicted
        ? (text.completion ?? undefined)
        : undefined;
    add("status", () => statusChange(task, target, date));
  }
  const done = target === "done" && !extension;
  if (text.completion !== null && !done)
    issues.push(
      issue("COMPLETION_IGNORED", "✅ is only shared on a done Task.", "completion_date"),
    );
  if (
    done &&
    !statusSent &&
    task.status === "done" &&
    text.completion !== null &&
    text.completion !== (task.completion_date ?? null) &&
    !ambiguous("completion") &&
    !conflicted("completion_date")
  )
    add("completion_date", () => complete(task, text.completion as string));

  // Dates.
  for (const [field, value, set, clear] of [
    ["due", text.due, setDue, clearDue],
    ["scheduled", text.scheduled, setScheduled, clearScheduled],
  ] as const) {
    if (ambiguous(field) || conflicted(field)) continue;
    if (value === (task[field] ?? null)) continue;
    add(field, () => (value === null ? clear(task) : set(task, value)));
  }

  // Priority (🔼 and extension priorities are not owned).
  if (!ambiguous("priority") && text.priority !== "unowned" && !task.priority.startsWith("x/")) {
    const priority = text.priority;
    if (!conflicted("priority") && priority !== task.priority)
      add("priority", () => setPriority(task, priority));
  }

  // Tags (ruling a): the trailing run is the tag set. Shared tags that cannot
  // be written as Obsidian tags are not represented, so never removed here.
  const markdownTags = new Set(represented.text.tags.map((t) => t.normalize("NFC")));
  for (const tag of markdownTags)
    if (task.tags[tag] !== true) add("title", () => addTag(task, tag), "tags");
  for (const tag of Object.keys(task.tags))
    if (isObsidianTag(tag) && !markdownTags.has(tag))
      add("title", () => removeTag(task, tag), "tags");

  if (legacy && intents.length > 0) {
    const migration: ReplicaIntent[] = [setTitle(shared, represented.text.title).intent];
    for (const tag of markdownTags)
      if (shared.tags[tag] !== true) migration.push(addTag(shared, tag).intent);
    // The migration's own tag adds replace the plan's (same tags).
    const rest = intents.filter(
      (i) =>
        !(i.intent === "task.add_tag" && markdownTags.has(i.tag)) && i.intent !== "task.set_title",
    );
    issues.push(
      issue(
        "LEGACY_TAGS_MIGRATED",
        "The title's trailing tags are now shared as the task's tags.",
        "tags",
      ),
    );
    return { intents: [...migration, ...rest], issues, comparable: true };
  }
  return { intents, issues, comparable: true };
}

function statusChange(task: Task, target: TaskStatus, completionDate?: string): TaskChange {
  switch (target) {
    case "done":
      return complete(task, completionDate);
    case "todo":
      return reopen(task);
    case "cancelled":
      return cancel(task);
    default:
      return setStatus(task, target);
  }
}
