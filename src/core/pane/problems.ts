// The problem hub of the Shared Tasks pane (LFCP-03-018; U03-06, U03-16,
// U03-25; F-04, F-05; OBSIDIAN-CONTEXTUAL-UX-03 §7). Each problem of the
// section in view, and of the note in view, is one row: what it is, where it
// comes from (a note and its line, the shared section, the sync server),
// and the one action that leads to its resolver. Pure: facts in, rows out.
//
//   - A conflict is keyed by its RecoveryItem.key: the review opens on that
//     item, after reading the items again (a resolved one is not reopened).
//   - A repair is keyed by its line key (sections/repair.ts keyedRepairs)
//     with the note's revision: before any action the note is parsed again
//     and the item found by its key, never by the old line number alone.
//   - Held edits, read-only, unsupported content and a damaged boundary say
//     their cause and their source.
//
// There is no "fix all" and no destructive default: every row's action
// opens a resolver, a details card or a line; discarding stays in the
// pane's menu with its confirmation. A row is gone only when the facts no
// longer have it (the status, the review items, the note's text): a click
// never hides a warning.

import type { ActionId } from "../actions/catalog";
import { ACCESS_HELD, REPAIR_HELD } from "../actions/descriptors";
import type { ProblemTarget } from "../actions/dispatcher";
import type { RecoveryItem } from "../sections/recovery";
import type { KeyedRepair } from "../sections/repair";
import { type HeldCause, type HeldEdits, heldCauseText } from "../status/held";
import type { StatusView } from "../status/reducer";

/**
 * What a problem row's action is about, beyond the section: a conflict or a
 * repair item (the dispatcher's ProblemTarget), or a place in a note (held
 * edits: the line as the last pass found it).
 */
export type ProblemRef =
  | ProblemTarget
  | { readonly kind: "at"; readonly path: string; readonly line: number };

export type ProblemCategory =
  | "access"
  | "read-only"
  | "held"
  | "boundary"
  | "binding"
  | "unsupported"
  | "base"
  | "conflict";

export interface PaneProblem {
  /** Stable while the problem is the same one at the same place (L2: a click checks it). */
  readonly id: string;
  readonly category: ProblemCategory;
  /** What it is, and why. */
  readonly text: string;
  /** Where it comes from: a note and its line, the shared section, the sync server. */
  readonly source: string;
  /** The action that leads to its resolver; null: nothing to do here but read it. */
  readonly action: ActionId | null;
  readonly ref: ProblemRef | null;
}

/** The repair items of the note in view, at its revision. */
export interface NoteRepairs {
  readonly path: string;
  readonly revision: string;
  readonly items: readonly KeyedRepair[];
}

