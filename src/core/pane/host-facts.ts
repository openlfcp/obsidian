// The pane's facts from the real host (LFCP-03-012): a minimal adapter from
// what the plugin already knows to the pane's view model (model.ts). It
// reads, never writes, and opens nothing:
//
//   - the last active Markdown note, as captured now (TargetCapture: its
//     text, cursor, selections and mode), or none;
//   - the section registry view (SectionRegistryView, LFCP-03-011);
//   - each section's status through the one status path (StatusView);
//   - the host's running state (HostFacts, the descriptors' guard).
//
// What it does not know yet it leaves out rather than invent: no flow, no
// unfinished list, no section chosen in the list or just joined, no access
// list (canInvite unknown). LFCP-03-013 adds those (D9, D10, the CTA rows).
// Pure: no Obsidian, no DOM.

import { type HostFacts, RUNNING } from "../actions/descriptors";
import type { ActionRequest } from "../actions/dispatcher";
import { sectionAtLine } from "../sections/context";
import type { RegistryRow, RegistrySnapshot } from "../sections/registry-view";
import { proposeRange } from "../sections/share";
import { shareScope, type TargetCapture } from "../sections/target";
import { type StatusView, statusView } from "../status/reducer";
import type {
  PaneAction,
  PaneContext,
  PaneFacts,
  PaneModel,
  PaneRegistry,
  PaneSection,
  PaneSelection,
} from "./model";

/** What the pane host reads, each time the pane redraws. */
export interface PaneHostSources {
  /** The last active Markdown note, read now; null when none is open. */
  readonly note: TargetCapture | null;
  /** The registry view's snapshot; null while shared sections are off on this device. */
  readonly registry: RegistrySnapshot | null;
  /** A section's status from the one status path; undefined before its first. */
  readonly status: (key: string) => StatusView | undefined;
  /** The host's running state; absent: running. */
  readonly host?: HostFacts;
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
  status: (key: string) => StatusView | undefined,
): PaneSection {
  const row = rows.find((r) => r.key === at.key);
  return {
    key: at.key,
    sharedTitle: row?.sharedTitle ?? (at.title === "" ? null : at.title),
    localAlias: row?.localAlias ?? null,
    placements: row?.placementCount ?? null,
    view: status(at.key) ?? unknownStatus(),
    // The access list is the card's (AccessView); the pane reads it in LFCP-03-013.
    canInvite: null,
  };
}

/** The pane's facts from the host's sources (see the module comment for what is left out). */
export function hostPaneFacts(src: PaneHostSources): PaneFacts {
  const note = src.note;
  // D9: the section under the cursor; the list choice and the just-joined one come with 013.
  const at = underCursor(note);
  const context: PaneContext = {
    editor: note === null ? "none" : note.mode,
    note: note?.path ?? null,
    cursor:
      note === null
        ? "none"
        : at !== null
          ? "inside-section"
          : proposeRange(note.text, note.cursorLine) !== null
            ? "private-heading"
            : "private-text",
    selection: note === null || at !== null ? null : selectionOf(note),
    flow: null,
  };
  return {
    context,
    registry: registryOf(src.registry),
    section: at === null ? null : sectionOf(at, src.registry?.rows ?? [], src.status),
    host: src.host ?? RUNNING,
  };
}

/** What a pane button hands the dispatcher: the note as captured now, and the section it is about. */
export function hostPaneRequest(src: Pick<PaneHostSources, "note">): ActionRequest {
  const note = src.note;
  const at = underCursor(note);
  return {
    ...(note === null ? {} : { target: note }),
    ...(at === null ? {} : { section: at }),
  };
}

/** Why a button is off when this host has no handler for its action yet, and no other entry exists. */
export const NOT_WIRED = "Not available in the pane yet.";

/**
 * The other entry of an action the pane cannot run yet, named exactly: a
 * palette command or a button of the section card. Temporary, until
 * LFCP-03-013 gives these actions their handlers.
 */
const ELSEWHERE: Partial<Record<PaneAction["id"], string>> = {
  "go-to-problem":
    'Not available in the pane yet. Run "Go to next shared section problem" from the command palette.',
  "copy-readable":
    'Not available in the pane yet. Run "Copy readable text (without sharing metadata)" from the command palette.',
  "remove-access":
    'Not available in the pane yet. Use "Remove access…" in the section\'s details card.',
  "discard-local-copy":
    "Not available in the pane yet. Use the section's details card to discard the local copy.",
};

/** Why the pane cannot run `id` yet, naming its real entry when it has one. */
export function notWiredReason(id: PaneAction["id"]): string {
  return ELSEWHERE[id] ?? NOT_WIRED;
}

/**
 * The model with every action this host cannot run turned off, with the
 * reason in words (A5, A6): the pane never draws a button that does nothing.
 */
export function wiredModel(m: PaneModel, handles: (id: PaneAction["id"]) => boolean): PaneModel {
  const wire = (a: PaneAction): PaneAction =>
    !a.enabled || handles(a.id) ? a : { ...a, enabled: false, reason: notWiredReason(a.id) };
  return {
    ...m,
    join: wire(m.join),
    primary: m.primary === null ? null : wire(m.primary),
    secondary: m.secondary.map(wire),
    menu: m.menu.map(wire),
  };
}
