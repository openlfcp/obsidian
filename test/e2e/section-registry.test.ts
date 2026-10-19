// @vitest-environment happy-dom
// U03-02 on the real plugin (LFCP-03-011): the registry view of SectionsHost
// over the real runtime, offline. Two sections created on this device with
// the same title stay two rows; each is placed in its note once the start
// indexed every note. Detach leaves a section listed and "not inserted yet";
// a rename moves the placement, a delete drops it. Reading the view opens no
// session. (An index rebuild is covered on the core: this harness restarts
// a plugin with sections off.)

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RegistrySnapshot } from "../../src/core/sections/registry-view";
import * as mock from "../mocks/obsidian";
import { answer, click, SoakPeer } from "../soak/peer";
import { until } from "../support/e2e-vault";

let A: SoakPeer;

const sections = () => {
  const s = A.vault.plugin.sections;
  if (s === null) throw new Error("no sections host");
  return s;
};
const snap = (): RegistrySnapshot => sections().registry.snapshot();
const settled = (want: (s: RegistrySnapshot) => boolean, what: string) =>
  until(what, () => (want(snap()) ? true : undefined), 20_000);

/** "Share section…" of a note's section; offline, it is created on this device. */
async function share(path: string, title: string): Promise<void> {
  const md = ["# Note", "", `## ${title}`, "", "- [ ] a task", "", "## After", ""].join("\n");
  await A.vault.write(path, md);
  const view = new mock.MarkdownView({ path } as never, md);
  view.cursorLine = 4;
  const before = mock.notices.length;
  const done = sections().share(view.editor as never, path);
  await answer("the share preview", click("Share"));
  await done;
  await until(
    "the section created",
    () => (mock.notices.length > before ? true : undefined),
    30_000,
  );
  expect(mock.notices.slice(before).join(" | ")).toMatch(/created on this device|is shared/);
  await A.vault.settle();
}

beforeAll(async () => {
  // Nothing listens there, and the network is off: no server is used.
  A = await SoakPeer.open("A", "a", "ws://127.0.0.1:9/v1/ws", 1);
  A.vault.network.offline = true;
}, 60_000);

afterAll(async () => {
  await A?.vault.close();
});

describe("U03-02: the registry view on the real plugin", () => {
  it("empty once the start read the registry and every note", async () => {
    await settled((s) => s.status === "ready" && s.placementIndex === "complete", "ready");
    expect(snap()).toMatchObject({ sections: 0, unplaced: 0, rows: [] });
  });

  it("two sections with the same title stay two rows, each placed in its note", async () => {
    await share("One.md", "Work");
    await share("Two.md", "Work");
    await settled(
      (s) => s.sections === 2 && s.rows.every((r) => r.sharedTitle === "Work"),
      "two rows",
    );
    const rows = snap().rows;
    expect(new Set(rows.map((r) => r.resource)).size).toBe(2);
    expect(rows.map((r) => r.placements.map((p) => p.path)).sort()).toEqual([
      ["One.md"],
      ["Two.md"],
    ]);
    expect(rows.every((r) => r.placed === "placed" && r.placementCount === 1)).toBe(true);
    // Created here, so watched: a status, whatever it says offline.
    await settled((s) => s.rows.every((r) => r.status.state !== null), "statuses");
    // Waited for, not read once: a snapshot built before the section was watched says it is not.
    await settled((s) => s.rows.every((r) => r.status.watched), "watched");
    expect(snap().unplaced).toBe(0);
  });

  it("detach: the section stays listed, not inserted anywhere", async () => {
    const md = A.vault.read("One.md");
    const view = new mock.MarkdownView({ path: "One.md" } as never, md);
    view.cursorLine = md.split("\n").findIndex((l) => l.includes("a task"));
    const done = sections().detachSectionAt(view.editor as never, "One.md");
    await answer("the detach confirmation", click("Detach"));
    await done;
    await A.vault.settle();
    await settled((s) => s.unplaced === 1, "one unplaced");
    const one = snap().rows.find((r) => r.placed === "unplaced");
    expect(one).toMatchObject({ sharedTitle: "Work", placementCount: 0, placements: [] });
    expect(sections().registry.inNote("One.md")).toEqual([]);
  });

  it("rename moves a placement; delete drops it", async () => {
    const text = A.vault.read("Two.md");
    A.vault.app.vault.files.delete("Two.md");
    A.vault.app.vault.files.set("Dir/Two.md", text);
    A.vault.app.vault.trigger("rename", { path: "Dir/Two.md" }, "Two.md");
    await A.vault.settle();
    await settled((s) => s.rows.some((r) => r.placements[0]?.path === "Dir/Two.md"), "renamed");
    expect(sections().registry.inNote("Two.md")).toEqual([]);
    expect(sections().registry.inNote("Dir/Two.md").length).toBe(1);
    A.vault.app.vault.files.delete("Dir/Two.md");
    A.vault.app.vault.trigger("delete", { path: "Dir/Two.md" });
    await A.vault.settle();
    await settled((s) => s.unplaced === 2, "both unplaced");
    expect(snap().sections).toBe(2);
  });

  it("reading the view opens no model and no session", async () => {
    const runtime = A.runtime;
    const opened = vi.spyOn(runtime, "openSection");
    const reopened = vi.spyOn(runtime, "reopenSection");
    const before = runtime.sessions;
    try {
      for (let i = 0; i < 5; i++) {
        sections().registryChanged();
        await sections().registry.refresh();
        sections().registry.update();
        snap();
      }
      // The view read the registry and the open models each time, nothing more.
      expect(snap().sections).toBe(2);
      expect(opened).not.toHaveBeenCalled();
      expect(reopened).not.toHaveBeenCalled();
      expect(runtime.sessions).toBe(before);
    } finally {
      opened.mockRestore();
      reopened.mockRestore();
    }
  });
});
