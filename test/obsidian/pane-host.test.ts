// @vitest-environment happy-dom
// LFCP-03-012 (F-01, F-02; U03-01, U03-20): the Shared Tasks pane on the
// real plugin against the recording Obsidian mock. Its entries (ribbon,
// command, editor menu; the card's link is in test/core/sections/actions)
// reveal one leaf per workspace, also when called at once or over a
// restored layout with two. Every subscription is given back on close and
// on unload, after any number of open/close cycles, and a redraw scheduled
// before a close never runs. Buttons go through the dispatcher (surface
// "pane"). No dialog opens by itself (no wizard); the join entry is always
// there; nothing claims an OS link handler. Mobile loads it the same way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId } from "../../src/core/actions/catalog";
import type { ActionRequest, Surface } from "../../src/core/actions/dispatcher";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { RegistrySnapshot } from "../../src/core/sections/registry-view";
import OpenLfcpPlugin from "../../src/main";
import { OPEN_PANE, PANE_VIEW, SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;
const TEXT = [
  "# Plan",
  "Private text.",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "",
].join("\n");

type Run = { id: ActionId; request: ActionRequest; surface: Surface };

async function loaded() {
  const app = new mock.App();
  const plugin = new OpenLfcpPlugin(app as never, manifest as never);
  const host = plugin as unknown as mock.Plugin;
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  // A running host (the mock has no IndexedDB for the real runtime): nothing is "still starting".
  plugin.runtimeError = null;
  plugin.runtime = {} as never;
  const runs: Run[] = [];
  plugin.actions.run = async (id, request = {}, surface = "palette") => {
    runs.push({ id, request, surface });
  };
  const ws = app.workspace;
  const leaves = () => ws.getLeavesOfType(PANE_VIEW) as mock.WorkspaceLeaf[];
  const view = () => leaves()[0]?.view as unknown as SharedTasksView | undefined;
  const el = () => view()?.contentEl as unknown as HTMLElement;
  const button = (label: string) => {
    const b = Array.from(el().querySelectorAll("button")).find((x) => x.textContent === label);
    if (b === undefined) throw new Error(`no button ${label} in ${el().textContent}`);
    return b;
  };
  return { app, plugin, host, ws, leaves, view, el, button, runs };
}

/** A fake sections host: the registry view and status sources the pane subscribes to. */
function fakeSections() {
  const registryListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const snapshot: RegistrySnapshot = {
    version: 1,
    status: "ready",
    error: null,
    placementIndex: "complete",
    rows: [],
    sections: 0,
    unplaced: 0,
  };
  return {
    registryListeners,
    statusListeners,
    registry: {
      snapshot: () => snapshot,
      onChange: (l: () => void) => {
        registryListeners.add(l);
        return () => registryListeners.delete(l);
      },
    },
    onStatusChange: (l: () => void) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    sectionStatus: () => undefined,
    hostFacts: () => ({ unavailable: null, starting: false, readOnly: false, server: true }),
    actions: { paneEntry: () => undefined },
    // What the plugin's own vault listeners call on it.
    noteRenamed: () => undefined,
    noteDeleted: () => undefined,
  };
}

const counts = (app: mock.App) => ({
  workspace: app.workspace.handlers.length,
  vault: app.vault.handlers.length,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  mock.modals.length = 0;
  mock.notices.length = 0;
});

afterEach(() => {
  mock.Platform.isMobile = false;
  vi.restoreAllMocks();
});

describe("Shared Tasks pane host (LFCP-03-012)", () => {
  it("U03-01: a ribbon icon and a command open it; again, they reveal the same leaf", async () => {
    const t = await loaded();
    expect(t.host.ribbon).toEqual([
      { icon: "list-checks", title: OPEN_PANE, callback: expect.any(Function) },
    ]);
    const command = t.host.commands.find((c) => c.id === "open-shared-tasks-pane");
    expect(command?.name).toBe("Open Shared Tasks pane");
    expect(t.leaves()).toHaveLength(0);

    t.host.ribbon[0]?.callback({});
    await wait(0);
    expect(t.leaves()).toHaveLength(1);
    const first = t.leaves()[0];
    command?.callback?.();
    await wait(0);
    t.host.ribbon[0]?.callback({});
    await wait(0);
    expect(t.leaves()).toEqual([first]);
    expect(t.ws.revealed).toEqual([first, first, first]);
    // No dialog opened by itself: no wizard, no tour.
    expect(mock.modals).toEqual([]);
  });

  it("U03-20: calls at once open one leaf; a restored layout with two keeps one", async () => {
    const t = await loaded();
    await Promise.all([t.plugin.openPane(), t.plugin.openPane(), t.plugin.openPane()]);
    expect(t.leaves()).toHaveLength(1);
    // A second leaf of the pane (a restored or split layout): the layout change closes it.
    const extra = t.ws.getRightLeaf(false) as mock.WorkspaceLeaf;
    await extra.setViewState({ type: PANE_VIEW });
    await wait(0);
    expect(t.leaves()).toHaveLength(1);
    expect(extra.view).toBeNull();
  });

  it("the editor menu offers the pane and the cursor's next step, run through the dispatcher", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const view = new mock.MarkdownView(new mock.TFile("Plan.md"), TEXT);
    view.cursorLine = 0;
    const menu = new mock.Menu();
    t.ws.trigger("editor-menu", menu, view.editor, view);
    expect(menu.items.map((i) => i.title)).toEqual(["Share section…", OPEN_PANE]);
    menu.items[0]?.onClickHandler();
    expect(t.runs).toEqual([
      {
        id: "share-section",
        request: { target: expect.objectContaining({ path: "Plan.md", cursorLine: 0 }) },
        surface: "menu",
      },
    ]);
    menu.items[1]?.onClickHandler();
    await wait(0);
    expect(t.leaves()).toHaveLength(1);
    // Inside the shared section: its details, with the section it is about.
    view.cursorLine = 4;
    const inside = new mock.Menu();
    t.ws.trigger("editor-menu", inside, view.editor, view);
    expect(inside.items.map((i) => i.title)).toEqual(["Open details", OPEN_PANE]);
    inside.items[0]?.onClickHandler();
    expect(t.runs[1]).toMatchObject({
      id: "open-details",
      request: { section: { key: KEY, title: "Launch" } },
      surface: "menu",
    });
    (t.plugin as unknown as { sections: unknown }).sections = null;
  });

  it("A2: the join entry is in the pane with no note, and runs through the dispatcher", async () => {
    const t = await loaded();
    await t.plugin.openPane();
    expect(t.el().textContent).toContain("No note open");
    t.button("Join with a link…").click();
    expect(t.runs).toEqual([{ id: "join-with-link", request: {}, surface: "pane" }]);
    expect(t.el().textContent).not.toMatch(/protocol|wizard/i);
  });

  it("T1: the pane follows the last Markdown note; focus in the pane keeps it", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const note = new mock.MarkdownView(new mock.TFile("Plan.md"), TEXT);
    t.ws.views.push(note);
    t.ws.activeView = note;
    await t.plugin.openPane();
    expect(t.el().textContent).toContain("In this note: Plan.md");
    // Focus moves to the pane: no Markdown view is active any more.
    t.ws.activeView = null;
    t.ws.trigger("active-leaf-change", t.leaves()[0]);
    t.view()?.render();
    expect(t.el().textContent).toContain("In this note: Plan.md");
    t.button("Share section…").click();
    expect(t.runs.at(-1)).toMatchObject({
      id: "share-section",
      request: { target: { path: "Plan.md" } },
      surface: "pane",
    });
    // The note closed: no target is kept for it.
    t.ws.views.length = 0;
    t.view()?.render();
    expect(t.el().textContent).toContain("No note open");
    (t.plugin as unknown as { sections: unknown }).sections = null;
  });

  it("U03-20: N open/close cycles leave no subscription and no late redraw", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const before = counts(t.app);
    // Redraws of this test's panes (another test's pane may still be open on its own app).
    const draw = SharedTasksView.prototype.render;
    let drawn = 0;
    vi.spyOn(SharedTasksView.prototype, "render").mockImplementation(function (
      this: SharedTasksView,
    ) {
      if ((this as unknown as { app: unknown }).app === t.app) drawn++;
      draw.call(this);
    });
    for (let i = 0; i < 25; i++) {
      await t.plugin.openPane();
      const v = t.view();
      expect(v?.subscriptions).toBeGreaterThan(0);
      expect(sections.registryListeners.size).toBe(1);
      expect(sections.statusListeners.size).toBe(1);
      // A change schedules a redraw; the pane closes before it runs.
      t.ws.trigger("editor-change");
      t.leaves()[0]?.detach();
      await wait(0);
      expect(v?.subscriptions).toBe(0);
    }
    expect(sections.registryListeners.size).toBe(0);
    expect(sections.statusListeners.size).toBe(0);
    expect(counts(t.app)).toEqual(before);
    await wait(150);
    // Only the redraw of each open: none scheduled before a close ran after it.
    expect(drawn).toBe(25);
    (t.plugin as unknown as { sections: unknown }).sections = null;
  });

  it("a change while open redraws once, coalesced; unload without close gives everything back", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const before = counts(t.app);
    await t.plugin.openPane();
    const v = t.view() as SharedTasksView;
    const render = vi.spyOn(v, "render");
    for (const l of sections.registryListeners) l();
    for (const l of sections.statusListeners) l();
    t.ws.trigger("file-open");
    t.app.vault.trigger("rename", new mock.TFile("New.md"), "Old.md");
    await wait(150);
    expect(render).toHaveBeenCalledTimes(1);
    // The plugin goes away: Obsidian unloads the view (no close first).
    (v as unknown as mock.Component).unload();
    expect(v.subscriptions).toBe(0);
    expect(sections.registryListeners.size).toBe(0);
    expect(counts(t.app)).toEqual(before);
    for (const l of sections.statusListeners) l();
    await wait(150);
    expect(render).toHaveBeenCalledTimes(1);
    (t.plugin as unknown as { sections: unknown }).sections = null;
  });

  it("a button of a pane drawn before a close does nothing", async () => {
    const t = await loaded();
    await t.plugin.openPane();
    const join = t.button("Join with a link…");
    await (t.view() as SharedTasksView).onClose();
    join.click();
    expect(t.runs).toEqual([]);
  });

  it("mobile: the plugin loads with the pane, which opens with its join entry", async () => {
    mock.Platform.isMobile = true;
    const t = await loaded();
    await t.plugin.openPane();
    expect(t.leaves()).toHaveLength(1);
    expect(t.button("Join with a link…")).toBeDefined();
    expect(mock.modals).toEqual([]);
  });
});
