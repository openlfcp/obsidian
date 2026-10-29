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

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId } from "../../src/core/actions/catalog";
import type { ActionRequest, Surface } from "../../src/core/actions/dispatcher";
import type { PaneAccess } from "../../src/core/pane/host-facts";
import { contentHash } from "../../src/core/projection/guard";
import type { ActiveFlow } from "../../src/core/sections/actions";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { RecoveryItem } from "../../src/core/sections/recovery";
import type { RegistryRow, RegistrySnapshot } from "../../src/core/sections/registry-view";
import { type StatusFacts, type StatusView, statusView } from "../../src/core/status/reducer";
import OpenLfcpPlugin from "../../src/main";
import { domKey } from "../../src/obsidian/ui/pane-renderer";
import { OPEN_PANE, PANE_VIEW, SharedTasksView } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const SID2 = "019a2f85-7b31-7c42-b85a-fc843e2f4002";
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
  const flowListeners = new Set<() => void>();
  const flows: ActiveFlow[] = [];
  const rows: RegistryRow[] = [];
  const statuses = new Map<string, StatusView>();
  const access = new Map<string, PaneAccess>();
  const recovery = new Map<string, RecoveryItem[]>();
  const snapshot = (): RegistrySnapshot => ({
    version: 1,
    status: "ready",
    error: null,
    placementIndex: "complete",
    rows: [...rows],
    sections: rows.length,
    unplaced: rows.filter((r) => r.placed === "unplaced").length,
  });
  return {
    registryListeners,
    statusListeners,
    flowListeners,
    flows,
    rows,
    statuses,
    access,
    recovery,
    registry: {
      snapshot,
      onChange: (l: () => void) => {
        registryListeners.add(l);
        return () => registryListeners.delete(l);
      },
    },
    onStatusChange: (l: () => void) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    sectionStatus: (key: string) => statuses.get(key),
    paneAccess: (key: string) => access.get(key),
    recoveryItems: (key: string) => recovery.get(key) ?? [],
    hostFacts: () => ({ unavailable: null, starting: false, readOnly: false, server: true }),
    sharePolicy: () => ({ server: "wss://sync.example/v1/ws", comments: "local" as const }),
    actions: {
      paneEntry: () => undefined,
      shareResult: () => undefined,
      flows: () => [...flows],
      onFlowsChange: (l: () => void) => {
        flowListeners.add(l);
        return () => flowListeners.delete(l);
      },
    },
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
    const command = t.host.commands.find((c) => c.id === "open-pane");
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

  it("U03-18: an entry puts focus on the pane's heading; a redraw takes none", async () => {
    const t = await loaded();
    await t.plugin.openPane();
    // The pane as Obsidian shows it: in the page.
    document.body.appendChild(t.el());
    try {
      const outside = document.createElement("input");
      document.body.appendChild(outside);
      outside.focus();
      // A change while focus is elsewhere: drawn, focus untouched.
      t.view()?.render();
      expect(document.activeElement).toBe(outside);
      // The command (or the ribbon, a menu, the card's link) again: focus on the heading.
      t.host.commands.find((c) => c.id === "open-pane")?.callback?.();
      await wait(0);
      expect(document.activeElement?.getAttribute("data-pane-key")).toBe("title");
      expect(document.activeElement?.textContent).toBe("Shared Tasks");
      outside.remove();
    } finally {
      t.el().remove();
    }
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

  it("LFCP-03-021: first use leads to share and join; a tip hides per vault and comes back", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const before = structuredClone(t.host.stored);
    await t.plugin.openPane();
    // No tour: nothing opened by itself.
    expect(mock.modals).toEqual([]);
    expect(t.el().textContent).toContain(
      "No shared sections on this device yet. Share one from a note, or join one with a link.",
    );
    const tip = () => t.el().querySelector<HTMLElement>(".openlfcp-pane-hint");
    expect(tip()?.dataset.hint).toBe("first-use");
    expect(t.host.stored).toEqual(before);

    t.button("Hide tip").click();
    await wait(150);
    expect(tip()).toBeNull();
    expect(t.runs).toEqual([]);
    // Saved in this vault's settings, and only there: every other value as it was.
    expect(t.plugin.settings.dismissedHints).toEqual(["first-use"]);
    expect(t.host.stored).toEqual({ ...t.plugin.settings, dismissedHints: ["first-use"] });

    // Another start of the vault keeps it hidden.
    const again = await loaded();
    again.host.stored = structuredClone(t.host.stored);
    await again.plugin.onExternalSettingsChange();
    expect(again.plugin.settings.dismissedHints).toEqual(["first-use"]);

    t.button("Show tips again").click();
    await wait(150);
    expect(tip()?.dataset.hint).toBe("first-use");
    expect(t.plugin.settings.dismissedHints).toEqual([]);
    expect(mock.modals).toEqual([]);
    (t.plugin as unknown as { sections: unknown }).sections = null;
  });

  it("LFCP-03-021: a tip setting that cannot be saved says so, with no unhandled rejection", async () => {
    const t = await loaded();
    (t.plugin as unknown as { sections: unknown }).sections = fakeSections();
    await t.plugin.openPane();
    const save = vi.spyOn(t.plugin, "saveData").mockRejectedValue(new Error("disk full /x/y"));
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    t.button("Hide tip").click();
    await wait(150);
    process.off("unhandledRejection", on);
    expect(save).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    expect(mock.notices).toContain(
      "Shared Tasks: the tip setting could not be saved. It may change back after a restart.",
    );
    expect(mock.notices.some((n) => n.includes("disk full"))).toBe(false);
    (t.plugin as unknown as { sections: unknown }).sections = null;
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

  it("changes while open redraw once, coalesced; unload without close gives everything back", async () => {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const before = counts(t.app);
    await t.plugin.openPane();
    const v = t.view() as SharedTasksView;
    const render = vi.spyOn(v, "render");
    for (const l of sections.registryListeners) l();
    t.ws.trigger("file-open");
    t.ws.trigger("editor-change");
    await wait(150);
    expect(render).toHaveBeenCalledTimes(1);
    // P3: a status, a flow, a rename or a deletion is drawn at once, not coalesced.
    for (const l of sections.statusListeners) l();
    expect(render).toHaveBeenCalledTimes(2);
    for (const l of sections.flowListeners) l();
    t.app.vault.trigger("rename", new mock.TFile("New.md"), "Old.md");
    expect(render).toHaveBeenCalledTimes(4);
    await wait(150);
    expect(render).toHaveBeenCalledTimes(4);
    // The plugin goes away: Obsidian unloads the view (no close first).
    (v as unknown as mock.Component).unload();
    expect(v.subscriptions).toBe(0);
    expect(sections.registryListeners.size).toBe(0);
    expect(counts(t.app)).toEqual(before);
    for (const l of sections.statusListeners) l();
    await wait(150);
    expect(render).toHaveBeenCalledTimes(4);
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

/** A healthy section, its access verified current with the server. */
const healthy: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  accessVerifiedAt: 1,
  accessCurrent: true,
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [],
};

const rowOf = (over: Partial<RegistryRow> = {}): RegistryRow => ({
  resource: R0,
  sectionId: SID,
  key: KEY,
  sharedTitle: "Launch",
  localAlias: null,
  registryState: "available",
  refusal: null,
  status: { watched: true, state: "CURRENT", label: "Current" },
  placements: [{ path: "Plan.md" } as never],
  placementCount: 1,
  placed: "placed",
  ...over,
});

describe("the pane's context, flows and clicks (LFCP-03-013)", () => {
  async function open(over: { note?: string; cursor?: number } = {}) {
    const t = await loaded();
    const sections = fakeSections();
    (t.plugin as unknown as { sections: unknown }).sections = sections;
    const note = new mock.MarkdownView(new mock.TFile(over.note ?? "Plan.md"), TEXT);
    note.cursorLine = over.cursor ?? 4;
    t.ws.views.push(note);
    t.ws.activeView = note;
    sections.rows.push(rowOf());
    sections.statuses.set(KEY, statusView(healthy));
    sections.access.set(KEY, { canInvite: true, hosting: "hosted" });
    await t.plugin.openPane();
    const primary = () =>
      t.el().querySelector<HTMLButtonElement>(".openlfcp-pane-primary button") ?? null;
    return { ...t, sections, note, primary };
  }

  it("M3 / I4: with the access list's grant the primary action is Invite, run on that section", async () => {
    const t = await open();
    expect(t.primary()?.textContent).toBe("Invite collaborator…");
    t.primary()?.click();
    expect(t.runs.at(-1)).toMatchObject({
      id: "invite",
      request: { section: { key: KEY, title: "Launch" } },
      surface: "pane",
    });
  });

  it("P3, L2: a revocation disables at once; a click on the button drawn before runs nothing", async () => {
    const t = await open();
    const invite = t.primary();
    expect(invite?.textContent).toBe("Invite collaborator…");
    // The access was removed: the status pass says so; the pane draws at once, not coalesced.
    t.sections.statuses.set(KEY, statusView({ ...healthy, access: "revoked" }));
    for (const l of t.sections.statusListeners) l();
    expect(t.primary()?.dataset.action).not.toBe("invite");
    // A click that raced the redraw, on the old button: checked against the facts now.
    invite?.click();
    expect(t.runs).toEqual([]);
  });

  describe("problem hub (LFCP-03-018)", () => {
    const CONFLICT: RecoveryItem = {
      kind: "lifecycle",
      key: "lifecycle:n1",
      nodeId: "n1",
      label: 'Task "Alpha"',
    };
    const problem = (t: { el: () => HTMLElement }, id: string) =>
      t.el().querySelector<HTMLButtonElement>(`button[data-problem="${domKey(id)}"]`);

    it("a conflict row shows its reason and source; its button runs the review on that item", async () => {
      const t = await open();
      t.sections.recovery.set(KEY, [CONFLICT]);
      for (const l of t.sections.statusListeners) l();
      const row = t
        .el()
        .querySelector<HTMLElement>(`li[data-problem="${domKey("conflict:lifecycle:n1")}"]`);
      expect(row?.textContent).toContain('Task "Alpha" was deleted and restored at the same time.');
      expect(row?.textContent).toContain("Where: The shared section");
      problem(t, "conflict:lifecycle:n1")?.click();
      expect(t.runs).toEqual([
        {
          id: "review-conflicts",
          request: {
            section: { key: KEY, title: "Launch" },
            problem: { kind: "conflict", key: "lifecycle:n1" },
          },
          surface: "pane",
        },
      ]);
      // The click hides nothing: the row stays until the facts drop it.
      for (const l of t.sections.statusListeners) l();
      expect(problem(t, "conflict:lifecycle:n1")).not.toBeNull();
      t.sections.recovery.set(KEY, []);
      for (const l of t.sections.statusListeners) l();
      expect(problem(t, "conflict:lifecycle:n1")).toBeNull();
    });

    it("L2: a row resolved before the click redraws and runs nothing", async () => {
      const t = await open();
      t.sections.recovery.set(KEY, [CONFLICT]);
      for (const l of t.sections.statusListeners) l();
      const button = problem(t, "conflict:lifecycle:n1");
      // Resolved elsewhere (another device) before the pane redrew.
      t.sections.recovery.set(KEY, []);
      button?.click();
      expect(t.runs).toEqual([]);
      expect(problem(t, "conflict:lifecycle:n1")).toBeNull();
    });

    it("a damaged boundary in the note: its row hands the line key and the revision drawn", async () => {
      const t = await open({ cursor: 0 });
      t.note.buffer = TEXT.replace(`${formatBoundary("end", S)}\n`, "");
      for (const l of t.sections.statusListeners) l();
      const button = t
        .el()
        .querySelector<HTMLButtonElement>(
          `button[data-problem="${domKey(`repair:Plan.md:missing-end:${KEY}:3`)}"]`,
        );
      expect(button?.textContent).toBe("Repair shared sections…");
      // P3-3: the DOM names the row by a hash, never by the note's text or path.
      const attrs = Array.from(t.el().querySelectorAll("[data-problem], [data-pane-key]")).flatMap(
        (e) => [e.getAttribute("data-problem") ?? "", e.getAttribute("data-pane-key") ?? ""],
      );
      expect(attrs.join(" ")).not.toMatch(/Plan\.md|lfcp-section|missing-end/);
      const drawn = t.note.buffer;
      // Typed after the drawing, before the click: the drawn revision goes, the executor reparses.
      t.note.buffer = `${drawn}More text\n`;
      button?.click();
      expect(t.runs).toHaveLength(1);
      expect(t.runs[0]).toMatchObject({
        id: "repair-sections",
        request: {
          problem: {
            kind: "repair",
            path: "Plan.md",
            key: `missing-end:${KEY}`,
            line: 3,
            revision: contentHash(drawn),
          },
        },
      });
    });
  });

  it("L2: a click acts on what was drawn; another note in view now redraws and runs nothing", async () => {
    const t = await open();
    const invite = t.primary();
    // The cursor left the section before the click (no redraw yet): another target.
    t.note.cursorLine = 0;
    invite?.click();
    expect(t.runs).toEqual([]);
    expect(t.primary()?.textContent).toBe("Share section…");
  });

  // LFCP-03-060 (C-5, C-6): a click the facts still allow is not lost to a redraw that has not run.
  it("060: Join with a link… runs although the note in view changed before the redraw", async () => {
    const t = await open();
    const join = t.el().querySelector<HTMLButtonElement>('button[data-action="join-with-link"]');
    expect(join).not.toBeNull();
    // Another note became the target after the drawing, before the coalesced redraw.
    t.note.file = new mock.TFile("Other.md");
    join?.click();
    expect(t.runs.map((r) => r.id)).toEqual(["join-with-link"]);
  });

  it("060: Remove access… runs although only the path of the same section's note changed", async () => {
    const t = await open();
    t.sections.access.set(KEY, { canInvite: true, hosting: "hosted", canRemove: true });
    for (const l of t.sections.statusListeners) l();
    const remove = t.el().querySelector<HTMLButtonElement>('button[data-action="remove-access"]');
    expect(remove).not.toBeNull();
    t.note.file = new mock.TFile("Copy of Plan.md");
    remove?.click();
    expect(t.runs.map((r) => r.id)).toEqual(["remove-access"]);
    expect(t.runs[0]?.request).toMatchObject({ section: { key: KEY } });
  });

  it("060: a card action drawn for section A is not run once the cursor is in section B", async () => {
    const t = await open();
    t.sections.access.set(KEY, { canInvite: true, hosting: "hosted", canRemove: true });
    for (const l of t.sections.statusListeners) l();
    const remove = t.el().querySelector<HTMLButtonElement>('button[data-action="remove-access"]');
    expect(remove).not.toBeNull();
    // A second section below the first; the cursor moves into it before the redraw runs.
    const S2 = parseSectionRef(`lfcp1:${R0}#section:${SID2}`) as SectionRef;
    const key2 = `${R0}#${SID2}`;
    t.note.buffer = [
      TEXT.trimEnd(),
      "## Other",
      formatBoundary("start", S2),
      "- [ ] Beta",
      formatBoundary("end", S2),
      "",
    ].join("\n");
    t.sections.rows.push(rowOf({ sectionId: SID2, key: key2, sharedTitle: "Other" }));
    t.sections.statuses.set(key2, statusView(healthy));
    t.sections.access.set(key2, { canInvite: true, hosting: "hosted", canRemove: true });
    t.note.cursorLine = 8;
    mock.notices.length = 0;
    remove?.click();
    expect(t.runs).toEqual([]);
    expect(mock.notices.join("\n")).toContain("the pane changed");
  });

  it("060: a click the pane drops tells the user, never silently", async () => {
    const t = await open();
    const invite = t.primary();
    mock.notices.length = 0;
    t.note.cursorLine = 0;
    invite?.click();
    expect(t.runs).toEqual([]);
    expect(mock.notices.join("\n")).toContain("the pane changed");
  });

  it("D9: a chosen row is the pane's section when the cursor is in no section; the cursor wins", async () => {
    const t = await open({ cursor: 1 });
    expect(t.el().textContent).not.toContain("Invite collaborator…");
    const row = t.el().querySelector<HTMLButtonElement>(`button[data-row="${KEY}"]`);
    expect(row?.getAttribute("aria-pressed")).toBe("false");
    row?.click();
    expect(t.el().querySelector(`button[data-row="${KEY}"]`)?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(t.primary()?.textContent).toBe("Invite collaborator…");
    t.primary()?.click();
    expect(t.runs.at(-1)).toMatchObject({ id: "invite", request: { section: { key: KEY } } });
  });

  it("D9: the section just joined is the pane's section until another is under the cursor or chosen", async () => {
    const t = await open({ cursor: 1 });
    t.sections.rows.splice(0, 1, rowOf({ placements: [], placementCount: 0, placed: "unplaced" }));
    t.plugin.sectionJoined(fromBase64url(R0) as ResourceId);
    await wait(150);
    expect(t.primary()?.textContent).toBe("Insert into a note…");
    expect(t.el().textContent).toContain("Not inserted yet");
  });

  it("P2, T2: a running flow is pinned; its next step goes back to it, not to the note in view", async () => {
    const t = await open({ note: "Other.md", cursor: 0 });
    t.sections.flows.push({
      generation: 3,
      kind: "share",
      path: "Plan.md",
      stage: "",
      step: "preview",
      outcome: "running",
      checking: false,
    });
    for (const l of t.sections.flowListeners) l();
    expect(t.el().textContent).toContain("For Plan.md");
    // A later flow on the note in view does not take the current area.
    t.sections.flows.push({
      generation: 4,
      kind: "insert",
      path: "Other.md",
      stage: "",
      step: "captured",
      outcome: "running",
      checking: false,
    });
    for (const l of t.sections.flowListeners) l();
    expect(t.el().textContent).toContain("For Plan.md");
    expect(t.el().textContent).toContain("Inserting a shared section");
    t.primary()?.click();
    expect(t.runs.at(-1)).toEqual({ id: "share-section", request: { flow: 3 }, surface: "pane" });
    // The flow ended: a click drawn for it (a late one) runs nothing; the pane holds the other.
    const late = t.primary();
    t.sections.flows.splice(0, 1);
    late?.click();
    expect(t.runs).toHaveLength(1);
    expect(t.el().textContent).toContain("For Other.md");
  });

  it("D12: an unknown result's Check the result names its flow", async () => {
    const t = await open();
    t.sections.flows.push({
      generation: 9,
      kind: "insert",
      path: "Plan.md",
      stage: "",
      step: "writing",
      outcome: "unknown",
      checking: false,
    });
    for (const l of t.sections.flowListeners) l();
    expect(t.primary()?.textContent).toBe("Check the result");
    t.primary()?.click();
    expect(t.runs.at(-1)).toEqual({ id: "check-result", request: { flow: 9 }, surface: "pane" });
  });

  it("L1: while the sidebar is collapsed the pane neither reads nor draws; shown again, it draws once", async () => {
    const t = await open();
    const v = t.view() as SharedTasksView;
    const leaf = t.leaves()[0] as mock.WorkspaceLeaf;
    leaf.root.collapsed = true;
    const before = v.drawings;
    for (const l of t.sections.statusListeners) l();
    t.ws.trigger("editor-change");
    await wait(150);
    expect(v.drawings).toBe(before);
    leaf.root.collapsed = false;
    v.onResize();
    expect(v.drawings).toBe(before + 1);
    v.onResize();
    expect(v.drawings).toBe(before + 1);
  });
});
