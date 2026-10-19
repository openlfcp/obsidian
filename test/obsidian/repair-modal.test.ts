// The repair dialog's lost-base choices (LFCP-03-043 review): a section
// whose shared version cannot be written here yet offers only "Keep my
// version"; one that can offers both.

import { describe, expect, it } from "vitest";
import type { LostBase, RepairActions } from "../../src/core/sections/action-ports";
import { RepairModal } from "../../src/obsidian/ui/repair";
import { App, type FakeElement } from "../mocks/obsidian";

function buttons(lost: LostBase) {
  const chosen: string[] = [];
  const actions: RepairActions = {
    boundary: async () => undefined,
    locate: () => undefined,
    shareMine: async (key) => {
      chosen.push(`mine ${key}`);
    },
    useShared: async (key) => {
      chosen.push(`shared ${key}`);
    },
    putBack: async (key) => {
      chosen.push(`back ${key}`);
    },
  };
  const m = new RepairModal(new App() as never, [], [lost], actions);
  m.onOpen();
  const el = m.contentEl as unknown as FakeElement;
  return { el, labels: el.findAll("button").map((b) => b.textContent), chosen };
}

describe("repair dialog, a section without a base", () => {
  const lines = [{ kind: "local" as const, text: "- [ ] Local edit" }];

  it("both choices when the shared version can be written", () => {
    const { labels } = buttons({ key: "k", title: "Launch", lines });
    expect(labels).toEqual(["Keep my version", "Use the shared version"]);
  });

  it("a Task still loading, no shared block: Keep only, with no base guessed", () => {
    const { el, labels } = buttons({
      key: "k",
      title: "Launch",
      lines,
      sharedUnavailable: true,
      taskWait: "task-loading",
    });
    expect(labels).toEqual(["Keep my version"]);
    expect(el.textContent).toContain("This note's version.");
    expect(el.textContent).toContain("the section asks again once it has loaded");
  });

  it("a Task that is not a valid task, the shared block drawn: both choices, the diff legend, no promise of loading", () => {
    const { el, labels } = buttons({
      key: "k",
      title: "Launch",
      lines,
      taskWait: "task-unreadable",
    });
    expect(labels).toEqual(["Keep my version", "Use the shared version"]);
    expect(el.textContent).toContain("− only in this note · + only in the shared version");
    expect(el.textContent).not.toContain("This note's version.");
    expect(el.textContent).toContain("once the shared version is fixed");
    expect(el.textContent).not.toContain("loaded");
    expect(el.textContent).not.toContain("Export diagnostics");
    expect(el.textContent).not.toMatch(/collaboration/i);
  });

  it("a Task deleted in the shared version: both choices, and what each does", () => {
    const { el, labels } = buttons({ key: "k", title: "Launch", lines, taskWait: "task-deleted" });
    expect(labels).toEqual(["Keep my version", "Use the shared version"]);
    expect(el.textContent).toContain("deleted in the shared version");
    expect(el.textContent).toContain("keeps this text as a recovery copy");
    expect(el.textContent).not.toContain("fixed");
  });

  it("a model that cannot be drawn: Keep keeps this note's version as the base", () => {
    const { el, labels } = buttons({ key: "k", title: "Launch", lines, sharedUnavailable: true });
    expect(labels).toEqual(["Keep my version"]);
    expect(el.textContent).toContain("as this copy's base");
  });
});

describe("repair dialog, lines missing from a note with a base (LFCP-03-057)", () => {
  it("lists the lines and offers one choice: put them back, never Keep my version", () => {
    const { el, labels, chosen } = buttons({
      key: "k",
      title: "Launch",
      lines: [{ kind: "shared", text: "- [ ] Delta" }],
      missing: true,
    });
    expect(labels).toEqual(["Put the missing lines back"]);
    expect(el.textContent).toContain("a line is missing from this note");
    expect(el.textContent).toContain("Nothing was deleted for anyone else");
    expect(el.textContent).toContain("+ - [ ] Delta");
    expect(el.textContent).not.toContain("Nothing in this note needs repair");
    el.findAll("button")[0]?.click();
    expect(chosen).toEqual(["back k"]);
  });
});

describe("repair dialog, a boundary choice (LFCP-03-070)", () => {
  it("puts Apply in its own button row after the choices, not inline in one", () => {
    const actions = {} as RepairActions;
    const item = {
      kind: "missing-end" as const,
      line: 5,
      ref: {} as never,
      candidates: [{ afterLine: 14, preview: "<!-- lfcp-ref: x -->" }],
    };
    const m = new RepairModal(new App() as never, [item], [], actions);
    m.onOpen();
    const box = (m.contentEl as unknown as FakeElement).children.find(
      (c) => c.cls === "openlfcp-repair-item",
    ) as FakeElement;
    const kids = box.children;
    const row = kids[kids.length - 1] as FakeElement;
    expect(row.cls).toBe("modal-button-container");
    expect(row.children.map((b) => b.text)).toEqual(["Apply"]);
    expect(box.findAll("label")).toHaveLength(1);
    expect(box.findAll("label")[0]?.findAll("button")).toEqual([]);
  });
});
