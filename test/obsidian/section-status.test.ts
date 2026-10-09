// LFCP-02-064 and native C17: keyboard access reaches a copy whose boundary
// is damaged, through "Open shared section details" and "Go to next shared
// section problem", like a valid section.

import { describe, expect, it } from "vitest";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import { sectionAtLine, sectionKey, sectionProblems } from "../../src/obsidian/section-status";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const S = parseSectionRef(`lfcp1:${R}#section:019a2f85-7b31-7c42-b85a-fc843e2f4001`) as SectionRef;
const start = formatBoundary("start", S);
const end = formatBoundary("end", S);
const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("a copy with a damaged boundary", () => {
  const damaged = lines("# Doc", "Private.", "## Launch", start, "- [ ] One", "", "More.");

  it("is the section under the cursor from its heading on", () => {
    expect(sectionAtLine(damaged, 1)).toBeNull();
    for (const line of [2, 4, 6])
      expect(sectionAtLine(damaged, line)).toEqual({ key: sectionKey(S), title: "Launch" });
  });

  it("is a problem to go to, whatever its section's status", () => {
    expect(sectionProblems(damaged, new Map())).toEqual([{ line: 2, title: "Launch" }]);
  });

  it("a valid section is unchanged: found to its end marker, no problem without a status", () => {
    const valid = lines("## Launch", start, "- [ ] One", end, "", "Private.");
    expect(sectionAtLine(valid, 3)).toEqual({ key: sectionKey(S), title: "Launch" });
    expect(sectionAtLine(valid, 5)).toBeNull();
    expect(sectionProblems(valid, new Map())).toEqual([]);
  });
});
