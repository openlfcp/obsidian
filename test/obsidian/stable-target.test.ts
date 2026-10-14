// @vitest-environment happy-dom
// LFCP-03-009 (F-06, F-07; U03-03, U03-04) on the real plugin (mock
// Obsidian, real runtime, SDK and IndexedDB, offline): "Share section…"
// from the palette binds its target when it starts. The tab switched to
// another note while the preview is open does not move the flow (F-06: it
// said "the section's heading is gone"); an exact selection is shared as
// selected, and the private text after it never reaches the runtime's
// commit (before encryption); an ineligible selection asks before the whole
// section is previewed.

import { toBase64url } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseSections } from "../../src/core/sections/parser";
// The DOM helpers Obsidian adds, local-only sockets, and the mock's gaps for the sections host.
import "../soak/peer";
import { E2EVault, until } from "../support/e2e-vault";

const SERVER = "ws://127.0.0.1:9/v1/ws";
const TAIL = "PRIVATE_TAIL_c0ffee: stays on this device.";
const NOTE = [
  "# Notes", //        0
  "", //               1
  "## Plan", //        2
  "", //               3
  "- [ ] Alpha", //    4
  "- [ ] Beta", //     5
  "", //               6
  TAIL, //             7
  "", //               8
  "## Later", //       9
  "",
].join("\n");
const OTHER = "## Other\n- [ ] Elsewhere\n";
type Mock = typeof import("../mocks/obsidian");

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

const vaults: E2EVault[] = [];
afterEach(async () => {
  for (const v of vaults.splice(0)) await v.close().catch(() => undefined);
  for (const id of intervals.splice(0)) window.clearInterval(id);
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

/** The intents the runtime is asked to commit (and then encrypts), as JSON. */
function committed(v: E2EVault): { readonly text: () => string } {
  const seen: unknown[] = [];
  const r = v.runtime;
  const commit = r.commitSection.bind(r);
  r.commitSection = async (R, intents, o) => {
    seen.push(intents);
    return commit(R, intents, o);
  };
  return { text: () => JSON.stringify(seen) };
}

/** A tab on `path`, as the palette hands its editor to a command. */
function tabOn(v: E2EVault, path: string, line: number) {
  const view = new v.mock.MarkdownView(new v.mock.TFile(path) as never, v.read(path));
  view.cursorLine = line;
  return view;
}

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
const modalText = (m: { contentEl: unknown }) =>
  (m.contentEl as { textContent?: string }).textContent ?? "";
const bound = (v: E2EVault, path: string) =>
  parseSections(v.read(path)).sections.map((s) => toBase64url(s.ref.resourceId));

describe("a share keeps its captured target (LFCP-03-009)", () => {
  it("F-06/U03-03: the tab switched to another note while the preview is open; Share binds the first note", async () => {
    const v = await open("T1");
    await v.write("Plan.md", NOTE);
    await v.write("Other.md", OTHER);
    const tab = tabOn(v, "Plan.md", 4);
    const notices = v.mock.notices.length;
    runCommand(v, "share-section", tab);
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    // The same tab now shows Other.md: its editor reads another note.
    tab.file = new v.mock.TFile("Other.md") as never;
    tab.buffer = OTHER;
    click(openModals(v)[0] as (typeof v.mock.modals)[number], "Share");
    await until("the share finished", () =>
      v.mock.notices.slice(notices).some((n) => n.includes('"Plan"')) ? true : undefined,
    );
    await v.settle();
    const said = v.mock.notices.slice(notices).join(" | ");
    expect(said).not.toMatch(/heading is gone|Nothing was shared/);
    expect(bound(v, "Plan.md")).toHaveLength(1);
    expect(v.read("Other.md")).toBe(OTHER);
  }, 60_000);

  it("U03-04: an exact selection is shared as selected; the private text after it is not committed", async () => {
    const v = await open("T2");
    await v.write("Plan.md", NOTE);
    const seen = committed(v);
    const tab = tabOn(v, "Plan.md", 2);
    // From the heading to column 0 of the blank line after Beta: lines 2-5.
    tab.selection = { from: { line: 2, ch: 0 }, to: { line: 6, ch: 0 } };
    const notices = v.mock.notices.length;
    runCommand(v, "share-section", tab);
    await until("the share preview", () => (openModals(v).length === 1 ? true : undefined));
    const preview = openModals(v)[0] as (typeof v.mock.modals)[number];
    // The tail is shown as staying private, never as part of what is shared.
    const shown = modalText(preview);
    expect(shown.slice(0, shown.indexOf("Stays private"))).not.toContain("PRIVATE_TAIL");
    expect(shown).toContain("Stays private on this device:");
    click(preview, "Share");
    await until("the share finished", () =>
      v.mock.notices.slice(notices).some((n) => n.includes('"Plan"')) ? true : undefined,
    );
    await v.settle();
    expect(seen.text()).toContain("Alpha");
    expect(seen.text()).toContain("Beta");
    expect(seen.text()).not.toContain("PRIVATE_TAIL");
    const text = v.read("Plan.md");
    const [section] = parseSections(text).sections;
    expect(section?.heading.title).toBe("Plan");
    // The end marker sits before the private text.
    expect(text.indexOf("/lfcp-section")).toBeLessThan(text.indexOf(TAIL));
  }, 60_000);

  it("U03-04: an ineligible selection asks first; Cancel shares nothing", async () => {
    const v = await open("T3");
    await v.write("Plan.md", NOTE);
    const seen = committed(v);
    const tab = tabOn(v, "Plan.md", 4);
    tab.selection = { from: { line: 4, ch: 0 }, to: { line: 5, ch: 10 } };
    runCommand(v, "share-section", tab);
    await until("the question", () => (openModals(v).length === 1 ? true : undefined));
    const ask = openModals(v)[0] as (typeof v.mock.modals)[number];
    expect(modalText(ask)).toContain(
      "A shared section starts at its heading. Your selection does not.",
    );
    click(ask, "Cancel");
    await v.settle();
    expect(openModals(v)).toEqual([]);
    expect(seen.text()).toBe("[]");
    expect(v.read("Plan.md")).toBe(NOTE);
  }, 60_000);
});
