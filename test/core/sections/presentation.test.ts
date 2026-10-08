// LFCP-02-048: which lines the editor hides (M5) and where a section's
// boundary runs.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { sectionPresentation } from "../../../src/core/sections/presentation";

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
    });
  });

  it("hides nothing in a note without sections or with a damaged one", () => {
    expect(sectionPresentation(`- [ ] A\n  ${ref(2)}\n`)).toEqual({
      bindingLines: [],
      sections: [],
    });
    const damaged = ["## Shared", formatBoundary("start", S), "- [ ] A", `  ${ref(2)}`].join("\n");
    expect(sectionPresentation(damaged)).toEqual({ bindingLines: [], sections: [] });
  });
});
