// The pane's facts from the real host (LFCP-03-012, 013): an adapter from
// what the plugin already knows to the pane's view model (model.ts). It
// reads, never writes, and opens nothing:
//
//   - the last active Markdown note, as captured now (TargetCapture: its
//     text, cursor, selections and mode), or none;
//   - the section registry view (SectionRegistryView, LFCP-03-011);
//   - each section's status through the one status path (StatusView), and
//     its access list's facts (canInvite, hosting), unknown until read;
//   - the share and insert flows (SectionActions.flows()): the one the pane
//     holds (pinned) owns the current area, the others are listed;
//   - the join flow (CollabCommands.joins, LFCP-03-015): while it is open it
//     owns the current area, unless the pane holds a running share or insert;
//   - the section chosen in the list and the one just joined (D9);
//   - the host's running state (HostFacts, the descriptors' guard).
//
// One drawing gives the facts, what each button hands the dispatcher and
// an identity of what it acts on, from the same reading (L2): a click is
// checked against the facts as they are then, never run on another target.
// Pure: no Obsidian, no DOM.

import type { ActionId } from "../actions/catalog";
import { type HostFacts, RUNNING } from "../actions/descriptors";
import type { ActionRequest } from "../actions/dispatcher";
import type { JoinFlowState } from "../collab/join-flow";
import { contentHash } from "../projection/guard";
import type { ActiveFlow } from "../sections/actions";
import { sectionAtLine } from "../sections/context";
import type { RecoveryItem } from "../sections/recovery";
import type { RegistryRow, RegistrySnapshot } from "../sections/registry-view";
import { keyedRepairs } from "../sections/repair";
import { preflight, proposeRange, type SharePolicy, shareMessages } from "../sections/share";
import { type ShareScope, shareScope, type TargetCapture } from "../sections/target";
import { type StatusView, statusView } from "../status/reducer";
import { flowAction, stageOf } from "./flows";
import type {
  PaneAction,
  PaneContext,
  PaneFacts,
  PaneFlow,
  PaneModel,
  PanePreview,
  PaneRegistry,
  PaneSection,
  PaneSelection,
} from "./model";
import { type NoteRepairs, type PaneProblem, paneProblems } from "./problems";

/**
 * What the access list (AccessView, the card's) says of a section, for the
 * pane (LFCP-03-013): whether this vault may invite (null: not known, never
 * a denial or a grant) and whether the section is on its server (I4).
 */
export interface PaneAccess {
  readonly canInvite: boolean | null;
  readonly hosting: "hosted" | "pending" | "unknown";
}

/**
 * The invitation being made in this session (CollabCommands' invitation
 * lock, LFCP-03-014): its section's Resource (base64url) and its step.
 */
export interface PaneInvitation {
  readonly resource: string;
  readonly stage: "role" | "creating" | "link";
  /** The server confirmed it (the link works now); null before it is created. */
  readonly confirmed: boolean | null;
}

/** What this device's share or invitation of a section came to, in this session (LFCP-03-014). */
export interface PaneJourney {
  /** The share's result: created on this device only, or on its server. */
  readonly shared?: { readonly kind: "hosted" | "local"; readonly reason: string | null };
  /** The last invitation's link was copied. */
  readonly linkCopied?: boolean;
}

/**
 * The join flow (collab/join-flow.ts JoinFlowState, LFCP-03-015) as the
 * pane reads it: its stage, the facts confirmed so far and the problem it
 * stopped at. Never the link.
 */
export interface PaneJoin {
  readonly generation: number;
  readonly stage: string;
  readonly outcome: "running" | "unknown";
  readonly facts: readonly string[];
  readonly problem: string | null;
  readonly checking: boolean;
}

/** The join flow's state as the pane reads it; null when no join is open. */
export function paneJoinOf(s: JoinFlowState | null): PaneJoin | null {
  return s === null
    ? null
    : {
        generation: s.generation,
        stage: s.stage,
        outcome: s.outcome,
        facts: s.facts,
        problem: s.problem,
        checking: s.checking,
      };
}

