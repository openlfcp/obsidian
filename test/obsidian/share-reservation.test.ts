// @vitest-environment happy-dom
// LFCP-03-002 (F-03, U03-09, U03-14): "Share section…" reserved per note
// before any preview or allocation, on the real plugin (mock Obsidian,
// real runtime, SDK and IndexedDB, offline). A repeated start, from the
// palette command or the host entry every other surface calls, opens no
// second preview and allocates nothing: it brings the open preview forward.
// The reservation follows the note across a rename. A share given up after
// its Resource and import were stored (a durable effect) leaves no listed
// collaboration and no "stopped syncing" notice; one whose data may have
// been sent is kept on this device, not deleted, and counted in the
// diagnostics, also after a crash. Each case records the Resources stored,
// the operation IDs committed and the registry.

import { fromBase64url, hash32, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticReport } from "../../src/core/diagnostics";
import { collectDiagnostics } from "../../src/core/diagnostics-collect";
import { parseSections } from "../../src/core/sections/parser";
// The DOM helpers Obsidian adds, local-only sockets, and the mock's gaps for the sections host.
import "../soak/peer";
import { E2EVault, until } from "../support/e2e-vault";

const SERVER = "ws://127.0.0.1:9/v1/ws";
const NOTE = ["# Notes", "", "## Plan", "", "- [ ] Alpha", "- [ ] Beta", "", "## Later", ""].join(
  "\n",
);
type Mock = typeof import("../mocks/obsidian");

/** Sections on, on a local server; the plugin's intervals recorded, to stop with a crashed instance. */
const intervals: number[] = [];
function sectionsOn(m: Mock): void {
  const P = m.Plugin.prototype as unknown as Record<string, unknown>;
  P.loadData = async function (this: { stored: unknown }) {
    return this.stored ?? { sectionsDisabled: false, defaultServer: SERVER, settingsVersion: 2 };
  };
  P.register = () => undefined;
  P.registerInterval = (id: number) => {
    intervals.push(id);
    return id;
  };
  P.registerMarkdownPostProcessor = () => undefined;
  const W = m.Workspace.prototype as unknown as Record<string, unknown>;
  W.on = () => ({});
  W.onLayoutReady = (fn: () => void) => fn();
}
const stopIntervals = () => {
  for (const id of intervals.splice(0)) window.clearInterval(id);
};

const vaults: E2EVault[] = [];
afterEach(async () => {
  for (const v of vaults.splice(0)) await v.close().catch(() => undefined);
  stopIntervals();
  E2EVault.onModules = null;
});

async function open(name: string) {
  E2EVault.onModules = sectionsOn;
  const v = await E2EVault.open(name, { tickMs: 50 });
  vaults.push(v);
  v.network.offline = true;
  if (v.plugin.sections === null) throw new Error("sections off");
  return v;
}

/** What the case records: Resources stored, listed, and the operations committed. */
function record(v: E2EVault) {
  const ops: { resource: string; operationId: string }[] = [];
  const watch = () => {
    const r = v.runtime;
    const commit = r.commitSection.bind(r);
    r.commitSection = async (R, intents, o) => {
      ops.push({ resource: toBase64url(R), operationId: o.operationId });
      return commit(R, intents, o);
    };
  };
  watch();
  return {
    ops,
    watch,
    stored: async () =>
      (await (v.runtime.storage as LfcpStorage).resources.list()).map((x) =>
        toBase64url(x.resourceId),
      ),
    listed: async () => (await v.runtime.registry()).map((e) => toBase64url(e.resourceId)),
  };
}

/** An editor on `path`, cursor on `## Plan`, as the command palette hands one to a command. */
function editorOn(v: E2EVault, path: string) {
  const view = new v.mock.MarkdownView(new v.mock.TFile(path) as never, v.read(path));
  view.cursorLine = v.read(path).split("\n").indexOf("## Plan");
  return view;
}

/** Runs a command as the palette or a hotkey does: with the active editor. */
function runCommand(v: E2EVault, id: string, view: { editor: unknown; file: unknown }): void {
  const command = v.host.commands.find((c) => c.id === id) as
    | { editorCallback?: (editor: unknown, ctx: unknown) => unknown }
    | undefined;
  if (command?.editorCallback === undefined) throw new Error(`no editor command ${id}`);
  command.editorCallback(view.editor, view);
}

const openModals = (v: E2EVault) => v.mock.modals.filter((m) => m.isOpen);
const click = (
  modal: { contentEl: { findAll(t: string): { text: string; click(): void }[] } },
  text: string,
) => {
  const b = modal.contentEl.findAll("button").find((x) => x.text === text);
  if (b === undefined) throw new Error(`no ${text} button`);
  b.click();
};
const noticesSince = (v: E2EVault, n: number) => v.mock.notices.slice(n);
const FRIGHT = /stopped syncing|no longer has|not hosted|RESOURCE_NOT_HOSTED/i;

