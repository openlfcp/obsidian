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
// primary action never disagree. Which actions apply, and why one is
// disabled, is the action descriptors' (actions/descriptors.ts, LFCP-03-010);
// a disabled button is never the only guard (the executor checks again).

import { ACTIONS, type ActionId, SOURCE_CHANGING } from "../actions/catalog";
import { ACCESS_HELD, type ActionFacts, availabilities, REPAIR_HELD } from "../actions/descriptors";
import { rowLabel } from "../sections/registry-view";
import {
  SHARE_SCOPE,
  type SharePolicy,
  type ShareWarning,
  shareCounts,
  sharePolicyLines,
  shareWarningText,
} from "../sections/share";
import {
  selectionReasonText as reasonText,
  type SelectionReason as TargetSelectionReason,
} from "../sections/target";
import { CONNECTING_TEXT, heldFact, offlineText, sectionProblems } from "../status/card";
import { type Condition, STATE_LABEL, type StatusState, type StatusView } from "../status/reducer";
import {
  FLOW_STAGES,
  FLOW_TITLE,
  type FlowKind,
  type FlowOutcome,
  flowAction,
  stageOf,
} from "./flows";

/** Why a selection cannot be shared exactly (UX §4.2): the executor's reasons (LFCP-03-009). */
export type SelectionReason = TargetSelectionReason;

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
  /** The flow's number on this host (ActiveFlow.generation): a late click on an ended one does nothing. */
  readonly generation?: number;
  /** An invitation's link: whether the server confirmed it (it works now), once created. */
  readonly confirmed?: boolean;
  /** Its steps run in its own dialog (the invitation's role choice and link): the pane points there. */
  readonly dialog?: boolean;
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
  /** The status in the view's own words (StatusView.label), as the card and the badge say it. */
  readonly label?: string | null;
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
  /**
   * What this device's share of it came to, in this session (LFCP-03-014):
   * "hosted" (on its server) or "local" (created on this device only); absent:
   * not shared from here in this session.
   */
  readonly shared?: { readonly kind: "hosted" | "local"; readonly reason: string | null };
  /** "Link copied": the last invitation to it was copied in this session (I3). */
  readonly linkCopied?: boolean;
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
  /** The settings it would be shared under: the sync server and the comments setting (LFCP-03-014). */
  readonly policy?: SharePolicy;
  /**
   * 0.1 shared Tasks in it (their count): sharing is the existing explicit
   * import, which makes new Tasks with new identities.
   */
  readonly legacy?: number;
}

/** What the pane shows: the action facts its descriptors read (ActionFacts), and its own. */
export interface PaneFacts extends ActionFacts {
  readonly preview?: PanePreview;
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
  // The pane counts lines from 1; the executor's sentences take the 0-based line.
  return s.reason === null ? "" : reasonText(s.reason, (s.line ?? s.fromLine) - 1);
}

/** The invitation's sentence (owner decision D2, UX §9 I1): the pane and the invitation dialog say it. */
export const INVITE_LINK_TEXT = "One-time link, does not expire; whoever opens it first joins.";

/** After "Copy link" (I3): never "sent" or "invited". */
export const LINK_COPIED = "Link copied";

/** What sharing a range with 0.1 shared Tasks does: the existing explicit import (UX §5). */
export const LEGACY_IMPORT_TEXT = (n: number): string =>
  `${n === 1 ? "1 task here is" : `${n} tasks here are`} already shared in another collaboration. Share section… opens the import: it makes new shared tasks with new identities, and the existing collaborations continue separately.`;

/** An invite flow's step that waits in its dialog: what the pane says instead of a button (P1 row 2). */
const INVITE_WAITS: Readonly<Record<string, string>> = {
  role: "Choose Read or Read + write in the invitation dialog.",
  link: "Copy or show the link in the invitation dialog.",
};

/** What the pane says, to the user, when there is no primary action (contract §5, P4). */
export const NO_PRIMARY = {
  noNote: "Open a note to share from it, or join with a link.",
  noSection: "Select the lines of one section, from its heading, to share it.",
  noHeading: "Put the cursor on a heading, or select a section, to share it.",
} as const;

/**
 * D9 (owner): the section the pane is about. The one under the cursor, else
 * the one chosen in the list, else the one just joined; never another one
 * picked from the list on its own.
 */
export function paneFocus(keys: {
  readonly underCursor: string | null;
  readonly chosen: string | null;
  readonly justJoined: string | null;
}): string | null {
  return keys.underCursor ?? keys.chosen ?? keys.justJoined;
}

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

/** Why the section is not connected, in the card's words (UX §6): never "failed" without an attempt. */
function connectionText(v: StatusView): string | null {
  if (v.connection === "connected") return null;
  return v.connection === "connecting" ? CONNECTING_TEXT : offlineText(v);
}

/**
 * Problems first, in the card's words (sectionProblems, heldFact): the pane,
 * the card and the badge say the same thing. Then the separate facts (§6).
 */
