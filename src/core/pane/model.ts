// The view model of the Shared Tasks pane (LFCP-03-007; UX contract
// docs/architecture/ux-contract-0.3.md). Pure: facts in, what the pane
// shows out. No Obsidian, no DOM, no side effect; the renderer
// (src/obsidian/ui/pane-renderer.ts) only lays the model out.
//
//   (context, registry, section status, flow) → PaneModel
//
// The section's status is the one status path: its StatusView (LFCP-03-003,
// 005), never re-derived here. The primary call to action follows P1 by
// the view's first condition, so the card's first problem and the pane's
// primary action never disagree. Every disabled action states its reason;
// a disabled button is never the only guard (the executor checks again).

import { rowLabel } from "../sections/registry-view";
import { SHARE_SCOPE, type ShareWarning, shareCounts, shareWarningText } from "../sections/share";
import { HELD_CAUSE, type HeldCause } from "../status/held";
import { type Condition, STATE_LABEL, type StatusState, type StatusView } from "../status/reducer";
import { ACTIONS, type ActionId, SOURCE_CHANGING } from "./actions";
import {
  FLOW_STAGES,
  FLOW_TITLE,
  type FlowKind,
  type FlowOutcome,
  flowAction,
  stageOf,
} from "./flows";

/** Why a selection cannot be shared exactly (UX §4.2). */
export type SelectionReason =
  | "no-heading-start"
  | "partial-line"
  | "crossing"
  | "nested-heading"
  | "partial-block"
  | "unclosed-fence"
  | "already-bound"
  | "legacy-tasks"
  | "broken-ref";

export interface PaneSelection {
  readonly fromLine: number;
  readonly toLine: number;
  readonly eligibility: "exact" | "ineligible";
  readonly reason: SelectionReason | null;
  readonly fallback: "share-whole-section" | null;
  /** The line a reason names (1-based), when it names one. */
  readonly line?: number;
}

export interface PaneFlow {
  readonly kind: FlowKind;
  /** The stage ID (flows.ts FLOW_STAGES; a journal's own stage name where one exists). */
  readonly stage: string;
  readonly outcome: FlowOutcome;
  /** The note the flow captured before its preview (T2): it does not follow the active note. */
  readonly target?: string;
}

export interface PaneContext {
  readonly editor: "none" | "source" | "live-preview" | "reading";
  /** The last active Markdown note (T1); null when none is open. */
  readonly note: string | null;
  readonly cursor: "none" | "private-heading" | "private-text" | "inside-section";
  readonly selection: PaneSelection | null;
  /** The flow that owns the current area (running, unknown result or unfinished), if any. */
  readonly flow: PaneFlow | null;
}

/** One row of the section list (from SectionRegistryView's RegistryRow). */
export interface PaneRow {
  readonly key: string;
  readonly sharedTitle: string | null;
  readonly localAlias: string | null;
  /** Notes holding a copy, as found so far (local paths). */
  readonly notes: readonly string[];
  /** "unplaced" only with a complete placement index (registry-view.ts). */
  readonly placed: "placed" | "unplaced" | "unknown";
  /** null: unknown, never healthy. */
  readonly state: StatusState | null;
}

export interface PaneRegistry {
  readonly status: "loading" | "ready" | "error";
  readonly placementIndex: "building" | "complete" | "unknown";
  /** null unless ready. */
  readonly sections: number | null;
  /** null unless ready and the index is complete. */
  readonly unplaced: number | null;
  /** The rows to list; absent: only the summary is known. */
  readonly rows?: readonly PaneRow[];
}

/** The section the pane is about: under the cursor, or chosen in the list. */
export interface PaneSection {
  readonly key: string;
  readonly sharedTitle: string | null;
  readonly localAlias: string | null;
  /** Notes with a copy; null until the placement index is complete. */
  readonly placements: number | null;
  /** The one status path (StatusView of SectionsHost). */
  readonly view: StatusView;
  /** From the access list (AccessView), not the status facts; null: not known. */
  readonly canInvite: boolean | null;
  /** On its server ("pending": a local-only share, not an invitation that is ready, I4). */
  readonly hosting?: "hosted" | "pending" | "unknown";
}

