// LFCP-02-048: which lines the editor hides (M5) and where a section's
// boundary runs.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import {
  BOUNDARY_CUE_TEXT,
  boundaryCues,
  sectionPresentation,
} from "../../../src/core/sections/presentation";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const ref = (n: number) => `<!-- lfcp-ref: lfcp1:${R}#task:${id(n)} -->`;

describe("sectionPresentation", () => {
  it("hides a valid section's boundary lines, node markers and child-line refs; nothing outside", () => {
    const md = [
      "- [ ] Standalone",
      `  ${ref(9)}`,
      "## Shared",
      formatBoundary("start", S),
      "- [ ] Task",
      `  ${ref(2)}`,
      `  ${formatNodeMarker("paragraph", id(3))}`,
      "  Text",
      `- [ ] Inline ${ref(4)}`,
      formatBoundary("end", S),
      "Private.",
    ].join("\r\n");
    expect(sectionPresentation(md)).toEqual({
      bindingLines: [3, 5, 6, 9],
      sections: [{ from: 2, to: 9 }],
      damaged: [],
    });
  });

  it("keeps a child-line ref hidden after Tasks completes the Task (C-7: its ✅ date, a recurrence)", () => {
    // The lines Obsidian Tasks writes (test/native/specs/tasks-plugin.e2e.mjs): the
    // child-line ref is untouched; a recurring Task's next occurrence goes above, unbound.
    const note = (...task: string[]) =>
      ["## Shared", formatBoundary("start", S), ...task, formatBoundary("end", S)].join("\n");
    expect(
      sectionPresentation(note("- [x] Alpha 📅 2026-11-01 ✅ 2026-10-19", `  ${ref(2)}`))
        .bindingLines,
    ).toEqual([1, 3, 4]);
    expect(
      sectionPresentation(
        note(
          "- [ ] Water 🔁 every day 📅 2026-11-02",
          "- [x] Water 🔁 every day 📅 2026-11-01 ✅ 2026-10-19",
          `  ${ref(2)}`,
        ),
      ).bindingLines,
    ).toEqual([1, 4, 5]);
  });

  it("hides nothing in a note without sections or with a damaged one", () => {
    expect(sectionPresentation(`- [ ] A\n  ${ref(2)}\n`)).toEqual({
      bindingLines: [],
      sections: [],
      damaged: [],
    });
    const damaged = ["## Shared", formatBoundary("start", S), "- [ ] A", `  ${ref(2)}`].join("\n");
    // A damaged copy hides nothing and claims no range: only where it starts is named.
    expect(sectionPresentation(damaged)).toEqual({ bindingLines: [], sections: [], damaged: [0] });
  });
});

describe("boundary cues (LFCP-03-020)", () => {
  const md = [
    "## Shared", // 0
    formatBoundary("start", S), // 1
    "- [ ] Task", // 2
    `  ${ref(2)}`, // 3
    formatBoundary("end", S), // 4
    "Private.", // 5
    "",
  ].join("\n");
  const model = sectionPresentation(md);
  const hidden = new Set(model.bindingLines);

  it("the end is the last visible line before the end marker", () => {
    expect(boundaryCues(model, hidden, null, 7)).toEqual({ ends: [2], cues: [] });
    // Markers shown (Source mode): the ref line is the last line before the end marker.
    expect(boundaryCues(model, new Set(), null, 7).ends).toEqual([3]);
  });

  it("an idle cursor on the last line is inside; on the line after the section, outside", () => {
    expect(boundaryCues(model, hidden, 2, 7).cues).toEqual([{ line: 2, kind: "inside" }]);
    expect(boundaryCues(model, hidden, 5, 7).cues).toEqual([{ line: 5, kind: "outside" }]);
    expect(boundaryCues(model, hidden, 0, 7).cues).toEqual([]);
    expect(BOUNDARY_CUE_TEXT).toEqual({
      inside: "Inside the shared section",
      outside: "Outside the shared section",
      unknown: "Section boundary not determined",
    });
  });

  it("a damaged copy is named at its start whatever the cursor, and its tail is never inside", () => {
    const broken = ["Intro", "## Shared", formatBoundary("start", S), "- [ ] A", "Private."].join(
      "\n",
    );
    const m = sectionPresentation(broken);
    expect(m.sections).toEqual([]);
    for (const cursor of [null, 3, 4])
      expect(boundaryCues(m, new Set(), cursor, 5)).toEqual({
        ends: [],
        cues: [{ line: 1, kind: "unknown" }],
      });
  });
});
