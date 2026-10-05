import { describe, expect, it } from "vitest";
import {
  glyphOfStatus,
  parseTaskText,
  segmentTaskText,
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

  it("takes the trailing run of Obsidian tags as tags, not title (ruling a)", () => {
    expect(parseTaskText("Fix login 📅 2026-10-10 #backend #urgent")).toMatchObject({
      title: "Fix login",
      tags: ["backend", "urgent"],
      due: "2026-10-10",
    });
    expect(parseTaskText("Fix login #backend 📅 2026-10-10")).toMatchObject({
      title: "Fix login",
      tags: ["backend"],
    });
    expect(parseTaskText("Fix #login flow")).toMatchObject({ title: "Fix #login flow", tags: [] });
    expect(parseTaskText("Close issue #123")).toMatchObject({
      title: "Close issue #123",
      tags: [],
    });
    expect(parseTaskText("Ship #v2/beta #ä_b-c")).toMatchObject({
      title: "Ship",
      tags: ["v2/beta", "ä_b-c"],
    });
    expect(parseTaskText("#solo").title).toBe("#solo");
  });

  it("keeps every segment's exact text", () => {
    const text = "Do it  #a 🔼  📅\uFE0F 2026-10-10 🛫 2026-10-01 ^blk  ";
    const s = segmentTaskText(text);
    expect(s.description + s.segments.map((x) => x.raw).join("") + s.trailing).toBe(text);
    expect(s.segments.map((x) => x.kind)).toEqual(["tag", "priority", "date", "date", "block"]);
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