/** A share preview's facts (share.ts SharePreview), for the pane's summary of it. */
export interface PanePreview {
  readonly counts: {
    readonly tasks: number;
    readonly paragraphs: number;
    readonly items: number;
    readonly raw: number;
  };
  readonly warnings: readonly ShareWarning[];
  /** Blocking problems, in the preview's words. */
  readonly problems: readonly string[];
}

export interface PaneFacts {
  readonly context: PaneContext;
  readonly registry: PaneRegistry;
  readonly section: PaneSection | null;
  readonly preview?: PanePreview;
  /** Setup incomplete (no server, sections off), with the exact reason; null or absent: complete. */
  readonly setup?: { readonly reason: string } | null;
  /** Other unfinished flows, besides the context's (P2). */
  readonly unfinished?: readonly PaneFlow[];
  /** A short confirmation of the last step, e.g. "Link copied" (I3). */
  readonly notice?: string | null;
}

export interface PaneOptions {
  /** Local time of a verification (ms); the default is the locale's. */
  readonly time?: (ms: number) => string;
}

export interface PaneAction {
  readonly id: ActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, in words (A3); null when enabled. */
  readonly reason: string | null;
  readonly destructive: boolean;
}

export interface PaneLine {
  readonly text: string;
  /** "problem" first; "ok" only for the verified current sentence. */
  readonly tone: "problem" | "info" | "ok";
}

export interface PaneStep {
  readonly label: string;
  readonly state: "done" | "current" | "todo";
}

export interface PaneFlowView {
  readonly kind: FlowKind;
  readonly outcome: FlowOutcome;
  readonly title: string;
  /** The captured target (T2); null when the flow has none yet. */
  readonly target: string | null;
  readonly steps: readonly PaneStep[];
  readonly lines: readonly string[];
  /** An effect is under way: no next step, only progress (P1 row 2). */
  readonly waiting: boolean;
}

export interface PaneRowView {
  readonly key: string;
  readonly label: string;
  /** "On this device: …" (N2), or null. */
  readonly alias: string | null;
  readonly status: string;
  readonly places: string;
}

export interface PaneGroup {
  readonly id: "in-note" | "elsewhere" | "not-inserted" | "unknown";
  readonly title: string;
  readonly rows: readonly PaneRowView[];
}

