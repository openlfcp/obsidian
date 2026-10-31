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
import {
  ACCESS_HELD,
  type ActionFacts,
  availabilities,
  hostRefusal,
  hostRefusalReason,
  REPAIR_HELD,
  RUNNING,
} from "../actions/descriptors";
import { ONE_TIME_LINK } from "../collab/commands";
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
import type { Condition, StatusState, StatusView } from "../status/reducer";
import {
  FLOW_STAGES,
  FLOW_TITLE,
  type FlowKind,
  type FlowOutcome,
  flowAction,
  stageOf,
} from "./flows";
import { HIDE_HINT, HINTS, type HintId, hiddenHints, paneHint, SHOW_HINTS } from "./hints";
import { STATUS_ICONS } from "./icons";
import type { PaneProblem, ProblemCategory } from "./problems";
import { type FaceTone, rowWord, sectionFace } from "./state-card";

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
  /** What is confirmed so far, in words (a join's claim, access, load: LFCP-03-015). */
  readonly facts?: readonly string[];
  /** Why its last attempt stopped, in words; kept in view until the next step (a join's error). */
  readonly problem?: string | null;
  /** Its unknown result is being checked now. */
  readonly checking?: boolean;
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
  /** Its copy in the note in view has a damaged marker (the note does not count it as a copy). */
  readonly damaged?: true;
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
  /** The older (0.1) task collaborations on this device; absent or null: not known, none claimed. */
  readonly legacy?: number | null;
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
  /** Its copy in the note in view has a damaged marker: it is there, not "not inserted yet". */
  readonly damaged?: true;
  /** The one status path (StatusView of SectionsHost). */
  readonly view: StatusView;
  /** From the access list (AccessView), not the status facts; null: not known. */
  readonly canInvite: boolean | null;
  /**
   * Whether this vault may remove someone's access, from the access list
   * (AccessView.remove, LFCP-03-019); null or absent: not known.
   */
  readonly canRemove?: boolean | null;
  /** Why removing access waits now, in the card's words (AccessView.removeNote); null: it does not. */
  readonly removeNote?: string | null;
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
  /** The problem rows of the section and the note in view (problems.ts, LFCP-03-018). */
  readonly problems?: readonly PaneProblem[];
  /**
   * The tips this vault has hidden (LFCP-03-021, settings `dismissedHints`);
   * absent: the pane shows no tips (the developer prototype, a test).
   */
  readonly hints?: { readonly hidden: readonly string[] };
}

export interface PaneAction {
  readonly id: ActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, in words (A3); null when enabled. */
  readonly reason: string | null;
  readonly destructive: boolean;
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
  /**
   * The flow's own way out, its label: a join's "Cancel" before the claim,
   * "Later" once joined, "Give up" a claim whose answer was lost; null: none.
   */
  readonly dismiss: string | null;
}

/** A problem row (LFCP-03-018): what, from where, and the way to its resolver. */
export interface PaneProblemView {
  readonly id: string;
  readonly category: ProblemCategory;
  readonly text: string;
  readonly source: string;
  /** Never destructive; null: nothing to do here but read it. */
  readonly action: PaneAction | null;
}

/**
 * The pane's body (UXD-11): one card for what the cursor is on. A title, a
 * status word with its icon, ONE line of fact, the pane's primary with its
 * words and at most one secondary beside it. Caveats, times, the server and what a
 * change does are in Details (`open-details`), not here.
 */
export interface PaneCard {
  /** The section's name; "No section at the cursor", "No note open", or a running flow's title. */
  readonly title: string;
  readonly status: { readonly word: string; readonly icon: string; readonly tone: FaceTone };
  /** The one line; null: the word says it. */
  readonly fact: string | null;
  /** Beside the primary (`PaneModel.primary`): Details, unless Details is the primary or there is no section. */
  readonly secondary: PaneAction | null;
  /** A problem owns the card: drawn as one, its primary the fix. */
  readonly problem: boolean;
}

export interface PaneRowView {
  readonly key: string;
  readonly label: string;
  /** "On this device: …" (N2), or null. */
  readonly alias: string | null;
  /** The status icon (a Lucide name) and how it reads at a glance. */
  readonly icon: string;
  readonly tone: FaceTone;
  /** One line right of the name: where it is, then its status: "here · synced", "in 2 notes · pending". */
  readonly meta: string;
}

