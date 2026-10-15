// @vitest-environment happy-dom
// LFCP-03-013 (U03-02, U03-03, U03-06, U03-28): the frozen UX states
// (test/fixtures/ux-0.3/states.json) through the real plugin's pane path,
// not the mock facts. Each state becomes what the plugin reads: a note in a
// Markdown view (its text, cursor and selection) on the recording Obsidian
// mock, and a sections host. The sections host is built by hand here (a
// fake, not the real SectionsHost): its registry rows, each section's
// StatusView from the real reducer, its access list's facts and the flows
// in the shape SectionActions.flows() gives them. The real plugin turns
// them into the pane (host adapter, view model, wired dispatcher) and the
// real renderer draws it. The drawn pane must give the fixture's primary
// call to action, its enabled and disabled actions with their reasons word
// for word, its claims and none of the forbidden ones.
//
// Coverage: 20 states in full, the share previews of selection-exact and
// content-comments-and-table included (LFCP-03-014: the pane's preview is
// the share dialog's preflight on the note in view, its counts and warnings
// the fixture's), and the join flow's (LFCP-03-015: the plugin's join flow,
// CollabCommands.joins, at the fixture's stage); 1 todo, needing a flow the
// host cannot produce yet: an unfinished flow read from the journals
// (LFCP-03-017).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinFlow, type JoinFlowState } from "../../src/core/collab/join-flow";
import type { PaneAccess } from "../../src/core/pane/host-facts";
import { type FixtureFacts, statusFactsOf } from "../../src/core/pane/mock-facts";
import type { ActiveFlow } from "../../src/core/sections/actions";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { RegistryRow, RegistrySnapshot } from "../../src/core/sections/registry-view";
import { shareCounts, shareWarningText } from "../../src/core/sections/share";
import { type StatusView, statusView } from "../../src/core/status/reducer";
import OpenLfcpPlugin from "../../src/main";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";

interface Expected {
  primaryCta: string | null;
  primaryCtaNone?: string;
  enabled: { action: string; reason: string }[];
  disabled: { action: string; reason: string }[];
  requiredClaims: string[];
  forbiddenClaims: string[];
}
interface State {
  id: string;
  facts: FixtureFacts & { preview?: unknown };
  expected: Expected;
}

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ux-0.3/states.json"), "utf8"),
) as { globalForbiddenClaims: string[]; states: State[] };

/** States the host cannot produce yet, and the task that brings them. */
/**
 * The fixtures' stage names that SectionActions does not report: it says
 * "writing" until an insert settles, so an unknown one is at "writing".
 */
const HOST_STEP: Readonly<Record<string, string>> = { projected: "writing" };

/** The steps SectionActions reports (actions.ts ActiveFlow.step), and the join flow's (join-flow.ts). */
const HOST_STEPS = new Set([
  "preview",
  "creating",
  "captured",
  "writing",
  "link",
  "claiming capability",
  "access",
  "loading",
  "choose-place",
]);

const NOT_YET: Readonly<Record<string, string>> = {
  "unfinished-insert": "an unfinished flow read from the journals (LFCP-03-017)",
};

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;

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

type Sel = { from: { line: number; ch: number }; to: { line: number; ch: number } };
/** The selection each selection state makes in PRIVATE. */
const SELECTION: Readonly<Record<string, Sel>> = {
  // In PREVIEW_NOTE["selection-exact"]: from the heading through "Closing paragraph.".
  exact: { from: { line: 3, ch: 0 }, to: { line: 8, ch: 18 } },
  "no-heading-start": { from: { line: 4, ch: 0 }, to: { line: 5, ch: 10 } },
  crossing: { from: { line: 3, ch: 0 }, to: { line: 8, ch: 5 } },
  "heading-only": { from: { line: 3, ch: 0 }, to: { line: 3, ch: 9 } },
};

