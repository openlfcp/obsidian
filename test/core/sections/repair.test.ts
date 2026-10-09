// LFCP-02-062: repairing a note's shared sections (unit evidence): exact
// boundary candidates, never an automatic widening; the user's line places
// the marker; private text around a section is never offered; unsupported
// content and lost bindings are located; a lost base is compared, line by
// line, with nothing chosen (UX13/UX14, MS05/MS11/MS16).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { formatBoundary } from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import { boundaryRepair, compare, repairItems } from "../../../src/core/sections/repair";

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
});
