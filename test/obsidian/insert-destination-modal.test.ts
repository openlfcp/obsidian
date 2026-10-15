// LFCP-03-016: the destination choice of "Insert into a note…" and the
// insert preview's place, on the Obsidian mock: this note, any other note
// (marked when it already holds the section), a new note only where no file
// is, and the existing placements named.

import { describe, expect, it } from "vitest";
import {
  ChooseDestinationModal,
  InsertSectionModal,
  newNotePath,
  placementsText,
} from "../../src/obsidian/ui/insert-section";
import { App, type FakeElement } from "../mocks/obsidian";

function app(): App {
  const a = new App();
  const files = (a.vault as unknown as { files: Map<string, string> }).files;
  files.set("Week.md", "# Week\n");
  files.set("Projects/Plan.md", "# Plan\n");
  files.set("Archive.md", "# Archive\n");
  return a;
}

const labels = (m: ChooseDestinationModal, q: string) =>
  (m.getSuggestions(q) as { label: string }[]).map((s) => s.label);

describe("the destination choice", () => {
  it("offers this note first, the other notes at their end, and marks those with the section", () => {
    const m = new ChooseDestinationModal(app() as never, {
      title: "Launch",
      current: "Week.md",
      placements: ["Projects/Plan.md"],
    });
    expect(labels(m, "")).toEqual([
      'This note, "Week": after the paragraph at the cursor',
      "Projects/Plan.md: at its end · already has this section",
      "Archive.md: at its end",
    ]);
  });

  it("offers a new note only for a free, usable name", () => {
    const m = new ChooseDestinationModal(app() as never, {
      title: "Launch",
      current: null,
      placements: [],
    });
    expect(labels(m, "Sprint notes")).toEqual(['Create note "Sprint notes"']);
    expect(labels(m, "archive")).toEqual(["Archive.md: at its end"]);
    expect(labels(m, "Archive")).toEqual(["Archive.md: at its end"]);
    expect(newNotePath("Archive.md")).toBe("Archive.md");
    expect(newNotePath(" a/b ")).toBe("a/b.md");
    expect(newNotePath("bad:name")).toBeNull();
    expect(newNotePath("   ")).toBeNull();
  });

  it("names the existing placements, or that they are still being looked for", () => {
    expect(placementsText(null)).toBe("Looking for copies in your notes…");
    expect(placementsText([])).toBe("Not inserted in any note yet.");
    expect(placementsText(["Projects/Plan.md", "Week.md"])).toBe(
      "Already in: Plan, Week. Inserting adds another copy.",
    );
  });

  it("the insert preview says where the lines go and redraws after another choice", async () => {
    let where = "into this note after the paragraph at the cursor";
    const m = new InsertSectionModal(
      app() as never,
      {
        resource: "R",
        sectionId: "s",
        title: "Launch",
        block: "## Launch\n",
        readOnly: false,
        revision: "r",
      },
      {
        get where() {
          return where;
        },
        placements: ["Week.md"],
        change: async () => {
          where = 'at the end of "Archive"';
        },
      },
    );
    m.open();
    const el = m.contentEl as unknown as FakeElement;
    const text = () => el.children.map((c) => c.text).join("\n");
    expect(text()).toContain("These lines go into this note after the paragraph at the cursor.");
    expect(text()).toContain("Already in: Week. Inserting adds another copy.");
    const change = el.findAll("button").find((b) => b.text === "Choose another note…");
    change?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(text()).toContain('These lines go at the end of "Archive".');
    m.close();
    expect(await m.result).toBe(false);
  });
});
