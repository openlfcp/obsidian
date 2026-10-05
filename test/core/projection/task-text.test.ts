import { describe, expect, it } from "vitest";
import {
  glyphOfStatus,
  parseTaskText,
  statusOfGlyph,
} from "../../../src/core/projection/task-text";

describe("parseTaskText (LFCP-061)", () => {
  it("reads the Obsidian Tasks suffix in any order, with or without variation selectors", () => {
    expect(parseTaskText("Ship it 📅️ 2026-10-10 🔺️ ⏳ 2026-10-09 ^ship-1  ")).toMatchObject({
      title: "Ship it",
      due: "2026-10-10",
      scheduled: "2026-10-09",
      priority: "highest",
      blockId: "ship-1",
      completion: null,
      recurrence: null,
      ambiguous: [],
    });
    expect(parseTaskText("Adjacent📅 2026-10-10").title).toBe("Adjacent");
  });

  it("keeps trailing tags in the title and recognizes metadata before them", () => {
    expect(parseTaskText("Fix login 📅 2026-10-10 #backend #urgent")).toMatchObject({
      title: "Fix login #backend #urgent",
      due: "2026-10-10",
    });
    expect(parseTaskText("#solo").title).toBe("#solo");
  });

  it("does not take a mid-title date or emoji as metadata", () => {
    const t = parseTaskText("Release 📅 2026-10-10 notes");
    expect(t).toMatchObject({ title: "Release 📅 2026-10-10 notes", due: null });
  });

  it("flags wikilinks, recurrence and duplicated fields", () => {
    expect(parseTaskText("See [[Private note]]").wikilinks).toBe(true);
    expect(parseTaskText("Water plants 🔁 every week").recurrence).toBe("every week");
    expect(parseTaskText("X 📅 2026-10-10 📅 2026-10-11")).toMatchObject({
      due: null,
      ambiguous: ["due"],
    });
    expect(parseTaskText("X 📅 2026-10-10 📅 2026-10-10")).toMatchObject({
      due: "2026-10-10",
      ambiguous: [],
    });
    expect(parseTaskText("X 🔺 🔽")).toMatchObject({
      priority: "unowned",
      ambiguous: ["priority"],
    });
  });

  it("maps exactly the ST-1 glyphs both ways", () => {
    expect([" ", "x", "X", "/", "-"].map(statusOfGlyph)).toEqual([
      "todo",
      "done",
      "done",
      "in_progress",
      "cancelled",
    ]);
    for (const g of [">", "<", "?", "!", "*", "i"]) expect(statusOfGlyph(g)).toBeNull();
    expect(
      ["todo", "done", "in_progress", "cancelled", "x/com.example/blocked"].map((s) =>
        glyphOfStatus(s as never),
      ),
    ).toEqual([" ", "x", "/", "-", null]);
  });
});