function statusLines(s: PaneSection, o: PaneOptions, invitable: boolean): PaneLine[] {
  const v = s.view;
  const kinds = new Set(v.conditions.map((c) => c.kind));
  const problems: PaneLine[] = sectionProblems(v).map((text) => ({ text, tone: "problem" }));
  // F-04: edits held in a note, counted, with their cause (§6), as the card's facts say them.
  for (const h of [...v.held].sort((a, b) => (b.count ?? 1) - (a.count ?? 1)))
    problems.push({ text: heldFact(h), tone: "problem" });
  const info: PaneLine[] = [];
  const shared = sharedLine(s, invitable);
  if (shared !== null) info.push(shared);
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
  if (kinds.has("held-unknown"))
    info.push({
      text: "Not current: whether a note with this section holds edits not sent is unknown.",
      tone: "info",
    });
  if (kinds.has("local-edit")) info.push({ text: "Local changes are being saved", tone: "info" });
  const denied = DENIED.has(v.access.access) || kinds.has("server-refused");
  const connection = denied ? null : connectionText(v);
  if (connection !== null) info.push({ text: connection, tone: "info" });
  if (s.hosting === "pending" && s.shared === undefined)
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

/**
 * What a share from this device came to (LFCP-03-014, I4): created on this
 * device only, or on its server; ready to invite only when inviting is
 * enabled now. The hosting fact read now wins over the creation's result.
 */
function sharedLine(s: PaneSection, invitable: boolean): PaneLine | null {
  if (s.shared === undefined) return null;
  if (s.hosting === "pending" || (s.shared.kind === "local" && s.hosting !== "hosted"))
    return {
      text: `Created on this device only: not on its sync server yet, so nobody can join.${
        s.shared.reason === null ? "" : ` ${s.shared.reason}`
      }`,
      tone: "info",
    };
  return {
    text: invitable
      ? "Shared and on its sync server: ready to invite."
      : "Shared and on its sync server.",
    tone: "info",
  };
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
    lines.push(INVITE_LINK_TEXT);
    lines.push("Treat it like a password.");
    if (flow.stage === "link")
      lines.push(
        flow.confirmed === false
          ? "The server has not confirmed the invitation yet. The link works once this device has synced."
          : "The server has the invitation: the link works now.",
        "The link stays hidden until you choose Copy link or Show link in the invitation dialog.",
      );
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
      status: row.state === null ? "Status not known yet" : (row.label ?? STATE_LABEL[row.state]),
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

/**
 * Which actions apply, enabled or with their reason: the action
 * descriptors' availability (LFCP-03-010), the one predicate every surface
 * reads; the pane keeps no copy of it.
 */
function availability(f: PaneFacts): Map<ActionId, Avail> {
  const a = new Map<ActionId, Avail>();
  for (const [id, x] of availabilities(f))
    a.set(
      id,
      x.kind === "disabled"
        ? { enabled: false, reason: x.reason }
        : { enabled: true, reason: null },
    );
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
        none: NO_PRIMARY.noNote,
      };
    const sel = ctx.selection;
    if (sel?.eligibility === "exact") return { id: "share-section", none: null };
    // 0.1 shared Tasks in the selection: the existing explicit import, through "Share section…".
    if (sel?.eligibility === "ineligible" && sel.reason === "legacy-tasks")
      return { id: "share-section", none: null };
    if (sel?.eligibility === "ineligible")
      return sel.fallback === null
        ? { id: null, none: NO_PRIMARY.noSection }
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
      none: NO_PRIMARY.noHeading,
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
      // An invitation's steps are in its own dialog (role, then the link): the pane points there.
      if (flow.kind === "invite" && flow.dialog === true)
        return { id: null, none: INVITE_WAITS[flow.stage] ?? `${stage.label}.` };
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
  ].map((x) => {
    const step = stageOf(x.kind, x.stage).label.toLowerCase();
    const where = x.target === undefined ? "" : `${x.target}: `;
    // Another flow than the one in the current area: where it stands, as it is.
    const detail =
      x.outcome === "unfinished"
        ? `stopped before ${step}`
        : x.outcome === "unknown"
          ? "its result is not known yet; Continue checks it"
          : `in progress (${step})`;
    return { title: FLOW_TITLE[x.kind], detail: `${where}${detail}` };
  });
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
    status: f.section === null ? [] : statusLines(f.section, o, a.get("invite")?.enabled === true),
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
            ...(preview.policy === undefined
              ? []
              : sharePolicyLines(preview.policy, preview.warnings)),
            ...((preview.legacy ?? 0) > 0 ? [LEGACY_IMPORT_TEXT(preview.legacy ?? 0)] : []),
            ...preview.problems,
          ],
    primary,
    primaryNone: p.none,
    secondary: rest.filter((x) => !x.destructive),
    menu: rest.filter((x) => x.destructive),
    sections: sectionGroups(f),
    unfinished,
    notice: f.notice ?? (f.section?.linkCopied === true ? LINK_COPIED : null),
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