export interface ProblemFacts {
  /** The section in view (its StatusView), or null. */
  readonly view: StatusView | null;
  /** Its review items (conflicts, kept work, reappeared nodes); empty when none or not loaded. */
  readonly recovery: readonly RecoveryItem[];
  /** The note in view's repair items, or null without a note. */
  readonly repairs: NoteRepairs | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const where = (path: string, line: number) => `${path}, line ${line + 1}`;

const FIELD: Readonly<Record<string, string>> = {
  title: "title",
  status: "status",
  due: "due date",
  scheduled: "scheduled date",
  priority: "priority",
};

/** A review item in a few words (the resolver asks the full question). */
export function conflictText(item: RecoveryItem): string {
  switch (item.kind) {
    case "stale-work":
      return `An offline edit could not be sent after an access change: ${item.label}.`;
    case "title":
      return "The section's title was changed in two ways.";
    case "field":
      return `The ${FIELD[item.field] ?? item.field} of ${item.label} was changed in two ways.`;
    case "placement":
      return `${item.label} was moved to two places.`;
    case "cycle":
      return "Items were moved under each other.";
    case "lifecycle":
      return `${item.label} was deleted and restored at the same time.`;
    case "retained":
      return item.ancestor === item.nodeId
        ? `${item.label} was changed while it was deleted.`
        : `${item.label} was changed while ${item.ancestorLabel}, which holds it, was deleted.`;
    case "reappeared":
      return `${item.label} is in a note, but it was deleted from the shared section.`;
  }
}

function conflictSource(item: RecoveryItem): string {
  if (item.kind === "stale-work") return "Kept on this device";
  if (item.kind === "reappeared") return "A note on this device";
  return "The shared section";
}

/** A repair item in a few words. */
function repairText(k: KeyedRepair): { text: string; category: ProblemCategory } {
  const item = k.item;
  if (item.kind === "missing-end")
    return { text: "A shared section has a start marker and no end.", category: "boundary" };
  if (item.kind === "missing-start")
    return { text: "A shared section's end marker has no start.", category: "boundary" };
  const category: ProblemCategory = item.message.startsWith("Section boundary")
    ? "boundary"
    : item.message.startsWith("This content")
      ? "unsupported"
      : "binding";
  return { text: item.message, category };
}

const HELD_CATEGORY: Readonly<Record<HeldCause, ProblemCategory>> = {
  unsupported: "unsupported",
  binding: "binding",
  boundary: "boundary",
  "read-only": "read-only",
  revoked: "access",
  refused: "access",
  rejected: "held",
  "base-unknown": "base",
};

/** Held edits: their count, cause and source, and the way to their resolver. */
function heldProblem(h: HeldEdits): PaneProblem {
  const count = h.count === null ? "Edits" : plural(h.count, "edit");
  const action: ActionId =
    h.cause === "unsupported"
      ? "go-to-problem"
      : REPAIR_HELD.has(h.cause)
        ? "repair-sections"
        : "review-local-changes";
  return {
    id: `held:${h.projectionId}:${h.cause}`,
    category: HELD_CATEGORY[h.cause],
    text: `${count} not sent: ${heldCauseText(h)}.`,
    source: where(h.path, h.line),
    action,
    ref: { kind: "at", path: h.path, line: h.line },
  };
}

/** This vault's access or the server's refusal, as a problem with its source (F3: four states). */
function accessProblems(v: StatusView): PaneProblem[] {
  const out: PaneProblem[] = [];
  const held = v.held.some((h) => ACCESS_HELD.has(h.cause));
  const action: ActionId = held ? "review-local-changes" : "open-details";
  for (const c of v.conditions) {
    if (c.kind === "access") {
      const text =
        c.access === "revoked"
          ? "Your access to this section was removed. Your local copy stays."
          : c.access === "not-member"
            ? "This vault is not a member of this section."
            : c.access === "refused"
              ? "The sync server no longer accepts changes from this vault for this section."
              : "This device does not hold the section's key yet.";
      const source =
        c.access === "refused"
          ? "The sync server"
          : c.access === "unavailable-key"
            ? "This device"
            : v.access.current === true
              ? "This vault's access, as checked with the server"
              : "This vault's access, as this device last verified it";
      out.push({ id: `access:${c.access}`, category: "access", text, source, action, ref: null });
    } else if (c.kind === "server-refused")
      out.push({
        id: `server-refused:${c.code}`,
        category: "access",
        text: `The sync server refused this section (${c.code}).`,
        source: "The sync server",
        action,
        ref: null,
      });
  }
  return out;
}

/**
 * The problem rows, in a stable order: access and refusal, held edits this
 * vault may not send, the note's repairs and the held copies to repair,
 * unsupported content, then conflicts.
 */
export function paneProblems(f: ProblemFacts): PaneProblem[] {
  const v = f.view;
  const repairs = f.repairs;
  const access = v === null ? [] : accessProblems(v);
  const held = v === null ? [] : [...v.held].sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
  // A held copy in the note in view whose repair items are listed is shown by them, line by line.
  const shownByRepairs = (h: HeldEdits) =>
    repairs !== null &&
    repairs.items.length > 0 &&
    h.path === repairs.path &&
    (h.cause === "boundary" || h.cause === "binding" || h.cause === "unsupported");
  const heldRows = held.filter((h) => !shownByRepairs(h)).map(heldProblem);
  const repairRows: PaneProblem[] = (repairs?.items ?? []).map((k) => {
    const { text, category } = repairText(k);
    return {
      id: `repair:${repairs?.path}:${k.key}:${k.item.line}`,
      category,
      text,
      source: where(repairs?.path ?? "", k.item.line),
      // A boundary has its resolver in the repair dialog; anything else is edited at its line.
      action: k.item.kind === "locate" ? "go-to-problem" : "repair-sections",
      ref: {
        kind: "repair",
        path: repairs?.path ?? "",
        key: k.key,
        line: k.item.line,
        revision: repairs?.revision ?? "",
      },
    };
  });
  const order: readonly ProblemCategory[] = [
    "access",
    "read-only",
    "held",
    "boundary",
    "binding",
    "base",
    "unsupported",
  ];
  const rank = (p: PaneProblem) => order.indexOf(p.category);
  const local = [...heldRows, ...repairRows]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
  const conflicts: PaneProblem[] = f.recovery.map((item) => ({
    id: `conflict:${item.key}`,
    category: "conflict",
    text: conflictText(item),
    source: conflictSource(item),
    action: "review-conflicts",
    ref: { kind: "conflict", key: item.key },
  }));
  return [...access, ...local, ...conflicts];
}
