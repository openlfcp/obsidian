// The placement index (LFCP-03-011): which notes hold a copy of each section
// Resource, how completeness is tracked over a (re)build, and how rename,
// delete and a note that loses its copy (detach, whole projection removed)
// update it.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import { noteSections, PlacementIndex } from "../../../src/core/sections/placement-index";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const S = parseSectionRef(`lfcp1:${R}#section:019a2f85-7b31-7c42-b85a-fc843e2f4001`) as SectionRef;
const HEX = [...S.resourceId].map((b) => b.toString(16).padStart(2, "0")).join("");
const copy = ["## Launch", formatBoundary("start", S), "- a", formatBoundary("end", S)];
const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("placement index", () => {
  it("is unknown before a build, building during it, complete after", () => {
    const p = new PlacementIndex();
    let changes = 0;
    p.onChange(() => changes++);
    expect(p.state).toBe("unknown");
    p.begin();
    expect(p.state).toBe("building");
    p.index("A.md", { copies: ["r1"], damaged: [] });
    p.end();
    expect(p.state).toBe("complete");
    expect(p.failure).toBeNull();
    expect(changes).toBe(3);
  });

  it("a build that stops leaves completeness unknown, with why", () => {
    const p = new PlacementIndex();
    p.begin();
    p.end("the notes were not all read");
    expect([p.state, p.failure]).toEqual(["unknown", "the notes were not all read"]);
    // An end without a build changes nothing.
    p.end();
    expect(p.state).toBe("unknown");
  });

  it("counts copies per note, valid and damaged apart; only valid ones are passed", () => {
    const p = new PlacementIndex();
    p.index("B.md", { copies: ["r1", "r1"], damaged: [] });
    p.index("A.md", { copies: [], damaged: ["r1"] });
    expect(p.placements("r1")).toEqual([
      { path: "A.md", copies: 0, damaged: 1 },
      { path: "B.md", copies: 2, damaged: 0 },
    ]);
    expect(p.notesWith("r1")).toEqual(["B.md"]);
    expect(p.has("A.md")).toBe(true);
    expect([...p.resources()]).toEqual(["r1"]);
  });

  it("rename moves a note's copies; delete and an emptied note drop them", () => {
    const p = new PlacementIndex();
    let changes = 0;
    p.onChange(() => changes++);
    p.index("A.md", { copies: ["r1"], damaged: [] });
    p.index("A.md", { copies: ["r1"], damaged: [] }); // the same: no change
    expect(changes).toBe(1);
    p.rename("A.md", "Dir/B.md");
    expect(p.placements("r1").map((x) => x.path)).toEqual(["Dir/B.md"]);
    expect(p.has("A.md")).toBe(false);
    p.rename("Nope.md", "Other.md"); // a note without copies: nothing
    expect(changes).toBe(2);
    // Detach (or the whole projection removed): the note holds no copy any more.
    p.index("Dir/B.md", { copies: [], damaged: [] });
    expect(p.placements("r1")).toEqual([]);
    p.index("C.md", { copies: ["r1"], damaged: [] });
    p.unindex("C.md");
    expect(p.placements("r1")).toEqual([]);
    expect(changes).toBe(5);
  });

  it("a rebuild drops what it knew and counts notes indexed meanwhile", () => {
    const p = new PlacementIndex();
    p.begin();
    p.index("A.md", { copies: ["r1"], damaged: [] });
    p.end();
    p.begin();
    expect(p.placements("r1")).toEqual([]);
    p.index("B.md", { copies: ["r1"], damaged: [] });
    p.end();
    expect(p.placements("r1").map((x) => x.path)).toEqual(["B.md"]);
  });

  it("reads a note's copies from its markers, a damaged one included (C17)", () => {
    const two = parseSections(lines(...copy, "", ...copy));
    expect(noteSections(two)).toEqual({ copies: [HEX, HEX], damaged: [] });
    const broken = parseSections(lines("## Launch", formatBoundary("start", S), "- a"));
    expect(noteSections(broken)).toEqual({ copies: [], damaged: [HEX] });
  });
});