/** A rename as Obsidian does it: the file moves, then the rename event fires. */
function rename(v: E2EVault, from: string, to: string): void {
  const text = v.read(from);
  v.app.vault.files.delete(from);
  v.app.vault.files.set(to, text);
  v.app.vault.trigger("rename", new v.mock.TFile(to), from);
}

describe("Share reserved per note (LFCP-03-002)", () => {
  it("a second start, from the palette or the host entry, reveals the open preview; one Resource, one operation", async () => {
    const v = await open("A");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const view = editorOn(v, "Plan.md");
    const notices = v.mock.notices.length;

    // The palette (or a hotkey): the preview opens.
    runCommand(v, "share-section", view);
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    const preview = openModals(v)[0] as (typeof v.mock.modals)[number];
    let focused = 0;
    preview.modalEl.focus = () => {
      focused++;
    };
    const opened = v.mock.modals.length;

    // Again from the palette, then from the host entry that the menu, card and
    // pane call: no second dialog, nothing allocated; the open preview is brought forward.
    runCommand(v, "share-section", view);
    await v.plugin.sections?.share(view.editor as never, "Plan.md");
    // And an insert on the same note: the same reservation.
    await v.plugin.sections?.insertSection(view.editor as never, "Plan.md");
    // LFCP-03-010: the one dispatcher, as the pane and the menu call it, and the insert command.
    const sections = v.plugin.sections;
    if (sections === null) throw new Error("sections off");
    const target = sections.capture(view.editor as never, "Plan.md");
    await v.plugin.actions.run("share-section", { target }, "pane");
    await v.plugin.actions.run("insert-into-note", { target }, "menu");
    runCommand(v, "insert-section", view);
    await v.settle();
    expect(v.mock.modals.length).toBe(opened);
    expect(focused).toBe(6);
    expect(rec.ops).toEqual([]);
    expect(await rec.stored()).toEqual([]);
    expect(noticesSince(v, notices)).toEqual([]);

    click(preview, "Share");
    await until("the share finished", () =>
      noticesSince(v, notices).some((n) => n.includes('"Plan"')) ? true : undefined,
    );
    await v.settle();
    const stored = await rec.stored();
    expect(stored).toHaveLength(1);
    expect(await rec.listed()).toEqual(stored);
    expect(new Set(rec.ops.map((o) => o.operationId)).size).toBe(1);
    expect(rec.ops.every((o) => o.resource === stored[0])).toBe(true);
    const bound = parseSections(v.read("Plan.md")).sections;
    expect(bound.map((s) => toBase64url(s.ref.resourceId))).toEqual(stored);
    // Offline: created and bound here, not hosted yet; nothing frightening said.
    expect(noticesSince(v, notices).join(" | ")).toMatch(/created on this device/);
    expect(noticesSince(v, notices).join(" | ")).not.toMatch(FRIGHT);

    // Stale source after the first share: the reservation is free again, and
    // sharing the bound section again makes nothing (its preview refuses).
    const again = editorOn(v, "Plan.md");
    const before = v.mock.modals.length;
    const said = v.mock.notices.length;
    const share = v.plugin.sections?.share(again.editor as never, "Plan.md");
    await until("the second preview", () =>
      v.mock.modals.length > before || v.mock.notices.length > said ? true : undefined,
    );
    for (const m of openModals(v)) {
      const b = m.contentEl.findAll("button").find((x) => x.text === "Share") as
        | { disabled?: boolean }
        | undefined;
      expect(b?.disabled ?? true).toBe(true);
      click(m, "Cancel");
    }
    await share;
    expect(await rec.stored()).toEqual(stored);
    expect(new Set(rec.ops.map((o) => o.operationId)).size).toBe(1);
  }, 60_000);

  it("a rename during the preview keeps the reservation; the share binds the renamed note", async () => {
    const v = await open("B");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const view = editorOn(v, "Plan.md");
    const notices = v.mock.notices.length;
    const flow = v.plugin.sections?.share(view.editor as never, "Plan.md");
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    const preview = openModals(v)[0] as (typeof v.mock.modals)[number];
    let focused = 0;
    preview.modalEl.focus = () => {
      focused++;
    };

    rename(v, "Plan.md", "Renamed.md");
    await v.settle();
    // A start on the new path is the same note: revealed, not a second flow.
    const opened = v.mock.modals.length;
    await v.plugin.sections?.share(editorOn(v, "Renamed.md").editor as never, "Renamed.md");
    expect(v.mock.modals.length).toBe(opened);
    expect(focused).toBe(1);

    click(preview, "Share");
    await flow;
    await v.settle();
    expect(v.read("Plan.md")).toBe("");
    const stored = await rec.stored();
    expect(stored).toHaveLength(1);
    expect(await rec.listed()).toEqual(stored);
    expect(
      parseSections(v.read("Renamed.md")).sections.map((s) => toBase64url(s.ref.resourceId)),
    ).toEqual(stored);
    expect(new Set(rec.ops.map((o) => o.operationId)).size).toBe(1);
    expect(noticesSince(v, notices).join(" | ")).not.toMatch(FRIGHT);
  }, 60_000);

  it("a rename after Share was pressed, before the note is bound: the renamed note is bound", async () => {
    const v = await open("B2");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const r = v.runtime;
    const commit = r.commitSection;
    // The import is stored; the note is renamed before the creation binds it.
    r.commitSection = async (R, intents, o) => {
      const receipt = await commit(R, intents, o);
      rename(v, "Plan.md", "Moved.md");
      return receipt;
    };
    const notices = v.mock.notices.length;
    const flow = v.plugin.sections?.share(editorOn(v, "Plan.md").editor as never, "Plan.md");
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await flow;
    await v.settle();
    const stored = await rec.stored();
    const op = rec.ops[0]?.operationId as string;
    const entry = (await r.localState.get(`section-create:${op}`)) as Record<string, unknown>;
    expect({
      stored: stored.length,
      listed: await rec.listed(),
      ops: new Set(rec.ops.map((o) => o.operationId)).size,
      path: entry.path,
      phase: entry.phase,
      bound: parseSections(v.read("Moved.md")).sections.map((s) => toBase64url(s.ref.resourceId)),
      old: v.app.vault.files.has("Plan.md"),
    }).toEqual({
      stored: 1,
      listed: stored,
      ops: 1,
      path: "Moved.md",
      phase: "projected",
      bound: stored,
      old: false,
    });
    expect(noticesSince(v, notices).join(" | ")).toMatch(/created on this device/);
    expect(noticesSince(v, notices).join(" | ")).not.toMatch(/changed since the preview/);
    expect(noticesSince(v, notices).join(" | ")).not.toMatch(FRIGHT);
  }, 60_000);

  it("a deleted note: the approved share writes nothing and makes no Resource", async () => {
    const v = await open("C");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const flow = v.plugin.sections?.share(editorOn(v, "Plan.md").editor as never, "Plan.md");
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    const notices = v.mock.notices.length;
    v.app.vault.files.delete("Plan.md");
    v.app.vault.trigger("delete", new v.mock.TFile("Plan.md"));
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await flow;
    expect(noticesSince(v, notices)).toEqual([
      "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
    ]);
    expect(await rec.stored()).toEqual([]);
    expect(rec.ops).toEqual([]);
    expect(v.app.vault.files.has("Plan.md")).toBe(false);
  }, 60_000);

  it("given up after a durable effect, maybe sent: kept, not listed, no lost-hosting notice, also after a crash", async () => {
    const v = await open("D");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const r = v.runtime;
    const storage = r.storage as LfcpStorage;
    // After the import is stored, its data is handed to a connection once
    // (maybe sent), and the user edits the section: the binding is stale.
    const commit = r.commitSection;
    r.commitSection = async (R, intents, o) => {
      const receipt = await commit(R, intents, o);
      await storage.commit([
        {
          op: "enqueue",
          item: {
            itemId: hash32(new Uint8Array(32).fill(7)),
            resourceId: R,
            kind: "data-unit",
            bytes: new Uint8Array([1]),
            attempts: 1,
            lastAttempt: new Date().toISOString(),
            nextAttempt: null,
            blocked: null,
          },
        },
      ]);
      v.app.vault.files.set("Plan.md", NOTE.replace("- [ ] Beta", "- [ ] Beta, edited"));
      return receipt;
    };
    const notices = v.mock.notices.length;
    const flow = v.plugin.sections?.share(editorOn(v, "Plan.md").editor as never, "Plan.md");
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await flow;
    await until("the share outcome", () =>
      noticesSince(v, notices).length > 0 ? true : undefined,
    );
    await v.settle();

    const [R] = await rec.stored();
    if (R === undefined) throw new Error("no Resource made");
    const RId = fromBase64url(R) as ResourceId;
    expect(rec.ops).toHaveLength(1);
    const op = rec.ops[0]?.operationId as string;
    const entry = (await r.localState.get(`section-create:${op}`)) as Record<string, unknown>;
    expect({
      stored: await rec.stored(),
      listed: await rec.listed(),
      kept: (await r.keptDiscarded()).map((k) => [toBase64url(k.resourceId), k.sent]),
      phase: entry.phase,
      discarded: entry.discarded,
      keptReason: entry.keptReason,
      open: await r.localState.get("section-creates"),
    }).toEqual({
      stored: [R],
      listed: [],
      kept: [[R, true]],
      phase: "cancelled",
      discarded: "kept",
      keptReason: "RESOURCE_SENT:attempted",
      open: [],
    });
    expect(noticesSince(v, notices)).toEqual([
      'Shared Tasks: section "Plan" changed since the preview. Nothing was bound; share it again.',
    ]);
    expect(v.read("Plan.md")).not.toContain("lfcp-section");
    const report = diagnosticReport(
      await collectDiagnostics({
        runtime: r,
        collab: null,
        sections: null,
        events: [],
        plugin: "0.0.0",
        obsidian: "1.13.4",
        platform: "linux",
        needsRestart: false,
      }),
      false,
    );
    expect(report).toContain("Collaborations: 0");
    expect(report).toContain("Given-up shares kept on this device: 1");
    expect(report).not.toContain(R);
    expect(report).not.toContain(toHex(RId));

    // A crash and a new start: still kept (never deleted automatically), still
    // not listed or opened, nothing announced about it.
    await v.shutdown("crash");
    stopIntervals();
    await v.boot();
    v.network.offline = true;
    const after = v.mock.notices.length;
    const r2 = v.runtime;
    await v.settle();
    expect(
      (await (r2.storage as LfcpStorage).resources.list()).map((x) => toBase64url(x.resourceId)),
    ).toEqual([R]);
    expect(await r2.registry()).toEqual([]);
    expect((await r2.keptDiscarded()).map((k) => [toBase64url(k.resourceId), k.sent])).toEqual([
      [R, true],
    ]);
    await expect(r2.openSection(RId)).rejects.toThrow("unknown Resource");
    expect(noticesSince(v, after).join(" | ")).not.toMatch(FRIGHT);

    // Sharing the section again works: one new Resource, listed; the kept one stays apart.
    const rec2 = record(v);
    const notices2 = v.mock.notices.length;
    const again = v.plugin.sections?.share(editorOn(v, "Plan.md").editor as never, "Plan.md");
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await again;
    await until("the second share", () =>
      noticesSince(v, notices2).length > 0 ? true : undefined,
    );
    await v.settle();
    const listed = await rec2.listed();
    expect(listed).toHaveLength(1);
    expect(listed).not.toContain(R);
    expect((await rec2.stored()).sort()).toEqual([R, ...listed].sort());
    expect(new Set(rec2.ops.map((o) => o.operationId)).size).toBe(1);
    expect(noticesSince(v, notices2).join(" | ")).not.toMatch(FRIGHT);
  }, 60_000);

  it("a crash after the import was stored, its answer lost: the next start resumes the same Resource and operation", async () => {
    const v = await open("E");
    const rec = record(v);
    await v.write("Plan.md", NOTE);
    const r = v.runtime;
    const commit = r.commitSection;
    let committed = false;
    // The import commits (durable), then the process dies before the answer.
    r.commitSection = async (R, intents, o) => {
      await commit(R, intents, o);
      committed = true;
      return new Promise(() => undefined);
    };
    const flow = v.plugin.sections?.share(editorOn(v, "Plan.md").editor as never, "Plan.md");
    void flow;
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await until("the import committed", () => (committed ? true : undefined));
    const [R] = await rec.stored();
    const op = rec.ops[0]?.operationId as string;
    expect(rec.ops).toHaveLength(1);
    expect(await r.localState.get("section-creates")).toEqual([op]);

    await v.shutdown("crash");
    stopIntervals();
    await v.boot();
    v.network.offline = true;
    const notices = v.mock.notices.length;
    rec.watch();
    await until("the creation resumed", () =>
      noticesSince(v, notices).some((n) => n.includes('"Plan"')) ? true : undefined,
    );
    await v.settle();
    const r2 = v.runtime;
    const entry = (await r2.localState.get(`section-create:${op}`)) as Record<string, unknown>;
    expect({
      stored: await rec.stored(),
      listed: await rec.listed(),
      ops: [...new Set(rec.ops.map((o) => o.operationId))],
      phase: entry.phase,
      bound: parseSections(v.read("Plan.md")).sections.map((s) => toBase64url(s.ref.resourceId)),
    }).toEqual({ stored: [R], listed: [R], ops: [op], phase: "projected", bound: [R] });
    expect(noticesSince(v, notices).join(" | ")).not.toMatch(FRIGHT);
  }, 60_000);
});
