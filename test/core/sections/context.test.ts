// Task 100: where a cursor or selection sits relative to shared sections.

import { describe, expect, it } from "vitest";
import { sectionContext } from "../../../src/core/sections/context";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";

const S = parseSectionRef(
  "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#section:019a2f85-7b31-7c42-b85a-fc843e2f4001",
) as SectionRef;
const md = [
  "- [ ] Before",
  "## Shared",
  formatBoundary("start", S),
  "- [ ] In",
  formatBoundary("end", S),
  "- [ ] After",
].join("\n");

describe("sectionContext", () => {
  it("outside, inside (heading and markers included) and crossing", () => {
    expect(sectionContext(md, { from: 0, to: 0 })).toBe("outside");
    expect(sectionContext(md, { from: 5, to: 5 })).toBe("outside");
    expect(sectionContext(md, { from: 1, to: 4 })).toBe("inside");
    expect(sectionContext(md, { from: 3, to: 3 })).toBe("inside");
    expect(sectionContext(md, { from: 0, to: 3 })).toBe("crossing");
    expect(sectionContext(md, { from: 3, to: 5 })).toBe("crossing");
  });

  it("a damaged boundary counts as damaged, down to the end of the note", () => {
    const broken = [
      "- [ ] Before",
      "## Shared",
      formatBoundary("start", S),
      "- [ ] In",
      "- [ ] After",
    ].join("\n");
    expect(sectionContext(broken, { from: 0, to: 0 })).toBe("outside");
    expect(sectionContext(broken, { from: 4, to: 4 })).toBe("damaged");
  });
});
