// @vitest-environment happy-dom
// LFCP-03-013 (U03-02, U03-03, U03-06, U03-28): the frozen UX states
// (test/fixtures/ux-0.3/states.json) through the real plugin's pane path,
// not the mock facts. Each state becomes what the plugin reads: a note in a
// Markdown view (its text, cursor and selection) on the recording Obsidian
// mock, and a sections host. The sections host is built by hand in
// test/support/ux-fixture-host.ts (a fake, not the real SectionsHost; the
// native harness draws the same states with it): its registry rows, each section's
// StatusView from the real reducer, its access list's facts and the flows
// in the shape SectionActions.flows() gives them. The real plugin turns
// them into the pane (host adapter, view model, wired dispatcher) and the
// real renderer draws it. The drawn pane must give the fixture's primary
// call to action, its enabled and disabled actions with their reasons word
// for word, its claims and none of the forbidden ones.
//
// Coverage: all 21 states in full, the share previews of selection-exact
// and content-comments-and-table included (LFCP-03-014: the pane's preview
// is the share dialog's preflight on the note in view, its counts and
// warnings the fixture's), the join flow's (LFCP-03-015: the plugin's join
// flow, CollabCommands.joins, at the fixture's stage), and the unfinished
// insert a restart leaves (LFCP-03-017: SectionActions.flows() lists it from the
// insertion journal, at "writing").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, type ActionId } from "../../src/core/actions/catalog";
import { JoinFlow, type JoinFlowState } from "../../src/core/collab/join-flow";
import { shareCounts, shareWarningText } from "../../src/core/sections/share";
import OpenLfcpPlugin from "../../src/main";
import { PANE_VIEW, type SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";
import {
  fixtureResource,
  HOST_STEP,
  hostOf,
  joinedFirst,
  noteSpec,
  type State,
} from "../support/ux-fixture-host";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ux-0.3/states.json"), "utf8"),
) as { globalForbiddenClaims: string[]; states: State[] };

/** States the host cannot produce yet, and the task that brings them. */
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

const NOT_YET: Readonly<Record<string, string>> = {};

/** The note in view for a state, or none, on the recording mock. */
function noteOf(st: State): mock.MarkdownView | null {
  const n = noteSpec(st);
  if (n === null) return null;
  const v = new mock.MarkdownView(new mock.TFile(n.path), n.text);
  v.mode = n.mode;
  v.cursorLine = n.cursorLine;
  if (n.selection !== null) v.selection = n.selection;
  return v;
}

const time = /^at /;

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
  if (joinedFirst(st)) plugin.sectionJoined(fixtureResource() as never);
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
  // The destructive actions are in the host's menu (A8): opened as a user does, read as drawn.
  mock.shownMenus.length = 0;
  const more = el.querySelector<HTMLButtonElement>('button[data-pane-key="menu"]');
  if (more?.getAttribute("aria-disabled") !== "true") more?.click();
  const menu = mock.shownMenus.at(-1)?.items ?? [];
  const reasonOf = (b: HTMLButtonElement) => {
    const id = b.getAttribute("aria-describedby");
    if (id !== null) return el.querySelector(`#${id}`)?.textContent ?? null;
    // A header icon: the tooltip is its accessible name, "label — reason".
    const name = b.getAttribute("aria-label");
    const at = name?.indexOf(" — ") ?? -1;
    return name === null || at < 0 ? null : name.slice(at + 3);
  };
  /** A drawn action, as a button of the pane or an item of its menu: blocked or not, and why. */
  const action = (id: string): { blocked: boolean; reason: string | null } | undefined => {
    const b = buttons.find((x) => x.dataset.action === id);
    if (b !== undefined)
      return { blocked: b.getAttribute("aria-disabled") === "true", reason: reasonOf(b) };
    const label = ACTIONS[id as ActionId].label;
    const item = menu.find((i) => i.title === label || i.title.startsWith(`${label} — `));
    if (item === undefined) return undefined;
    return {
      blocked: item.disabled,
      reason: item.disabled ? item.title.slice(label.length + 3) : null,
    };
  };
  const primary = el.querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
  const none = el.querySelector(".openlfcp-pane-none")?.textContent ?? null;
  (plugin as unknown as { sections: unknown }).sections = null;
  return {
    el,
    action,
    primary,
    none,
    texts: [...textsOf(el), ...menu.map((i) => i.title)],
  };
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
          expect(b?.blocked, `${e.action} enabled (${b?.reason})`).toBe(false);
        }
        for (const x of st.expected.disabled) {
          const b = d.action(x.action);
          expect(b, `${x.action} drawn`).toBeDefined();
          expect(b?.blocked, `${x.action} disabled`).toBe(true);
          if (b !== undefined) expect(b.reason).toBe(x.reason);
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