/** What the pane host reads, each time the pane redraws. */
export interface PaneHostSources {
  /** The join flow open now, or none. */
  readonly join?: PaneJoin | null;
  /** The share and insert flows running, or whose result is being reconciled (SectionActions.flows()). */
  readonly flows?: readonly ActiveFlow[];
  /** The flow the pane holds (its generation): it keeps the current area until it ends (P2, T2). */
  readonly pinned?: number | null;
  /** The section the user chose in the list (its key), or null (D9). */
  readonly chosen?: string | null;
  /** The section Resource joined last on this device (base64url), or null (D9). */
  readonly justJoined?: string | null;
  /** The last active Markdown note, read now; null when none is open. */
  readonly note: TargetCapture | null;
  /** The registry view's snapshot; null while shared sections are off on this device. */
  readonly registry: RegistrySnapshot | null;
  /** A section's status from the one status path; undefined before its first. */
  readonly status: (key: string) => StatusView | undefined;
  /** The host's running state; absent: running. */
  readonly host?: HostFacts;
  /** A section's access list facts; absent or undefined: not known yet. */
  readonly access?: (key: string) => PaneAccess | undefined;
  /** The settings a share runs under now (server, comments); absent: the preview does not say them. */
  readonly policy?: SharePolicy;
  /** The invitation being made now, or none. */
  readonly invitation?: PaneInvitation | null;
  /** What this device's share or invitation of section `key` came to, in this session. */
  readonly journey?: (key: string) => PaneJourney | undefined;
  /** A section's review items (conflicts, kept work), read now; absent: none known (LFCP-03-018). */
  readonly recovery?: (key: string) => readonly RecoveryItem[];
}

/** The registry as the pane shows it while shared sections are off: nothing is claimed. */
const OFF: PaneRegistry = {
  status: "ready",
  placementIndex: "unknown",
  sections: null,
  unplaced: null,
  rows: [],
};

/**
 * The status of a section whose status this device has not computed yet:
 * the reducer's own view of "no evidence" (loading, access unknown, no
 * connection seen). Never healthy, never a denial.
 */
export function unknownStatus(): StatusView {
  return statusView({
    session: "",
    revision: 0,
    replica: "not-loaded",
    access: "unknown",
    pendingControl: [],
    connection: "offline",
    connectionQualifier: "no-evidence",
    catchUp: "not-started",
    problems: [],
    batches: [],
    acceptanceEvidence: "unavailable",
    projections: [],
  });
}

function registryOf(s: RegistrySnapshot | null): PaneRegistry {
  if (s === null) return OFF;
  return {
    status: s.status,
    placementIndex: s.placementIndex,
    sections: s.sections,
    unplaced: s.unplaced,
    rows: s.rows.map((r) => ({
      key: r.key ?? r.resource,
      sharedTitle: r.sharedTitle,
      localAlias: r.localAlias,
      notes: r.placements.map((p) => p.path),
      placed: r.placed,
      state: r.status.state,
      label: r.status.label,
    })),
  };
}

/** The selection as the pane shows it: the executor's own scope rule (shareScope), never widened. */
function selectionOf(note: TargetCapture): PaneSelection | null {
  const scope = shareScope(note.text, note.cursorLine, note.selections);
  if (scope.kind === "exact")
    return {
      fromLine: scope.range.headingLine + 1,
      toLine: scope.range.lastLine + 1,
      eligibility: "exact",
      reason: null,
      fallback: null,
    };
  if (scope.kind !== "ineligible") return null;
  const s = note.selections.find((x) => x.anchor.line !== x.head.line || x.anchor.ch !== x.head.ch);
  const from = s === undefined ? note.cursorLine : Math.min(s.anchor.line, s.head.line);
  const to = s === undefined ? note.cursorLine : Math.max(s.anchor.line, s.head.line);
  return {
    fromLine: from + 1,
    toLine: to + 1,
    eligibility: "ineligible",
    reason: scope.reason,
    fallback: scope.fallback === null ? null : "share-whole-section",
    ...(scope.line === null ? {} : { line: scope.line + 1 }),
  };
}

