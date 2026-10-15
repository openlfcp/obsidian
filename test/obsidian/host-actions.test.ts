// @vitest-environment happy-dom
// LFCP-03-013: the actions that end in Obsidian, on the real plugin and the
// recording Obsidian mock, through the one dispatcher: "Open for editing"
// takes the captured note out of Reading view (and writes nothing), "Open
// settings" opens the plugin's tab, "Copy readable text" copies the
// selection or the section without its metadata, from the pane as from
// the palette. Each acts on the note the surface captured, by its path.

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { TargetCapture } from "../../src/core/sections/target";
import OpenLfcpPlugin from "../../src/main";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };
const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const TEXT = [
  "# Plan",
  "Private text.",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "",
].join("\n");

const capture = (over: Partial<TargetCapture> = {}): TargetCapture => ({
  path: "Plan.md",
  text: TEXT,
  mode: "source",
  cursorLine: 4,
  selections: [],
  composing: false,
  ...over,
});

async function loaded() {
  const app = new mock.App();
  const plugin = new OpenLfcpPlugin(app as never, manifest as never);
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  return { app, plugin };
}

afterEach(() => {
  vi.restoreAllMocks();
  mock.notices.length = 0;
});

describe("actions that end in Obsidian (LFCP-03-013)", () => {
  it("T4: Open for editing takes that note out of Reading view, not another one", async () => {
    const t = await loaded();
    const other = new mock.MarkdownView(new mock.TFile("Other.md"), "x");
    other.mode = "preview";
    const plan = new mock.MarkdownView(new mock.TFile("Plan.md"), TEXT);
    plan.mode = "preview";
    t.app.workspace.views.push(other, plan);
    await t.plugin.actions.run(
      "open-for-editing",
      { target: capture({ mode: "reading" }) },
      "pane",
    );
    expect(plan.mode).toBe("source");
    expect(other.mode).toBe("preview");
    expect(plan.buffer).toBe(TEXT);
    expect(t.app.workspace.activated).toEqual([plan]);
  });

  it("Open settings opens the plugin's own tab", async () => {
    const t = await loaded();
    await t.plugin.actions.run("open-settings", {}, "pane");
    expect(t.app.setting.opened).toEqual(["(settings)", "shared-tasks"]);
    // Obsidian without its (untyped) settings API: said, never a TypeError.
    (t.app as unknown as { setting: unknown }).setting = undefined;
    await t.plugin.actions.run("open-settings", {}, "pane");
    expect(mock.notices.at(-1)).toBe(
      "Shared Tasks: open Settings, then Shared Tasks, to change its settings.",
    );
  });

  it("Copy readable text from the pane copies the section without its metadata; the palette's is the same", async () => {
    const t = await loaded();
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (s) => {
      written.push(s);
    });
    await t.plugin.actions.run("copy-readable", { target: capture() }, "pane");
    expect(written).toEqual(["## Launch\n- [ ] Alpha\n"]);
    expect(mock.notices.at(-1)).toBe("Shared Tasks: copied without sharing metadata.");
    // Private text with no selection: nothing copied, said so.
    await t.plugin.actions.run("copy-readable", { target: capture({ cursorLine: 1 }) }, "pane");
    expect(written).toHaveLength(1);
    expect(mock.notices.at(-1)).toBe(
      "Shared Tasks: select text, or put the cursor in a shared section.",
    );
  });
});