export interface PaneGroup {
  readonly id: "in-note" | "elsewhere" | "not-inserted" | "unknown";
  readonly title: string;
  readonly rows: readonly PaneRowView[];
}

export interface PaneModel {
  readonly title: string;
  /** "Join with a link…", in the header in every state (A2); the same action as `header[2]`. */
  readonly join: PaneAction;
  /**
   * The header's icon buttons (A8): Share section…, Insert into a note…, Join
   * with a link…, in this order, in every state. The header never changes
   * shape: an action the facts do not offer is still here, disabled with its
   * reason (A5). Share and Insert may also be the primary or a secondary
   * action below, with their words.
   */
  readonly header: readonly PaneAction[];
  /** The field for a pasted invitation link (I5): shown while a join waits for it. */
  readonly joinField: boolean;
  /** The body: one card for the section at the cursor (UXD-11). */
  readonly card: PaneCard;
  readonly flow: PaneFlowView | null;
  /** The problem hub: each problem with its source and its resolver, in a stable order. */
  readonly problems: readonly PaneProblemView[];
  /** The share preview's summary, when one is shown. */
  readonly preview: readonly string[];
  /** At most one, drawn in the card; never destructive (A1). */
  readonly primary: PaneAction | null;
  /** Why there is no primary action. */
  readonly primaryNone: string | null;
  /**
   * The "More actions" menu (A8, UXD-11): every action the header, the
   * primary and the card do not draw, the destructive ones with their
   * existing confirmation (A1). A destructive action is only ever here.
   */
  readonly menu: readonly PaneAction[];
  readonly sections: { readonly summary: string | null; readonly groups: readonly PaneGroup[] };
  readonly unfinished: readonly { readonly title: string; readonly detail: string }[];
  readonly notice: string | null;
  /** One short tip for what the pane offers now, with its "Hide tip" (LFCP-03-021); null: none. */
  readonly hint: { readonly id: HintId; readonly text: string; readonly hide: string } | null;
  /** "Show tips again", when this vault has hidden some; null: none hidden. */
  readonly showHints: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sentence of an ineligible selection (UX §4.2), with its line where it names one. */
export function selectionReasonText(s: PaneSelection): string {
  // The pane counts lines from 1; the executor's sentences take the 0-based line.
  return s.reason === null ? "" : reasonText(s.reason, (s.line ?? s.fromLine) - 1);
}

/** The empty section list (LFCP-03-021): where to start, share or join. */
export const EMPTY_SECTIONS =
  "No shared sections on this device yet. Share one from a note, or join one with a link.";

/** The empty list on a device that holds only an older task collaboration: says why, then what to do. */
export const EMPTY_SECTIONS_LEGACY =
  "No shared sections here yet. This device has an older task collaboration, which is not a section. Share a section from a note, or join with a section link.";

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

/** A section whose copy in this note has a damaged marker. */
const DAMAGED_HERE = "damaged here";

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

/**
 * What a share from this device came to (LFCP-03-014, I4): created on this
 * device only, or on its server; ready to invite only when inviting is
 * enabled now. The hosting fact read now wins over the creation's result.
 */
function sharedLine(s: PaneSection, invitable: boolean): string | null {
  if (s.shared === undefined) return null;
  if (s.hosting === "pending" || (s.shared.kind === "local" && s.hosting !== "hosted"))
    return `Created on this device only: not on its sync server yet, so nobody can join.${
      s.shared.reason === null ? "" : ` ${s.shared.reason}`
    }`;
  return invitable
    ? "Shared and on its sync server: ready to invite."
    : "Shared and on its sync server.";
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

/** The join flow's lines (LFCP-03-015): the facts confirmed, the step under way, the next one. */
function joinLines(flow: PaneFlow): string[] {
  const stage = stageOf(flow.kind, flow.stage);
  const lines = [...(flow.problem == null ? [] : [flow.problem]), ...(flow.facts ?? [])];
  if (flow.stage === "link")
    lines.push(`${ONE_TIME_LINK} Treat it like a password: it is not shown here.`);
  if (stage.waits === "effect") lines.push(`${stage.label}…`);
  if (flow.stage === "choose-place")
    lines.push("Joined. Choose a note to insert it into, now or later.");
  return lines;
}

function flowLines(flow: PaneFlow): string[] {
  const stage = stageOf(flow.kind, flow.stage);
  if (flow.outcome === "unknown") {
    switch (flow.kind) {
      case "join":
        return [
          "The server did not confirm the claim. The claim is kept on this device.",
          "Check the result: it resumes the same claim with the same link, never a new one.",
          ...(flow.checking === true ? ["Checking the result…"] : []),
          ...(flow.problem == null ? [] : [flow.problem]),
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
          ...(flow.problem == null ? [] : [flow.problem]),
        ];
    }
  }
  if (flow.outcome === "unfinished")
    return [`Stopped before: ${stage.label.toLowerCase()}. Continue resumes the same operation.`];
  if (flow.kind === "join") return joinLines(flow);
  const lines: string[] = [];
  if (flow.kind === "invite") {
    // D2 (UX §9 I1): the same sentence as the invitation dialog's, from one place.
    lines.push(ONE_TIME_LINK);
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
    dismiss: dismissOf(flow),
  };
}

/** A join's way out at its stage; none while its claim runs or is being checked. */
function dismissOf(flow: PaneFlow): string | null {
  if (flow.kind !== "join" || flow.checking === true) return null;
  if (flow.outcome === "unknown") return "Give up";
  if (flow.outcome !== "running") return null;
  return flow.stage === "link" ? "Cancel" : flow.stage === "choose-place" ? "Later" : null;
}

function sectionGroups(f: PaneFacts): { summary: string | null; groups: PaneGroup[] } {
  const r = f.registry;
  const summary =
    r.status === "loading"
      ? "Reading the shared sections on this device…"
      : r.status === "error"
        ? "The list of shared sections could not be read again; it shows the last one."
        : r.sections === 0
          ? (r.legacy ?? 0) > 0
            ? EMPTY_SECTIONS_LEGACY
            : EMPTY_SECTIONS
          : r.sections === null
            ? null
            : `${plural(r.sections, "shared section")} on this device`;
  const rows = r.rows ?? [];
  const note = f.context.note;
  /** Where the row's section is, in a few words (the status follows it). */
  const placesOf = (row: PaneRow): string =>
    row.damaged === true && row.placed === "unplaced"
      ? DAMAGED_HERE
      : note !== null && row.notes.includes(note)
        ? row.notes.length > 1
          ? `here and in ${plural(row.notes.length - 1, "other note")}`
          : "here"
        : row.placed === "unplaced"
          ? "not inserted yet"
          : row.placed === "unknown"
            ? "looking for copies…"
            : `in ${plural(row.notes.length, "note")}`;
  const view = (row: PaneRow): PaneRowView => {
    const l = sectionLabel(row);
    const w = rowWord(row.state, row.label);
    return {
      key: row.key,
      label: l.label,
      alias: l.alias,
      icon: w.icon,
      tone: w.tone,
      meta: `${placesOf(row)} · ${w.word}`,
    };
  };
  const groups: PaneGroup[] = [
    {
      id: "in-note",
      title: "In this note",
      rows: rows
        .filter((x) => (note !== null && x.notes.includes(note)) || x.damaged === true)
        .map(view),
    },
    {
      id: "elsewhere",
      title: "Placed elsewhere",
      rows: rows
        .filter(
          (x) =>
            x.placed === "placed" &&
            x.damaged !== true &&
            (note === null || !x.notes.includes(note)),
        )
        .map(view),
    },
    {
      id: "not-inserted",
      title: "Not inserted yet",
      rows: rows.filter((x) => x.placed === "unplaced" && x.damaged !== true).map(view),
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

/**
 * The problem row that fixes a damaged section boundary of the note in view
 * (UX-06): the first boundary row of that note with its own fix.
 */
function noteFixRow(f: PaneFacts): PaneProblem | null {
  const note = f.context.note;
  if (note === null) return null;
  for (const p of f.problems ?? [])
    if (
      p.category === "boundary" &&
      (p.action === "restore-marker" || p.action === "repair-sections") &&
      p.ref?.kind === "repair" &&
      p.ref.path === note
    )
      return p;
  return null;
}

/** The action that fixes it (UX-06). */
const noteFix = (f: PaneFacts): ActionId | null => noteFixRow(f)?.action ?? null;

/** P1: the first matching row decides the primary action; null with the reason when none. */
function primaryOf(
  f: PaneFacts,
  a: ReadonlyMap<ActionId, Avail>,
): { id: ActionId | null; none: string | null; fix?: true } {
  type Pick = { id: ActionId | null; none: string | null; fix?: true };
  const ctx = f.context;
  const s = f.section;
  const v = s?.view;
  const conditions = v?.conditions ?? [];
  const flow = ctx.flow;
  const ordinary = (): Pick => {
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
    // UX-06: a damaged marker in this note is fixed before anything else is offered
    // (a share the cursor or selection asks for stays first).
    const fix = noteFix(f);
    if (fix !== null) return { id: fix, none: null, fix: true };
    if (s !== null && v !== undefined) {
      if (s.placements === 0 && s.damaged !== true && f.registry.placementIndex === "complete")
        return { id: "insert-into-note", none: null };
      if (a.get("invite")?.enabled === true && v.sync.current) return { id: "invite", none: null };
      return { id: "open-details", none: null };
    }
    return {
      id: null,
      none: NO_PRIMARY.noHeading,
    };
  };
  const pick = (): Pick => {
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
  // The fix of a damaged marker is the problem row's own action: it needs no section status.
  if (p.fix === true) return { id: p.id, none: null, fix: true };
  if (p.id !== null && a.get(p.id)?.enabled !== true)
    return { id: null, none: a.get(p.id)?.reason ?? "Not available now." };
  return p;
}

/**
 * The problem rows with their actions. One conflict row beside a primary
 * "Review conflicts…" would show the same button twice, and both open the
 * same single item (LFCP-03-062, N4): the row keeps its text and the primary
 * is the way in. With several conflicts each row's button opens on its own item.
 */
function problemViews(f: PaneFacts, primary: ActionId | null): PaneProblemView[] {
  const rows = f.problems ?? [];
  const sole = (id: ActionId) => primary === id && rows.filter((r) => r.action === id).length === 1;
  const same = (id: ActionId) => sole(id) && (id === "review-conflicts" || id === "restore-marker");
  return rows.map((r) => {
    const v = problemView(f, r);
    return r.action !== null && same(r.action) ? { ...v, action: null } : v;
  });
}

/**
 * A problem row's action (LFCP-03-018): the host guard, and in Reading view
 * a repair of that note waits for an editor (T4). The executor checks again.
 */
function problemView(f: PaneFacts, p: PaneProblem): PaneProblemView {
  let a: PaneAction | null = null;
  if (p.action !== null) {
    const refusal = hostRefusal(f.host ?? RUNNING);
    const path = p.ref === null || p.ref.kind === "conflict" ? null : p.ref.path;
    const reading =
      (p.action === "repair-sections" || p.action === "restore-marker") &&
      f.context.editor === "reading" &&
      path !== null &&
      path === f.context.note;
    a = action(
      p.action,
      refusal !== null
        ? { enabled: false, reason: hostRefusalReason(refusal) }
        : reading
          ? { enabled: false, reason: "Open the note for editing to repair it." }
          : { enabled: true, reason: null },
    );
  }
  return { id: p.id, category: p.category, text: p.text, source: p.source, action: a };
}

/** The header's entries (A8), in order. */
const HEADER_IDS = ["share-section", "insert-into-note", "join-with-link"] as const;

/** An entry the descriptors do not offer here is drawn disabled, with this reason (A5, A8). */
const HEADER_ABSENT: Readonly<Record<(typeof HEADER_IDS)[number], Avail>> = {
  // Unreachable today (the descriptor is never hidden), kept for symmetry.
  "share-section": { enabled: false, reason: "Sharing is not available here." },
  "insert-into-note": {
    enabled: false,
    reason: "No shared section on this device yet: share one, or join with a link, first.",
  },
  // A2: Join is always offered.
  "join-with-link": { enabled: true, reason: null },
};

const action = (id: ActionId, x: Avail): PaneAction => ({
  id,
  label: ACTIONS[id].label,
  enabled: x.enabled,
  reason: x.reason,
  destructive: ACTIONS[id].destructive,
});

/** The note's reading-view line (T4). */
const READING_LINE = "Reading view: open the note for editing to change it.";

/**
 * The card (UXD-11): what the cursor is on, its status in a word, one line,
 * the primary, and Details beside it. A running flow owns the area (P2): the
 * card is the flow's, drawn with its steps.
 */
function cardOf(
  f: PaneFacts,
  a: ReadonlyMap<ActionId, Avail>,
  primary: ActionId | null,
  fixRow: PaneProblem | null,
): PaneCard {
  const ctx = f.context;
  const s = f.section;
  const flow = ctx.flow?.outcome === "unfinished" ? null : ctx.flow;
  const details = a.get("open-details");
  const secondary =
    s !== null && primary !== "open-details" && details !== undefined && flow === null
      ? action("open-details", details)
      : null;
  const face = (
    title: string,
    w: { word: string; icon: string; tone: FaceTone },
    fact: string | null,
    problem = false,
  ): PaneCard => ({
    title,
    status: { word: w.word, icon: w.icon, tone: w.tone },
    fact,
    secondary,
    problem,
  });
  if (flow !== null) {
    const stage = stageOf(flow.kind, flow.stage);
    const w =
      flow.outcome === "unknown"
        ? { word: "Result unknown", icon: STATUS_ICONS.problem, tone: "problem" as const }
        : {
            word: "In progress",
            icon: STATUS_ICONS.busy,
            tone: stage.waits === "effect" ? ("busy" as const) : ("info" as const),
          };
    // The flow keeps the target it captured (T2): say so when the active note is another one.
    const away =
      flow.target !== undefined && ctx.note !== null && ctx.note !== flow.target
        ? `The active note is ${ctx.note}; this stays on ${flow.target}.`
        : null;
    return face(FLOW_TITLE[flow.kind], w, away, flow.outcome === "unknown");
  }
  const sel = ctx.selection;
  const selection =
    sel === null
      ? null
      : sel.eligibility === "exact"
        ? `Selection: lines ${sel.fromLine}–${sel.toLine}`
        : selectionReasonText(sel);
  const reading = ctx.editor === "reading" ? READING_LINE : null;
  const fix = fixRow;
  if (s === null) {
    const title = ctx.note === null ? "No note open" : "No section at the cursor";
    if (fix !== null)
      return face(
        "A shared section in this note",
        { word: "Needs repair", icon: STATUS_ICONS.problem, tone: "problem" },
        fix.text,
        true,
      );
    return face(
      title,
      ctx.note === null
        ? { word: "No note", icon: STATUS_ICONS.idle, tone: "muted" }
        : { word: "Not shared", icon: STATUS_ICONS.idle, tone: "muted" },
      // In Reading view the card says why the primary is "Open for editing" (T4).
      reading ??
        selection ??
        (ctx.cursor === "private-heading" ? "On a heading that is not shared" : null),
    );
  }
  const title = sectionLabel(s).label;
  if (fix !== null)
    return face(
      title,
      { word: "Needs repair", icon: STATUS_ICONS.problem, tone: "problem" },
      fix.text,
      true,
    );
  const shared = sharedLine(s, a.get("invite")?.enabled === true);
  const local = s.hosting === "pending" || (s.shared?.kind === "local" && s.hosting !== "hosted");
  const unplaced =
    s.placements === 0 && s.damaged !== true && f.registry.placementIndex === "complete";
  const w = sectionFace(s.view, { shared: shared, local, unplaced });
  return face(title, w, w.problem ? w.fact : (reading ?? selection ?? w.fact), w.problem);
}

/** What the pane shows for these facts. */
export function paneModel(f: PaneFacts): PaneModel {
  const a = availability(f);
  const p = primaryOf(f, a);
  const primary =
    p.id === null ? null : action(p.id, a.get(p.id) ?? { enabled: true, reason: null });
  // The fix of a damaged marker is the card itself (its text, its button): not listed again (UX-06).
  const fix = p.fix === true ? noteFixRow(f) : null;
  const card = cardOf(f, a, p.id, fix);
  // The header draws Share, Insert and Join; the card draws the primary and Details.
  const drawn = new Set<ActionId>([
    ...HEADER_IDS,
    ...(p.id === null ? [] : [p.id]),
    ...(card.secondary === null ? [] : [card.secondary.id]),
  ]);
  const menu = [...a.entries()].filter(([id]) => !drawn.has(id)).map(([id, x]) => action(id, x));
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
  const hidden = f.hints?.hidden ?? [];
  const flow = f.context.flow;
  const hint =
    f.hints === undefined
      ? null
      : paneHint(
          {
            problem:
              card.problem || (f.problems?.length ?? 0) > 0 || (preview?.problems.length ?? 0) > 0,
            flow: flow !== null && flow.outcome !== "unfinished",
            preview: preview !== undefined,
            primary: primary?.enabled === true ? primary.id : null,
            cursor: f.context.cursor,
            empty: f.registry.status === "ready" && f.registry.sections === 0,
          },
          hidden,
        );
  return {
    title: "Shared Tasks",
    join: action("join-with-link", a.get("join-with-link") ?? HEADER_ABSENT["join-with-link"]),
    header: HEADER_IDS.map((id) => action(id, a.get(id) ?? HEADER_ABSENT[id])),
    joinField:
      f.context.flow?.kind === "join" &&
      f.context.flow.outcome === "running" &&
      f.context.flow.stage === "link",
    card,
    flow:
      f.context.flow === null || f.context.flow.outcome === "unfinished"
        ? null
        : flowView(f.context.flow),
    problems: problemViews(f, p.id).filter(
      (x) =>
        x.id !== fix?.id &&
        // A row that says what the card says, with the card's own button, is the card (not twice).
        !(card.problem && x.text === card.fact && (x.action === null || x.action.id === p.id)),
    ),
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
    menu,
    sections: sectionGroups(f),
    unfinished,
    notice: f.notice ?? (f.section?.linkCopied === true ? LINK_COPIED : null),
    hint: hint === null ? null : { id: hint, text: HINTS[hint], hide: HIDE_HINT },
    showHints: f.hints !== undefined && hiddenHints(hidden) > 0 ? SHOW_HINTS : null,
  };
}

/**
 * Every action the pane has, drawn or in the menu, enabled or with its reason:
 * the header's, the primary, the card's Details and the menu's. A click is
 * checked against this list (pane-view.ts, L2).
 */
export function paneActions(m: PaneModel): PaneAction[] {
  return [
    ...m.header,
    ...(m.primary === null ? [] : [m.primary]),
    ...(m.card.secondary === null ? [] : [m.card.secondary]),
    ...m.menu,
  ];
}

/** Every text the pane would show, in order (for claim checks and a screen reader's view). */
export function paneTexts(m: PaneModel): string[] {
  const act = (x: PaneAction) => [x.label, ...(x.reason === null ? [] : [x.reason])];
  return [
    m.title,
    ...m.header.flatMap(act),
    m.card.title,
    m.card.status.word,
    ...(m.card.fact === null ? [] : [m.card.fact]),
    ...(m.card.secondary === null ? [] : act(m.card.secondary)),
    ...(m.primaryNone === null ? [] : [m.primaryNone]),
    ...(m.flow === null
      ? []
      : [
          m.flow.title,
          ...(m.flow.target === null ? [] : [m.flow.target]),
          ...m.flow.steps.map((s) => s.label),
          ...m.flow.lines,
          ...(m.flow.dismiss === null ? [] : [m.flow.dismiss]),
        ]),
    ...m.problems.flatMap((p) => [p.text, p.source, ...(p.action === null ? [] : act(p.action))]),
    ...m.preview,
    ...(m.primary === null ? [] : act(m.primary)),
    ...m.menu.flatMap(act),
    ...(m.sections.summary === null ? [] : [m.sections.summary]),
    ...m.sections.groups.flatMap((g) => [
      g.title,
      ...g.rows.flatMap((r) => [r.label, ...(r.alias === null ? [] : [r.alias]), r.meta]),
    ]),
    ...m.unfinished.flatMap((u) => [u.title, u.detail]),
    ...(m.notice === null ? [] : [m.notice]),
    ...(m.hint === null ? [] : [m.hint.text, m.hint.hide]),
    ...(m.showHints === null ? [] : [m.showHints]),
  ];
}