export interface PaneModel {
  readonly title: string;
  /** "Join with a link…", in the header in every state (A2). */
  readonly join: PaneAction;
  /** The field for a pasted invitation link (I5): shown while a join waits for it. */
  readonly joinField: boolean;
  /** The current area: the note, section or selection; the flow's target while a flow owns it. */
  readonly context: { readonly heading: string; readonly lines: readonly string[] };
  readonly flow: PaneFlowView | null;
  /** Short status, problems first. */
  readonly status: readonly PaneLine[];
  /** The share preview's summary, when one is shown. */
  readonly preview: readonly string[];
  /** At most one; never destructive (A1). */
  readonly primary: PaneAction | null;
  /** Why there is no primary action. */
  readonly primaryNone: string | null;
  /** Other actions, enabled or with their reason. */
  readonly secondary: readonly PaneAction[];
  /** Destructive actions: a menu, each with its existing confirmation (A1). */
  readonly menu: readonly PaneAction[];
  readonly sections: { readonly summary: string | null; readonly groups: readonly PaneGroup[] };
  readonly unfinished: readonly { readonly title: string; readonly detail: string }[];
  readonly notice: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sentence of an ineligible selection (UX §4.2), with its line where it names one. */
export function selectionReasonText(s: PaneSelection): string {
  const n = s.line ?? s.fromLine;
  switch (s.reason) {
    case "no-heading-start":
      return "A shared section starts at its heading. Your selection does not.";
    case "partial-line":
      return "The selection ends in the middle of a line. Select whole lines.";
    case "crossing":
      return "The selection runs past the end of the heading's section.";
    case "nested-heading":
      return `Line ${n} is a heading inside the selection. Share each part as its own section.`;
    case "partial-block":
      return `The selection ends in the middle of a paragraph or list item (line ${n}). End it at a blank line.`;
    case "unclosed-fence":
      return `A code block from line ${n} is not closed. Close it before sharing.`;
    case "already-bound":
      return `Line ${n} is already part of a shared section.`;
    case "legacy-tasks":
      return "Tasks in the selection are already shared in another collaboration.";
    case "broken-ref":
      return `The shared task marker on line ${n} is damaged. Repair it before sharing.`;
    case null:
      return "";
  }
}

/** Held edits kept because this vault may not send them: reviewed, not repaired. */
const ACCESS_HELD: ReadonlySet<HeldCause> = new Set([
  "read-only",
  "revoked",
  "refused",
  "rejected",
]);
const REPAIR_HELD: ReadonlySet<HeldCause> = new Set(["boundary", "binding", "base-unknown"]);
const DENIED = new Set(["refused", "revoked", "not-member"]);

/** Row 6 of P1: the first source condition, mapped by that projection's own facts. */
function sourcePrimary(v: StatusView, c: Extract<Condition, { kind: "source" }>): ActionId {
  const held = v.held.find((h) => h.projectionId === c.projectionId);
  if (c.source === "binding-error" || (held !== undefined && REPAIR_HELD.has(held.cause)))
    return "repair-sections";
  if (c.source === "unsupported" || held?.cause === "unsupported") return "go-to-problem";
  // "diverged" with a clean source and held edits is the reducer's synthetic value.
  if (held !== undefined && ACCESS_HELD.has(held.cause)) return "review-local-changes";
  return "repair-sections";
}

/** Why the section is not connected, as the card says it (UX §6): never "failed" without an attempt. */
function connectionText(v: StatusView): string | null {
  switch (v.connection) {
    case "connected":
      return null;
    case "connecting":
      return "Connecting to the server: not checked with it yet. Local updates wait on this device.";
    case "failed":
      return v.connectionQualifier === "not-responding"
        ? "The server stopped responding and connecting again failed; trying again. Local updates wait on this device."
        : "Could not connect to the server; trying again. Local updates wait on this device.";
    case "offline":
      return v.connectionQualifier === "network-offline"
        ? "Offline (no network): local updates wait on this device."
        : v.connectionQualifier === "not-responding"
          ? "Offline: the server stopped responding, reconnecting. Local updates wait on this device."
          : "Offline: local updates wait on this device.";
  }
}

function conditionText(c: Condition, v: StatusView): string | null {
  const asOf =
    v.access.current === true
      ? ""
      : " This is as this device last verified it; it may have changed.";
  switch (c.kind) {
    case "save-failed":
      return "Some local changes are not safely saved for sync. Keep the note open; nothing was sent for them.";
    case "access":
      switch (c.access) {
        case "refused":
          return "The sync server no longer accepts changes from this vault for this section.";
        case "revoked":
          return `Your access to this section was removed. Your local copy stays.${asOf}`;
        case "not-member":
          return `This vault is not a member of this section.${asOf}`;
        default:
          return "This device does not hold the section's key yet. Edits wait until it arrives.";
      }
    case "server-refused":
      return `The sync server refused this section (${c.code}). Your local copy stays.`;
    case "invalid-profile":
      return "This section's data is not valid for this version of Shared Tasks.";
    case "rejected":
      return `The server refused ${plural(c.batchIds.length, "update")} (${c.code}). The text stays in your note.`;
    case "stale-work":
      return c.review > 0
        ? `${plural(c.review, "offline edit")} could not be sent after an access change. Your note keeps them until you review them.`
        : `${plural(c.pending, "offline edit")} from before an access change ${c.pending === 1 ? "is" : "are"} being sent again.`;
    case "held-unknown":
      return "Not current: whether a note with this section holds edits not sent is unknown.";
    case "structural-conflict":
      return `A structure conflict touches ${plural(c.nodeIds.length, "item")}: their place in your note waits for your choice.`;
    case "scalar-conflict":
      return `Conflicting edits on ${plural(c.nodeIds.length, "item")}: both values are kept until you choose.`;
    default:
      return null;
  }
}

function statusLines(s: PaneSection, o: PaneOptions): PaneLine[] {
  const v = s.view;
  const kinds = new Set(v.conditions.map((c) => c.kind));
  const problems: PaneLine[] = [];
  const info: PaneLine[] = [];
  for (const c of v.conditions) {
    const text = conditionText(c, v);
    if (text !== null) problems.push({ text, tone: "problem" });
  }
  // F-04: edits held in a note come first among the facts, counted, with their cause (§6).
  for (const h of v.held)
    problems.push({
      text: `${h.count === null ? "Edits" : plural(h.count, "edit")} not sent: ${HELD_CAUSE[h.cause]} (${h.path}, line ${h.line + 1}).`,
      tone: "problem",
    });
  const q = v.sync.queue;
  if (q.batches > 0)
    info.push({
      text: q.counted ? `${plural(q.batches, "local update")} waiting` : "Local updates waiting",
      tone: "info",
    });
  else if (v.held.length > 0)
    info.push({
      text: "No updates waiting in the sync queue: the edits held in your note are not in it.",
      tone: "info",
    });
  else if (kinds.has("held-unchecked"))
    info.push({
      text: "No updates waiting in the sync queue. Notes with this section are still being checked for edits not sent.",
      tone: "info",
    });
  if (kinds.has("local-edit")) info.push({ text: "Local changes are being saved", tone: "info" });
  const denied = DENIED.has(v.access.access) || kinds.has("server-refused");
  const connection = denied ? null : connectionText(v);
  if (connection !== null) info.push({ text: connection, tone: "info" });
  if (s.hosting === "pending")
    info.push({
      text: "Not on its server yet: nobody can join until it is hosted.",
      tone: "info",
    });
  if (v.sync.current)
    info.push({
      text: "Current as last checked with the server. This does not mean others have seen it.",
      tone: "ok",
    });
  if (v.access.access === "reader")
    info.push({ text: "You can read this section, not edit it.", tone: "info" });
  if (kinds.has("access-checking"))
    info.push({ text: "Access is being checked with the server.", tone: "info" });
  if (v.access.current === false && v.access.verifiedAt !== null && !denied) {
    const time = (o.time ?? ((ms: number) => new Date(ms).toLocaleString()))(v.access.verifiedAt);
    info.push({ text: `Access as last verified ${time}; it may have changed.`, tone: "info" });
  }
  return [...problems, ...info];
}

/** "Sprint", "Launch (name on this device)" (N1–N3). */
function sectionLabel(s: Pick<PaneSection, "sharedTitle" | "localAlias">): {
  label: string;
  alias: string | null;
} {
  const l = rowLabel(s);
  return {
    label:
      l.primary === null
        ? "Untitled section"
        : l.aliasOnly
          ? `${l.primary} (name on this device)`
          : l.primary,
    alias: l.onThisDevice === null ? null : `On this device: ${l.onThisDevice}`,
  };
}

/** Where a section's copies are; nothing when not known and nothing is being looked for. */
function placementText(
  placements: number | null,
  index: PaneRegistry["placementIndex"],
): string | null {
  if (placements === null || (placements === 0 && index !== "complete"))
    return index === "building" ? "Looking for copies in your notes…" : null;
  if (placements === 0) return "Not inserted yet";
  return `In ${plural(placements, "note")}`;
}

function flowLines(flow: PaneFlow): string[] {
  const stage = stageOf(flow.kind, flow.stage);
  if (flow.outcome === "unknown") {
    switch (flow.kind) {
      case "join":
        return [
          "The server did not confirm the claim. The claim is kept on this device.",
          "Check the result: it resumes the same claim with the same link, never a new one.",
        ];
      case "insert":
        return [
          "The note was written; whether its copy was registered is not known yet.",
          "Check the result: it resumes the same insert operation.",
        ];
      default:
        return [
          `The last step (${stage.label.toLowerCase()}) started and its result is not known yet.`,
          "Check the result: it resumes the same operation.",
        ];
    }
  }
  if (flow.outcome === "unfinished")
    return [`Stopped before: ${stage.label.toLowerCase()}. Continue resumes the same operation.`];
  const lines: string[] = [];
  if (flow.kind === "invite") {
    lines.push("One-time link, does not expire; whoever opens it first joins.");
    lines.push("Treat it like a password.");
  }
  if (stage.waits === "effect") lines.push(`${stage.label}…`);
  return lines;
}

function flowView(flow: PaneFlow): PaneFlowView {
  const stages = FLOW_STAGES[flow.kind];
  const at = stages.findIndex((s) => s.id === flow.stage);
  return {
    kind: flow.kind,
    outcome: flow.outcome,
    title: FLOW_TITLE[flow.kind],
    target: flow.target ?? null,
    steps: stages.map((s, i) => ({
      label: s.label,
      state: at < 0 ? "todo" : i < at ? "done" : i === at ? "current" : "todo",
    })),
    lines: flowLines(flow),
    waiting: flow.outcome === "running" && stageOf(flow.kind, flow.stage).waits === "effect",
  };
}

function sectionGroups(f: PaneFacts): { summary: string | null; groups: PaneGroup[] } {
  const r = f.registry;
  const summary =
    r.status === "loading"
      ? "Reading the shared sections on this device…"
      : r.status === "error"
        ? "The list of shared sections could not be read again; it shows the last one."
        : r.sections === 0
          ? "No shared sections on this device yet."
          : r.sections === null
            ? null
            : `${plural(r.sections, "shared section")} on this device`;
  const rows = r.rows ?? [];
  const view = (row: PaneRow): PaneRowView => {
    const l = sectionLabel(row);
    return {
      key: row.key,
      label: l.label,
      alias: l.alias,
      status: row.state === null ? "Status not known yet" : STATE_LABEL[row.state],
      places:
        row.placed === "unplaced"
          ? "Not inserted yet"
          : row.placed === "unknown"
            ? "Looking for copies in your notes…"
            : `In ${plural(row.notes.length, "note")}`,
    };
  };
  const note = f.context.note;
  const groups: PaneGroup[] = [
    {
      id: "in-note",
      title: "In this note",
      rows: rows.filter((x) => note !== null && x.notes.includes(note)).map(view),
    },
    {
      id: "elsewhere",
      title: "Placed elsewhere",
      rows: rows
        .filter((x) => x.placed === "placed" && (note === null || !x.notes.includes(note)))
        .map(view),
    },
    {
      id: "not-inserted",
      title: "Not inserted yet",
      rows: rows.filter((x) => x.placed === "unplaced").map(view),
    },
    {
      id: "unknown",
      title: "Looking for copies in your notes…",
      rows: rows.filter((x) => x.placed === "unknown" && x.notes.length === 0).map(view),
    },
  ];
  return { summary, groups: groups.filter((g) => g.rows.length > 0) };
}

type Avail = { readonly enabled: boolean; readonly reason: string | null };

/** Which actions apply, enabled or with their reason. */
function availability(f: PaneFacts): Map<ActionId, Avail> {
  const a = new Map<ActionId, Avail>();
  const on = (id: ActionId) => a.set(id, { enabled: true, reason: null });
  const off = (id: ActionId, reason: string) => a.set(id, { enabled: false, reason });
  const ctx = f.context;
  const s = f.section;
  const v = s?.view;
  const flow = ctx.flow;
  const running = flow?.outcome === "running" ? flow : null;
  const next =
    running !== null && stageOf(running.kind, running.stage).waits === "user"
      ? flowAction(running.kind, running.stage)
      : null;
  const noteOpen = ctx.editor !== "none";
  const reading = ctx.editor === "reading";
  const busy = "A flow is open; finish or cancel it first.";

  // A2: join stays in the header; a join already under way is revealed, never started twice (A4).
  if (next === "join-with-link") on("join-with-link");
  else if (flow?.kind === "join" && flow.outcome !== "unfinished")
    off("join-with-link", "A join is in progress. Finish it first.");
  else if (flow?.kind === "join") off("join-with-link", "A join is unfinished: continue it.");
  else on("join-with-link");

  const sel = ctx.selection;
  if (next === "share-section") on("share-section");
  else if (flow?.kind === "share" && flow.outcome !== "unfinished")
    off("share-section", "A share is in progress. Finish it first.");
  else if (running !== null) off("share-section", busy);
  else if (!noteOpen) off("share-section", "Open a note to share a section from it.");
  else if (sel?.eligibility === "ineligible") off("share-section", selectionReasonText(sel));
  else if (ctx.cursor === "inside-section")
    off("share-section", "The cursor is inside a shared section.");
  else if (f.setup) off("share-section", f.setup.reason);
  else if (reading) off("share-section", "Open the note for editing to share from it.");
  else on("share-section");

  if (sel?.eligibility === "ineligible") {
    if (sel.fallback === null)
      off("share-whole-section", "No single heading's section contains the selection.");
    else if (running !== null) off("share-whole-section", busy);
    else if (reading) off("share-whole-section", "Open the note for editing to share from it.");
    else on("share-whole-section");
  }

  if (next === "insert-into-note") on("insert-into-note");
  else if (flow?.kind === "insert" && flow.outcome === "unknown")
    off("insert-into-note", "This note already has a section being inserted. Finish that first.");
  else if (flow?.kind === "insert" && flow.outcome === "unfinished")
    off("insert-into-note", "An insert into this note is unfinished: continue it.");
  else if (running !== null) off("insert-into-note", busy);
  else if (s !== null || (f.registry.sections ?? 0) > 0) on("insert-into-note");

  if (flow?.outcome === "unknown") on("check-result");
  if (flow?.outcome === "unfinished" || (f.unfinished?.length ?? 0) > 0) on("continue-flow");
  if (reading) on("open-for-editing");
  if (f.setup) on("open-settings");

  if (!noteOpen) off("copy-readable", "No note is open.");
  else if (ctx.cursor === "inside-section" && s !== null) on("copy-readable");

  if (s === null || v === undefined) {
    if (next === "invite") on("invite");
    return a;
  }

  // I4: ready means hosted, with access current; inviting comes from the access list.
  if (next === "invite") on("invite");
  else if (running !== null) off("invite", busy);
  else if (s.canInvite === false) off("invite", "You can't invite others to this section.");
  else if (s.hosting === "pending")
    off("invite", "Not on its server yet: nobody can join until it is hosted.");
  else if (s.canInvite === null || v.access.current !== true || v.access.checking)
    off("invite", "Inviting waits until this device has checked access with the server.");
  else on("invite");

  on("open-details");
  const kinds = new Set(v.conditions.map((c) => c.kind));
  if (v.sync.queue.batches > 0 || kinds.has("offline")) on("sync-details");
  if (v.held.some((h) => ACCESS_HELD.has(h.cause))) on("review-local-changes");
  if (
    kinds.has("structural-conflict") ||
    kinds.has("scalar-conflict") ||
    v.conditions.some((c) => c.kind === "stale-work" && c.review > 0)
  )
    on("review-conflicts");
  const repair =
    v.held.some((h) => REPAIR_HELD.has(h.cause)) ||
    v.conditions.some(
      (c) =>
        c.kind === "source" &&
        (c.source === "binding-error" ||
          c.source === "base-unknown" ||
          (c.source === "diverged" && !v.held.some((h) => h.projectionId === c.projectionId))),
    );
  if (repair) {
    if (next === "repair-sections" || (running === null && !reading)) on("repair-sections");
    else if (running !== null) off("repair-sections", busy);
    else off("repair-sections", "Open the note for editing to repair it.");
  }
  if (
    v.held.some((h) => h.cause === "unsupported" || REPAIR_HELD.has(h.cause)) ||
    v.conditions.some((c) => c.kind === "source" && c.source === "unsupported")
  )
    on("go-to-problem");

  // Destructive: secondary, each with its existing confirmation (A1).
  if (s.canInvite !== false) {
    if (v.connection !== "connected")
      off("remove-access", "Removing access needs a connection to the section's server.");
    else if (v.access.current !== true || v.access.checking)
      off(
        "remove-access",
        "Removing access waits until this device has checked access with the server.",
      );
    else on("remove-access");
  }
  if (v.held.some((h) => ACCESS_HELD.has(h.cause))) on("discard-local-copy");
  if (ctx.cursor === "inside-section") {
    if (reading) off("detach-section", "Open the note for editing to detach it.");
    else on("detach-section");
  }
  return a;
}

/** P1: the first matching row decides the primary action; null with the reason when none. */
function primaryOf(
  f: PaneFacts,
  a: ReadonlyMap<ActionId, Avail>,
): { id: ActionId | null; none: string | null } {
  const ctx = f.context;
  const s = f.section;
  const v = s?.view;
  const conditions = v?.conditions ?? [];
  const flow = ctx.flow;
  const ordinary = (): { id: ActionId | null; none: string | null } => {
    if (f.setup) return { id: "open-settings", none: null };
    if (ctx.editor === "none")
      return {
        id: null,
        none: "No note: the context area has no action. Join and the section list stay available.",
      };
    const sel = ctx.selection;
    if (sel?.eligibility === "exact") return { id: "share-section", none: null };
    if (sel?.eligibility === "ineligible")
      return sel.fallback === null
        ? { id: null, none: "No fallback: only the reason is shown." }
        : { id: "share-whole-section", none: null };
    if (ctx.cursor === "private-heading") return { id: "share-section", none: null };
    if (s !== null && v !== undefined) {
      if (s.placements === 0 && f.registry.placementIndex === "complete")
        return { id: "insert-into-note", none: null };
      if (a.get("invite")?.enabled === true && v.sync.current) return { id: "invite", none: null };
      return { id: "open-details", none: null };
    }
    return {
      id: null,
      none: "Put the cursor on a heading, or select a section, to share it.",
    };
  };
  const pick = (): { id: ActionId | null; none: string | null } => {
    const first = conditions[0];
    // Row 1: a local save failure comes before everything, flows too.
    if (first?.kind === "save-failed") return { id: "open-details", none: null };
    // Row 2: a running flow's next step; none while an effect is under way.
    if (flow?.outcome === "running") {
      const stage = stageOf(flow.kind, flow.stage);
      if (stage.waits === "effect") return { id: null, none: `${stage.label}: in progress.` };
      // The join field's own Join button is this step; the header's entry stays as it is (A2).
      if (flow.kind === "join" && flow.stage === "link")
        return { id: null, none: "Paste the invitation link above and choose Join." };
      return { id: flowAction(flow.kind, flow.stage), none: null };
    }
    // Row 3: an unknown result is checked, never retried as new.
    if (flow?.outcome === "unknown") return { id: "check-result", none: null };
    if (first !== undefined && v !== undefined)
      switch (first.kind) {
        case "access":
        case "server-refused":
        case "invalid-profile":
          return { id: v.held.length > 0 ? "review-local-changes" : "open-details", none: null };
        case "rejected":
        case "stale-work":
          return {
            id: conditions.some((c) => c.kind === "stale-work" && c.review > 0)
              ? "review-conflicts"
              : "review-local-changes",
            none: null,
          };
        case "source":
          return { id: sourcePrimary(v, first), none: null };
        case "held-unknown":
        case "loading":
        case "access-checking":
        case "held-unchecked":
        case "connecting":
          return { id: "open-details", none: null };
        case "structural-conflict":
        case "scalar-conflict":
          return { id: "review-conflicts", none: null };
        default:
          // Row 10: offline or queued with no other problem → sync details; else §5.1.
          if (conditions.some((c) => c.kind === "offline" || c.kind === "pending"))
            return { id: "sync-details", none: null };
          return ordinary();
      }
    // Row 12: an unfinished flow.
    if (flow?.outcome === "unfinished" || (f.unfinished?.length ?? 0) > 0)
      return { id: "continue-flow", none: null };
    return ordinary();
  };
  const p = pick();
  // T4: in Reading view a source-changing primary becomes "Open for editing".
  if (p.id !== null && ctx.editor === "reading" && SOURCE_CHANGING.has(p.id))
    return { id: "open-for-editing", none: null };
  if (p.id !== null && a.get(p.id)?.enabled !== true)
    return { id: null, none: a.get(p.id)?.reason ?? "Not available now." };
  return p;
}

const action = (id: ActionId, x: Avail): PaneAction => ({
  id,
  label: ACTIONS[id].label,
  enabled: x.enabled,
  reason: x.reason,
  destructive: ACTIONS[id].destructive,
});

function contextArea(f: PaneFacts): { heading: string; lines: string[] } {
  const ctx = f.context;
  // A running flow or one whose result is unknown owns the current area (P2); an unfinished one is listed.
  const flow = ctx.flow?.outcome === "unfinished" ? null : ctx.flow;
  const lines: string[] = [];
  if (flow?.target !== undefined) {
    if (ctx.note !== null && ctx.note !== flow.target)
      lines.push(`The active note is ${ctx.note}; this stays on ${flow.target}.`);
    return { heading: `For ${flow.target}`, lines };
  }
  const s = f.section;
  if (s !== null) {
    const l = sectionLabel(s);
    lines.push(l.label);
    if (l.alias !== null) lines.push(l.alias);
    const places = placementText(s.placements, f.registry.placementIndex);
    if (places !== null) lines.push(places);
  }
  const sel = ctx.selection;
  if (sel !== null)
    lines.push(
      sel.eligibility === "exact"
        ? `Selection: lines ${sel.fromLine}–${sel.toLine}`
        : selectionReasonText(sel),
    );
  else if (ctx.cursor === "private-heading") lines.push("On a heading that is not shared");
  if (ctx.editor === "reading") lines.push("Reading view: open the note for editing to change it.");
  if (ctx.note === null) return { heading: "No note open", lines };
  return {
    heading: `In this note: ${ctx.note}`,
    lines,
  };
}

/** What the pane shows for these facts. */
export function paneModel(f: PaneFacts, o: PaneOptions = {}): PaneModel {
  const a = availability(f);
  const p = primaryOf(f, a);
  const primary =
    p.id === null ? null : action(p.id, a.get(p.id) ?? { enabled: true, reason: null });
  const rest = [...a.entries()]
    .filter(([id]) => id !== p.id && id !== "join-with-link")
    .map(([id, x]) => action(id, x));
  const unfinished = [
    ...(f.context.flow?.outcome === "unfinished" ? [f.context.flow] : []),
    ...(f.unfinished ?? []),
  ].map((x) => ({
    title: FLOW_TITLE[x.kind],
    detail: `${x.target === undefined ? "" : `${x.target}: `}stopped before ${stageOf(x.kind, x.stage).label.toLowerCase()}`,
  }));
  const preview = f.preview;
  return {
    title: "Shared Tasks",
    join: action("join-with-link", a.get("join-with-link") ?? { enabled: true, reason: null }),
    joinField:
      f.context.flow?.kind === "join" &&
      f.context.flow.outcome === "running" &&
      f.context.flow.stage === "link",
    context: contextArea(f),
    flow:
      f.context.flow === null || f.context.flow.outcome === "unfinished"
        ? null
        : flowView(f.context.flow),
    status: f.section === null ? [] : statusLines(f.section, o),
    preview:
      preview === undefined
        ? []
        : [
            ...(preview.warnings.includes("future-additions") ? [SHARE_SCOPE] : []),
            `${shareCounts(preview.counts)}.`,
            ...preview.warnings.flatMap((w) => {
              const t = shareWarningText(w);
              return t === null ? [] : [t];
            }),
            ...preview.problems,
          ],
    primary,
    primaryNone: p.none,
    secondary: rest.filter((x) => !x.destructive),
    menu: rest.filter((x) => x.destructive),
    sections: sectionGroups(f),
    unfinished,
    notice: f.notice ?? null,
  };
}

/** Every text the pane would show, in order (for claim checks and a screen reader's view). */
export function paneTexts(m: PaneModel): string[] {
  const act = (x: PaneAction) => [x.label, ...(x.reason === null ? [] : [x.reason])];
  return [
    m.title,
    ...act(m.join),
    m.context.heading,
    ...m.context.lines,
    ...(m.flow === null
      ? []
      : [
          m.flow.title,
          ...(m.flow.target === null ? [] : [m.flow.target]),
          ...m.flow.steps.map((s) => s.label),
          ...m.flow.lines,
        ]),
    ...m.status.map((l) => l.text),
    ...m.preview,
    ...(m.primary === null ? [] : act(m.primary)),
    ...m.secondary.flatMap(act),
    ...m.menu.flatMap(act),
    ...(m.sections.summary === null ? [] : [m.sections.summary]),
    ...m.sections.groups.flatMap((g) => [
      g.title,
      ...g.rows.flatMap((r) => [
        r.label,
        ...(r.alias === null ? [] : [r.alias]),
        r.status,
        r.places,
      ]),
    ]),
    ...m.unfinished.flatMap((u) => [u.title, u.detail]),
    ...(m.notice === null ? [] : [m.notice]),
  ];
}