/** The shared section under the cursor of `note`: its key and its heading's title there. */
function underCursor(note: TargetCapture | null): { key: string; title: string } | null {
  return note === null ? null : sectionAtLine(note.text, note.cursorLine);
}

function sectionOf(
  at: { key: string; title: string },
  rows: readonly RegistryRow[],
  src: PaneHostSources,
): PaneSection {
  const row = rows.find((r) => r.key === at.key);
  const access = src.access?.(at.key);
  const journey = src.journey?.(at.key);
  return {
    key: at.key,
    // N1-N3: the shared title once loaded; before, the local alias (with its qualifier), and
    // only without either the heading as this note shows it.
    sharedTitle:
      row?.sharedTitle ??
      (row !== undefined && row.localAlias !== null ? null : at.title === "" ? null : at.title),
    localAlias: row?.localAlias ?? null,
    placements: row?.placementCount ?? null,
    view: src.status(at.key) ?? unknownStatus(),
    // The access list's (AccessView, the card's): unknown until read, never a default.
    canInvite: access?.canInvite ?? null,
    ...(access === undefined ? {} : { hosting: access.hosting }),
    ...(journey?.shared === undefined ? {} : { shared: journey.shared }),
    ...(journey?.linkCopied === true ? { linkCopied: true } : {}),
  };
}

/**
 * The share preview the pane shows for `note` (LFCP-03-014): the range the
 * executor would preview, never widened (S1): the heading at or above the
 * cursor without a selection, or an exact eligible selection as it is, or
 * the range of a selection with 0.1 shared Tasks (the explicit import).
 * The same preflight as the share dialog, on the note as it is now: an
 * edit redraws it, and the dialog checks it again before any effect.
 */
function previewOf(
  note: TargetCapture,
  scope: ShareScope,
  policy: SharePolicy | undefined,
): PanePreview | undefined {
  const range =
    scope.kind === "heading" || scope.kind === "exact"
      ? scope.range
      : scope.kind === "ineligible" && scope.reason === "legacy-tasks"
        ? scope.range
        : null;
  if (range === null) return undefined;
  const p = preflight(note.text, range);
  const legacy = p.problems.flatMap((x) => (x.code === "LEGACY_SHARED_TASKS" ? x.lines : []));
  const m = shareMessages({
    ...p,
    problems: p.problems.filter((x) => x.code !== "LEGACY_SHARED_TASKS"),
  });
  return {
    counts: {
      tasks: p.counts.tasks,
      paragraphs: p.counts.paragraphs,
      items: p.counts.items,
      raw: p.counts.raw,
    },
    warnings: p.warnings,
    problems: m.problems,
    ...(policy === undefined ? {} : { policy }),
    ...(legacy.length === 0 ? {} : { legacy: legacy.length }),
  };
}

/** One drawing of the pane: its facts, and what each button acts on. */
export interface PaneDrawing {
  readonly facts: PaneFacts;
  /** What a click of action `id` hands the dispatcher. */
  request(id: ActionId): ActionRequest;
  /** What action `id` acts on (note, section, flow): a click compares it with the facts then (L2). */
  identity(id: ActionId): string;
  /** What a problem row's action hands the dispatcher (LFCP-03-018); null: no such row now. */
  problemRequest(problemId: string): ActionRequest | null;
  /** The flow the pane holds now (its generation), to keep on the next drawing. */
  readonly pinned: number | null;
}

/**
 * The flow that owns the current area (P2, T2): the one the pane holds
 * while it runs, else one on the note in view, else the latest. It never
 * moves to another one while it runs.
 */
function pickFlow(
  flows: readonly ActiveFlow[],
  pinned: number | null,
  note: string | null,
): ActiveFlow | null {
  const held = flows.find((f) => f.generation === pinned);
  if (held !== undefined) return held;
  const latest = (xs: readonly ActiveFlow[]) =>
    xs.reduce<ActiveFlow | null>(
      (a, f) => (a === null || f.generation > a.generation ? f : a),
      null,
    );
  return latest(flows.filter((f) => f.path !== null && f.path === note)) ?? latest(flows);
}

