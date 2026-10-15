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

  it("only Keep my version when it cannot, and says why", () => {
    const { el, labels } = buttons({ key: "k", title: "Launch", lines, sharedUnavailable: true });
    expect(labels).toEqual(["Keep my version"]);
    expect(el.textContent).toContain("The shared version cannot be shown here yet.");
  });
});
