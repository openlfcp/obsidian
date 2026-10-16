// The repair dialog's lost-base choices (LFCP-03-043 review): a section
// whose shared version cannot be written here yet offers only "Share my
// version" ("Keep my version" on main); one that can offers both.

import { describe, expect, it } from "vitest";
import { type LostBase, type RepairActions, RepairModal } from "../../src/obsidian/ui/repair";
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
    expect(labels).toEqual(["Share my version", "Use the shared version"]);
  });

  it("a Task still loading, no shared block: Share mine only, with no base guessed", () => {
    const { el, labels } = buttons({
      key: "k",
      title: "Launch",
      lines,
      sharedUnavailable: true,
      taskWait: "task-loading",
    });
    expect(labels).toEqual(["Share my version"]);
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
    expect(labels).toEqual(["Share my version", "Use the shared version"]);
    expect(el.textContent).toContain("− only in this note · + only in the shared version");
    expect(el.textContent).not.toContain("This note's version.");
    expect(el.textContent).toContain("once the shared version is fixed");
    expect(el.textContent).not.toContain("loaded");
    expect(el.textContent).not.toContain("Export diagnostics");
    expect(el.textContent).not.toMatch(/collaboration/i);
  });

  it("a Task deleted in the shared version: both choices, and what each does", () => {
    const { el, labels } = buttons({ key: "k", title: "Launch", lines, taskWait: "task-deleted" });
    expect(labels).toEqual(["Share my version", "Use the shared version"]);
    expect(el.textContent).toContain("deleted in the shared version");
    expect(el.textContent).toContain("keeps this text as a recovery copy");
    expect(el.textContent).not.toContain("fixed");
  });

  it("a model that cannot be drawn: Share my version keeps this note's version as the base", () => {
    const { el, labels } = buttons({ key: "k", title: "Launch", lines, sharedUnavailable: true });
    expect(labels).toEqual(["Share my version"]);
    expect(el.textContent).toContain("as this copy's base");
  });
});