const confirmedOf = (i: PaneInvitation): { confirmed?: boolean } =>
  i.confirmed === null ? {} : { confirmed: i.confirmed };

const joinFlow = (j: PaneJoin): PaneFlow => ({
  kind: "join",
  stage: j.stage,
  outcome: j.outcome,
  generation: j.generation,
  facts: j.facts,
  problem: j.problem,
  checking: j.checking,
});

const paneFlow = (f: ActiveFlow): PaneFlow => ({
  kind: f.kind,
  stage: f.step,
  outcome: f.outcome,
  generation: f.generation,
  ...(f.path === null ? {} : { target: f.path }),
});

/** The section a row of the registry is about, by key or, before its model is open, by Resource. */
function rowFocus(
  rows: readonly RegistryRow[],
  match: (r: RegistryRow) => boolean,
): { key: string; title: string } | null {
  const row = rows.find(match);
  if (row === undefined) return null;
  return { key: row.key ?? row.resource, title: row.sharedTitle ?? row.localAlias ?? "" };
}

/** The pane's facts and requests from the host's sources, from one reading (L2). */
export function hostPane(src: PaneHostSources): PaneDrawing {
  const note = src.note;
  const rows = src.registry?.rows ?? [];
  // D9: the section under the cursor, else the one chosen in the list, else the one just joined.
  const under = underCursor(note);
  const chosen = src.chosen ?? null;
  const joined = src.justJoined ?? null;
  const at =
    under ??
    (chosen === null ? null : rowFocus(rows, (r) => (r.key ?? r.resource) === chosen)) ??
    (joined === null ? null : rowFocus(rows, (r) => r.resource === joined));
  const flows = src.flows ?? [];
  const picked = pickFlow(flows, src.pinned ?? null, note?.path ?? null);
  // The order of the current area (P5): a running share or insert the pane holds; else an
  // invitation under way (its dialog is open); else an open join (LFCP-03-015). Neither of
  // the last two is one of SectionActions' flows; the one that does not own the area is listed.
  const held = picked !== null && picked.generation === src.pinned && picked.outcome === "running";
  const invitation = src.invitation ?? null;
  const inviting = invitation !== null && !held;
  const join = src.join ?? null;
  const joining = join !== null && !held && !inviting;
  const flow = joining ? null : picked;
  const others = flows.filter((f) => f !== flow);
  const context: PaneContext = {
    editor: note === null ? "none" : note.mode,
    note: note?.path ?? null,
    cursor:
      note === null
        ? "none"
        : under !== null
          ? "inside-section"
          : proposeRange(note.text, note.cursorLine) !== null
            ? "private-heading"
            : "private-text",
    selection: note === null || under !== null ? null : selectionOf(note),
    flow: inviting
      ? {
          kind: "invite",
          stage: invitation.stage,
          outcome: "running",
          dialog: true,
          ...confirmedOf(invitation),
        }
      : joining
        ? joinFlow(join)
        : flow === null
          ? null
          : paneFlow(flow),
  };
  // The share preview, while the context offers a share and no flow owns the area (LFCP-03-014).
  const preview =
    note === null ||
    context.flow !== null ||
    under !== null ||
    (context.selection === null && context.cursor !== "private-heading")
      ? undefined
      : previewOf(note, shareScope(note.text, note.cursorLine, note.selections), src.policy);
  // A join that does not own the area (an invitation or a held flow does) is listed with them.
  const unfinished = [
    ...(inviting && flow !== null ? [flow, ...others] : others).map(paneFlow),
    ...(join !== null && !joining ? [joinFlow(join)] : []),
  ];
  const section = at === null ? null : sectionOf(at, rows, src);
  const problems = paneProblems({
    // A section whose status is not computed yet has no problems to claim.
    view: at === null || src.status(at.key) === undefined ? null : (section?.view ?? null),
    recovery: at === null ? [] : (src.recovery?.(at.key) ?? []),
    repairs: noteRepairs(note),
  });
  const facts: PaneFacts = {
    context,
    registry: registryOf(src.registry),
    section,
    ...(unfinished.length === 0 ? {} : { unfinished }),
    host: src.host ?? RUNNING,
    ...(preview === undefined ? {} : { preview }),
    ...(problems.length === 0 ? {} : { problems }),
    insertIntoNoteInView: true,
  };
  const base: ActionRequest = {
    ...(note === null ? {} : { target: note }),
    ...(at === null ? {} : { section: at }),
  };
  const request = (id: ActionId): ActionRequest => {
    // The running flow's next step goes back to that flow, on its own note (T2), never a new one here.
    if (
      flow !== null &&
      flow.outcome === "running" &&
      stageOf(flow.kind, flow.step).waits === "user" &&
      flowAction(flow.kind, flow.step) === id
    )
      return { flow: flow.generation };
    if (id === "check-result" && joining && join.outcome === "unknown")
      return { join: join.generation };
    if (id === "check-result" && flow?.outcome === "unknown") return { flow: flow.generation };
    if (id === "continue-flow") {
      const next = others[0] ?? flow;
      return next === null ? {} : { flow: next.generation };
    }
    return base;
  };
  return {
    facts,
    request,
    identity: (id) => {
      const r = request(id);
      return JSON.stringify([
        r.target?.path ?? null,
        r.section?.key ?? null,
        r.flow ?? null,
        r.join ?? null,
      ]);
    },
    problemRequest: (problemId) => {
      const p = problems.find((x) => x.id === problemId);
      return p === undefined ? null : problemRequest(p, at);
    },
    pinned: flow?.generation ?? null,
  };
}

