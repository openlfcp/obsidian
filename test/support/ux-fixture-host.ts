// The frozen UX states (test/fixtures/ux-0.3/states.json) as the plugin
// reads them: the sections host a state gives (a fake, not the real
// SectionsHost) and the note in view. Shared by the recording-mock suite
// (test/obsidian/pane-fixtures.test.ts) and the native harness, which
// bundles this module into real Obsidian (test/native/fixture-host,
// specs/pane-fixture-states.e2e.mjs; LFCP-03-025).
//
// The host: its registry rows, each section's StatusView from the real
// reducer, its access list's facts and the flows in the shape
// SectionActions.flows() gives them. The plugin turns them into the pane
// (host adapter, view model, wired dispatcher) and the real renderer draws it.

import { fromBase64url } from "@openlfcp/core";
import type { PaneAccess } from "../../src/core/pane/host-facts";
import { type FixtureFacts, statusFactsOf } from "../../src/core/pane/mock-facts";
import type { ActiveFlow } from "../../src/core/sections/actions";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { RegistryRow, RegistrySnapshot } from "../../src/core/sections/registry-view";
import { type StatusView, statusView } from "../../src/core/status/reducer";

export interface Expected {
  primaryCta: string | null;
  primaryCtaNone?: string;
  enabled: { action: string; reason: string }[];
  disabled: { action: string; reason: string }[];
  requiredClaims: string[];
  forbiddenClaims: string[];
}
export interface State {
  id: string;
  facts: FixtureFacts & { preview?: unknown };
  expected: Expected;
}

/**
 * The fixtures' stage names that SectionActions does not report: it says
 * "writing" until an insert settles, so an unknown one is at "writing".
 */
export const HOST_STEP: Readonly<Record<string, string>> = { projected: "writing" };

export const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
export const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
export const KEY = `${R0}#${SID}`;

/** The Resource of the fixtures' section (the one a state may have just joined). */
export const fixtureResource = (): Uint8Array => fromBase64url(R0);

/** A note with the section: line 4 is inside it. */
const SHARED = [
  "# Plan",
  "Intro.",
  "",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "",
].join("\n");
/** A private note: a heading's section (lines 3–5), then another heading. */
const PRIVATE = [
  "# Plan",
  "Intro.",
  "",
  "## Launch",
  "- [ ] Alpha",
  "- [ ] Beta",
  "",
  "## Next",
  "Text.",
  "",
].join("\n");

/**
 * The notes of the states with a share preview, written so the preflight
 * gives the fixture's facts. selection-exact: lines 4–9 (2 Tasks, a
 * paragraph under a Task, a closing paragraph), a private paragraph after
 * them under the same heading. content-comments-and-table: a heading with
 * a paragraph under a Task, a table, a fence and a %% comment.
 */
const PREVIEW_NOTE: Readonly<Record<string, string>> = {
  "selection-exact": [
    "# Plan",
    "Intro.",
    "",
    "## Launch",
    "- [ ] Alpha",
    "  A note on Alpha.",
    "- [ ] Beta",
    "",
    "Closing paragraph.",
    "",
    "Private paragraph.",
    "",
    "## Next",
    "Text.",
    "",
  ].join("\n"),
  "content-comments-and-table": [
    "# Plan",
    "Intro.",
    "",
    "## Launch",
    "- [ ] Alpha",
    "  A note on Alpha.",
    "- [ ] Beta",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```js",
    "x",
    "```",
    "",
    "%% private comment %%",
    "",
    "## Next",
    "Text.",
    "",
  ].join("\n"),
};

export type Sel = { from: { line: number; ch: number }; to: { line: number; ch: number } };
/** The selection each selection state makes in PRIVATE. */
const SELECTION: Readonly<Record<string, Sel>> = {
  // In PREVIEW_NOTE["selection-exact"]: from the heading through "Closing paragraph.".
  exact: { from: { line: 3, ch: 0 }, to: { line: 8, ch: 18 } },
  "no-heading-start": { from: { line: 4, ch: 0 }, to: { line: 5, ch: 10 } },
  crossing: { from: { line: 3, ch: 0 }, to: { line: 8, ch: 5 } },
  "heading-only": { from: { line: 3, ch: 0 }, to: { line: 3, ch: 9 } },
};