const time = /^at /;

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
function hostOf(st: State) {
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
    s === null ? undefined : { canInvite: s.accessView.canInvite, hosting: s.hosting ?? "unknown" };
  const flow = f.context.flow;
  const flows: ActiveFlow[] =
    flow === null ||
    (flow.kind !== "share" && flow.kind !== "insert") ||
    flow.outcome === "unfinished"
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

/** The note in view for a state, or none. */
function noteOf(st: State): mock.MarkdownView | null {
  const c = st.facts.context;
  if (c.note === null) return null;
  const inside = c.cursor === "inside-section";
  const v = new mock.MarkdownView(
    new mock.TFile(c.note),
    inside ? SHARED : (PREVIEW_NOTE[st.id] ?? PRIVATE),
  );
  v.mode = c.editor === "reading" ? "preview" : "source";
  v.cursorLine = inside ? 5 : c.cursor === "private-heading" ? 3 : 1;
  const sel = c.selection;
  if (sel !== null) {
    const at = SELECTION[sel.eligibility === "exact" ? "exact" : (sel.reason ?? "")];
    if (at === undefined) throw new Error(`no selection for ${st.id}`);
    v.selection = at;
    v.cursorLine = at.to.line;
  }
  return v;
}

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

async function drawn(st: State) {
  const app = new mock.App();
  const plugin = new OpenLfcpPlugin(app as never, manifest as never);
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  plugin.runtimeError = null;
  plugin.runtime = {} as never;
  (plugin as unknown as { sections: unknown }).sections = hostOf(st);
  // D9: a section not under the cursor is the one just joined.
  if (st.facts.section !== null && st.facts.context.cursor !== "inside-section")
    plugin.sectionJoined(fromBase64url(R0) as ResourceId);
  // A join flow is the plugin's own (CollabCommands.joins), at the fixture's stage.
  const jf = st.facts.context.flow;
  vi.restoreAllMocks();
  if (jf !== null && jf.kind === "join" && jf.outcome !== "unfinished")
    vi.spyOn(JoinFlow.prototype, "state").mockReturnValue({
      generation: 1,
      stage: jf.stage as JoinFlowState["stage"],
      outcome: jf.outcome,
      resource: null,
      facts: [],
      problem: null,
      problemKind: null,
      checking: false,
    });
  const note = noteOf(st);
  if (note !== null) {
    app.workspace.views.push(note);
    app.workspace.activeView = note;
  }
  await plugin.openPane();
  const leaf = app.workspace.getLeavesOfType(PANE_VIEW)[0] as mock.WorkspaceLeaf;
  const view = leaf.view as unknown as SharedTasksView;
  view.render();
  const el = view.contentEl as unknown as HTMLElement;
  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("button[data-action]"));
  const action = (id: string) => buttons.find((b) => b.dataset.action === id);
  const reasonOf = (b: HTMLButtonElement) => {
    const id = b.getAttribute("aria-describedby");
    return id === null ? null : (el.querySelector(`#${id}`)?.textContent ?? null);
  };
  const primary = el.querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
  const none = el.querySelector(".openlfcp-pane-none")?.textContent ?? null;
  (plugin as unknown as { sections: unknown }).sections = null;
  return { el, buttons, action, reasonOf, primary, none, texts: textsOf(el) };
}

/** Every text the drawn pane shows, one per element with its own text. */
function textsOf(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("*"))
    .filter((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3))
    .map((e) => e.textContent ?? "");
}

beforeEach(() => {
  mock.notices.length = 0;
});
afterEach(() => {
  mock.modals.length = 0;
});

type Preview = { counts: Parameters<typeof shareCounts>[0]; warnings: string[] };

describe("the UX 0.3 states on the real host (LFCP-03-013)", () => {
  it("names the states it cannot produce yet; every flow step is one the host reports", () => {
    const ids = new Set(doc.states.map((s) => s.id));
    for (const id of Object.keys(NOT_YET)) expect(ids.has(id), id).toBe(true);
    for (const st of doc.states) {
      const f = st.facts.context.flow;
      if (f !== null && NOT_YET[st.id] === undefined)
        expect(HOST_STEPS.has(HOST_STEP[f.stage] ?? f.stage), `${st.id}: ${f.stage}`).toBe(true);
    }
  });

  for (const st of doc.states) {
    const todo = NOT_YET[st.id];
    if (todo !== undefined) {
      it.todo(`${st.id}: needs ${todo}`);
      continue;
    }
    describe(st.id, () => {
      it("draws the fixture's primary call to action", async () => {
        const d = await drawn(st);
        expect(d.primary?.dataset.action ?? null, d.texts.join(" | ")).toBe(st.expected.primaryCta);
        if (d.primary !== null) expect(d.primary.getAttribute("aria-disabled")).toBeNull();
        else expect(d.none).toBe(st.expected.primaryCtaNone);
      });

      it("draws the enabled and disabled actions, with their reasons word for word", async () => {
        const d = await drawn(st);
        for (const e of st.expected.enabled) {
          const b = d.action(e.action);
          expect(b, `${e.action} drawn`).toBeDefined();
          expect(
            b?.getAttribute("aria-disabled"),
            `${e.action} enabled (${b && d.reasonOf(b)})`,
          ).toBeNull();
        }
        for (const x of st.expected.disabled) {
          const b = d.action(x.action);
          expect(b, `${x.action} drawn`).toBeDefined();
          expect(b?.getAttribute("aria-disabled"), `${x.action} disabled`).toBe("true");
          if (b !== undefined) expect(d.reasonOf(b)).toBe(x.reason);
        }
      });

      const preview = st.facts.preview as Preview | undefined;
      if (preview !== undefined)
        it("draws the share preview of the note in view: the fixture's counts and warnings (LFCP-03-014)", async () => {
          const d = await drawn(st);
          const texts = Array.from(
            d.el.querySelectorAll(".openlfcp-pane-preview .openlfcp-pane-line"),
          ).map((e) => e.textContent ?? "");
          expect(texts).toContain(`${shareCounts(preview.counts)}.`);
          for (const w of preview.warnings) {
            const t = shareWarningText(w as never);
            if (t !== null) expect(texts).toContain(t);
          }
          // The sync server it would go to, and nothing about the selection being dropped.
          expect(texts.join(" | ")).toContain("Sync server: wss://sync.example/v1/ws.");
        });

      it("makes its claims, and none of the forbidden ones", async () => {
        const d = await drawn(st);
        const all = d.el.textContent ?? "";
        for (const claim of st.expected.requiredClaims) expect(all, claim).toContain(claim);
        for (const claim of [...st.expected.forbiddenClaims, ...doc.globalForbiddenClaims])
          for (const t of d.texts)
            if (!time.test(t))
              expect(t.toLowerCase(), `"${t}" says "${claim}"`).not.toContain(claim.toLowerCase());
      });
    });
  }
});