/** The last note text parsed for repairs, and what it gave: a redraw of the same text parses nothing. */
let lastRepairs: {
  readonly text: string;
  readonly items: NoteRepairs["items"];
  readonly revision: string;
} | null = null;

/**
 * The repair items of the note in view, with its revision (only computed
 * when there are some). Memoized by the note's text: most redraws (a cursor
 * move, a status change) see the same text, and parse it once.
 */
export function noteRepairs(note: TargetCapture | null): NoteRepairs | null {
  if (note === null) return null;
  if (lastRepairs?.text !== note.text) {
    const items = keyedRepairs(note.text);
    lastRepairs = {
      text: note.text,
      items,
      revision: items.length === 0 ? "" : contentHash(note.text),
    };
  }
  return { path: note.path, revision: lastRepairs.revision, items: lastRepairs.items };
}

/**
 * What a problem row hands the dispatcher: a conflict its RecoveryItem.key
 * with the section; a repair its line key, line and revision (the executor
 * parses the note again); held edits their place; the rest the section.
 */
function problemRequest(p: PaneProblem, at: { key: string; title: string } | null): ActionRequest {
  const section = at === null ? {} : { section: at };
  const ref = p.ref;
  if (ref === null) return section;
  if (ref.kind === "at") return { ...section, at: { path: ref.path, line: ref.line } };
  return { ...section, problem: ref };
}

/** The pane's facts from the host's sources. */
export function hostPaneFacts(src: PaneHostSources): PaneFacts {
  return hostPane(src).facts;
}

/** What a pane button hands the dispatcher: the note as captured now, and the section it is about. */
export function hostPaneRequest(
  src: PaneHostSources,
  id: ActionId = "open-details",
): ActionRequest {
  return hostPane(src).request(id);
}

/** Why a pane button is off while shared sections are off on this device: only joining runs. */
export const SECTIONS_OFF = "Shared sections are off on this device.";

/**
 * The model with every action this host cannot run turned off, with the
 * reason in words (A5): the pane never draws a button that does nothing.
 * Every action has its handler in the dispatcher (LFCP-03-013); what a
 * host cannot run is what needs shared sections while they are off.
 */
export function wiredModel(m: PaneModel, runs: (id: PaneAction["id"]) => boolean): PaneModel {
  const wire = (a: PaneAction): PaneAction =>
    !a.enabled || runs(a.id) ? a : { ...a, enabled: false, reason: SECTIONS_OFF };
  return {
    ...m,
    join: wire(m.join),
    primary: m.primary === null ? null : wire(m.primary),
    secondary: m.secondary.map(wire),
    menu: m.menu.map(wire),
  };
}