function row(st: State, view: StatusView): RegistryRow {
  const s = st.facts.section;
  if (s === null) throw new Error("no section");
  const complete = st.facts.registry.placementIndex === "complete";
  const placed = s.placements === null ? null : s.placements;
  return {
    resource: R0,
    sectionId: SID,
    key: KEY,
    sharedTitle: s.sharedTitle,
    localAlias: s.localAlias,
    registryState: "available",
    refusal: s.refusal,
    status: { watched: true, state: view.state, label: view.label },
    placements: Array.from({ length: placed ?? 0 }, (_, i) => ({ path: `N${i}.md` }) as never),
    placementCount: complete ? placed : null,
    placed: (placed ?? 0) > 0 ? "placed" : complete && placed === 0 ? "unplaced" : "unknown",
  };
}

/** Rows that only make up the fixture's count: other sections, placed elsewhere. */
const filler = (i: number): RegistryRow => ({
  resource: `other${i}`,
  sectionId: `s${i}`,
  key: `other${i}#s${i}`,
  sharedTitle: `Other ${i}`,
  localAlias: null,
  registryState: "available",
  refusal: null,
  status: { watched: false, state: null, label: null },
  placements: [{ path: `Elsewhere ${i}.md` } as never],
  placementCount: 1,
  placed: "placed",
});

/** What the plugin reads for a state: its sections host, as the pane sees it. */
export function hostOf(st: State) {
  const f = st.facts;
  const s = f.section;
  const view = s === null ? null : statusView(statusFactsOf(s));
  const rows: RegistryRow[] = [];
  if (s !== null && view !== null) rows.push(row(st, view));
  while (rows.length < (f.registry.sections ?? 0)) rows.push(filler(rows.length));
  const snapshot: RegistrySnapshot = {
    version: 1,
    status: f.registry.status,
    error: null,
    placementIndex: f.registry.placementIndex,
    rows,
    sections: f.registry.sections,
    unplaced: f.registry.unplaced,
  };
  const access: PaneAccess | undefined =
    s === null
      ? undefined
      : {
          canInvite: s.accessView.canInvite,
          hosting: s.hosting ?? "unknown",
          ...(s.accessView.canRemove === undefined ? {} : { canRemove: s.accessView.canRemove }),
        };
  const flow = f.context.flow;
  const flows: ActiveFlow[] =
    flow === null || (flow.kind !== "share" && flow.kind !== "insert")
      ? []
      : [
          {
            generation: 7,
            kind: flow.kind,
            path: flow.target ?? f.context.note,
            stage: "",
            // The step the real host reports: an insert whose result is unknown stopped while writing.
            step: HOST_STEP[flow.stage] ?? flow.stage,
            outcome: flow.outcome,
            checking: false,
          },
        ];
  return {
    registry: { snapshot: () => snapshot, onChange: () => () => undefined },
    onStatusChange: () => () => undefined,
    sectionStatus: (key: string) => (key === KEY && view !== null ? view : undefined),
    paneAccess: (key: string) => (key === KEY ? access : undefined),
    recoveryItems: () => [],
    hostFacts: () => ({ unavailable: null, starting: false, readOnly: false, server: true }),
    sharePolicy: () => ({ server: "wss://sync.example/v1/ws", comments: "local" as const }),
    actions: {
      paneEntry: () => undefined,
      shareResult: () => undefined,
      flows: () => flows,
      onFlowsChange: () => () => undefined,
    },
    noteRenamed: () => undefined,
    noteDeleted: () => undefined,
  };
}

/** The note in view for a state: its path, text, view mode, cursor line and selection. */
export interface NoteSpec {
  path: string;
  text: string;
  /** Obsidian's MarkdownView mode: "source" (editing) or "preview" (Reading). */
  mode: "source" | "preview";
  cursorLine: number;
  selection: Sel | null;
}

/** The note in view for a state, or none. */
export function noteSpec(st: State): NoteSpec | null {
  const c = st.facts.context;
  if (c.note === null) return null;
  const inside = c.cursor === "inside-section";
  const spec: NoteSpec = {
    path: c.note,
    text: inside ? SHARED : (PREVIEW_NOTE[st.id] ?? PRIVATE),
    mode: c.editor === "reading" ? "preview" : "source",
    cursorLine: inside ? 5 : c.cursor === "private-heading" ? 3 : 1,
    selection: null,
  };
  const sel = c.selection;
  if (sel !== null) {
    const at = SELECTION[sel.eligibility === "exact" ? "exact" : (sel.reason ?? "")];
    if (at === undefined) throw new Error(`no selection for ${st.id}`);
    spec.selection = at;
    spec.cursorLine = at.to.line;
  }
  return spec;
}

/** Whether the pane is about the section as just joined (D9): a section not under the cursor. */
export const joinedFirst = (st: State): boolean =>
  st.facts.section !== null && st.facts.context.cursor !== "inside-section";
