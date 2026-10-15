// LFCP-02-062: repairing a note's shared sections (unit evidence): exact
// boundary candidates, never an automatic widening; the user's line places
// the marker; private text around a section is never offered; unsupported
// content and lost bindings are located; a lost base is compared, line by
// line, with nothing chosen (UX13/UX14, MS05/MS11/MS16).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { formatBoundary } from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import {
  boundaryRepair,
  compare,
  findRepair,
  keyedRepairs,
  repairItems,
  sharedVersionChange,
} from "../../../src/core/sections/repair";

const R = new Uint8Array(32).fill(3);
const ref = { resourceId: R, sectionId: "0192e4a0-0000-7000-8000-000000000001" };
const other = {
  resourceId: new Uint8Array(32).fill(4),
  sectionId: "0192e4a0-0000-7000-8000-000000000002",
};
const PRIVATE = "PRIVATE_CANARY_5a1f: my own notes";

describe("boundary repair (062)", () => {
  const broken = [
    "## Launch",
    formatBoundary("start", ref),
    "- [ ] One",
    "",
    "Draft",
    "",
    "## Other",
    PRIVATE,
    "",
  ].join("\n");

  it("offers the exact lines a missing end can follow, up to the next heading; nothing private", () => {
    const items = repairItems(broken);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.kind !== "missing-end") throw new Error(item?.kind);
    expect(item.candidates).toEqual([
      { afterLine: 2, preview: "- [ ] One" },
      { afterLine: 4, preview: "Draft" },
    ]);
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CANARY");
    // The user's choice, not a guess: the section parses, the private line stays outside.
    const fixed = applyChanges(broken, [boundaryRepair(broken, item, 4)]);
    const s = parseSections(fixed).sections[0];
    expect(s?.endLine).toBe(5);
    expect(fixed).toContain(`## Other\n${PRIVATE}`);
    expect(() => boundaryRepair(broken, item, 7)).toThrow("not a candidate line");
  });

  it("a missing start offers the headings above it", () => {
    const md = ["# Plan", "", "## Launch", "Text", formatBoundary("end", ref), ""].join("\n");
    const [item] = repairItems(md);
    if (item?.kind !== "missing-start") throw new Error(item?.kind);
    expect(item.candidates.map((c) => c.headingLine)).toEqual([2, 0]);
    const fixed = applyChanges(md, [boundaryRepair(md, item, 2)]);
    expect(parseSections(fixed).sections).toHaveLength(1);
  });

  it("two Resources: a broken one is repaired alone; the healthy one is not touched", () => {
    const md = [
      "## Healthy",
      formatBoundary("start", other),
      "Shared",
      formatBoundary("end", other),
      "",
      "## Broken",
      formatBoundary("start", ref),
      "Text",
      "",
    ].join("\n");
    const items = repairItems(md);
    expect(items.map((i) => i.kind)).toEqual(["missing-end"]);
    expect(parseSections(md).sections.map((s) => s.heading.title)).toEqual(["Healthy"]);
  });

  it("unsupported content and lost bindings are located, not fixed", () => {
    const md = [
      "## Launch",
      formatBoundary("start", ref),
      "Text",
      "### Inside",
      formatBoundary("end", ref),
      "",
    ].join("\n");
    expect(repairItems(md)).toEqual([
      {
        kind: "locate",
        line: 3,
        message:
          "This content cannot be shared by this version yet: edit it, or end the section before it.",
      },
    ]);
  });
});

describe("a lost base: the comparison (MS11)", () => {
  it("shows both sides line by line and chooses nothing", () => {
    expect(compare("- [ ] One\nMine\nShared", "- [ ] One\nShared\nTheirs")).toEqual([
      { kind: "same", text: "- [ ] One" },
      { kind: "local", text: "Mine" },
      { kind: "same", text: "Shared" },
      { kind: "shared", text: "Theirs" },
    ]);
  });

  it("taking the shared version replaces only the section's body; its heading and the rest stay", () => {
    const md = [
      PRIVATE,
      "",
      "## My heading",
      formatBoundary("start", ref),
      "Local text",
      formatBoundary("end", ref),
      "",
      "After.",
      "",
    ].join("\n");
    const s = parseSections(md).sections[0];
    if (s === undefined) throw new Error("no section");
    const block = [
      "## Launch",
      formatBoundary("start", ref),
      "Shared text",
      formatBoundary("end", ref),
      "",
    ].join("\n");
    expect(applyChanges(md, [sharedVersionChange(md, s, block)])).toBe(
      md.replace("Local text", "Shared text"),
    );
  });
});

describe("line keys of repair items (LFCP-03-018)", () => {
  const broken = [
    "## Launch",
    formatBoundary("start", ref),
    "- [ ] One",
    "### Inside",
    "",
    "## Other",
    "",
  ].join("\n");

  it("a key names the item by what it is and its line's text, never by its line number", () => {
    const keyed = keyedRepairs(broken);
    expect(keyed.map((k) => k.item.kind)).toEqual(repairItems(broken).map((i) => i.kind));
    const moved = keyedRepairs(`Intro\nMore\n${broken}`);
    // Two lines above: the same keys, two lines further down.
    expect(moved.map((k) => k.key)).toEqual(keyed.map((k) => k.key));
    expect(moved.map((k) => k.item.line)).toEqual(keyed.map((k) => k.item.line + 2));
  });

  it("findRepair takes the item with that key nearest the old line; none when it is gone", () => {
    const [end] = keyedRepairs(broken).filter((k) => k.item.kind === "missing-end");
    if (end === undefined) throw new Error("no missing end");
    const at = (line: number) => ({ key: "k", item: { ...end.item, line } });
    const keyed = [at(1), at(9), end];
    expect(findRepair(keyed, "k", 0)?.item.line).toBe(1);
    expect(findRepair(keyed, "k", 7)?.item.line).toBe(9);
    expect(findRepair(keyed, end.key, 40)).toBe(end);
    expect(findRepair(keyed, "missing-end:nothing", 1)).toBeUndefined();
  });
});
