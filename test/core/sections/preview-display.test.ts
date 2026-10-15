// LFCP-03-020 (U03-27, UX contract C5, F-09): the insert preview's readable
// view hides only the bindings the parser recognises; the source that is
// written is the block itself; unknown comments and raw text stay; metadata
// the parser cannot read stays visible with a problem sentence.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { BOUNDARY_UNREAD, insertDisplay } from "../../../src/core/sections/preview-display";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const ref = (n: number) => `<!-- lfcp-ref: lfcp1:${R}#task:${id(n)} -->`;

const block = (body: readonly string[]) =>
  ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join("\n");

describe("the insert preview's readable view", () => {
  it("hides the boundary, node markers and Task refs; the source is the block, byte for byte", () => {
    const b = block([
      "- [ ] Prepare contract",
      `  ${ref(2)}`,
      "  - [ ] Legal review",
      `    ${ref(3)}`,
      "",
      formatNodeMarker("paragraph", id(4)),
      "Draft the plan.",
      "",
      `- [ ] Inline ${ref(5)} ⏫`,
    ]);
    const d = insertDisplay(b);
    expect(d.readable).toBe(
      [
        "## Launch",
        "- [ ] Prepare contract",
        "  - [ ] Legal review",
        "",
        "Draft the plan.",
        "",
        "- [ ] Inline ⏫",
        "",
      ].join("\n"),
    );
    expect(d.readable).not.toContain("lfcp");
    expect(d.source).toBe(b);
    expect(d.hidden).toBe(6);
    expect(d.problem).toBeNull();
  });

  it("keeps unknown comments, raw blocks and a marker written inside a fence", () => {
    const b = block([
      formatNodeMarker("raw", id(6)),
      "<!-- my own note -->",
      "",
      formatNodeMarker("raw", id(7)),
      "```",
      formatNodeMarker("paragraph", id(8)),
      "<script>alert(1)</script>",
      "```",
      "",
      formatNodeMarker("raw", id(9)),
      "| a | b |",
      "| - | - |",
    ]);
    const d = insertDisplay(b);
    expect(d.readable).toContain("<!-- my own note -->");
    expect(d.readable).toContain(
      `${formatNodeMarker("paragraph", id(8))}\n<script>alert(1)</script>`,
    );
    expect(d.readable).toContain("| a | b |");
    expect(d.readable.match(/lfcp-node/g)).toHaveLength(1);
    expect(d.source).toBe(b);
  });

  it("shows a malformed marker as it is, and says where it is", () => {
    const b = block([
      "- [ ] A",
      `  ${ref(2)}`,
      "",
      "<!-- lfcp-node: paragraph:not-an-id -->",
      "Text",
    ]);
    const d = insertDisplay(b);
    expect(d.readable).toContain("<!-- lfcp-node: paragraph:not-an-id -->");
    expect(d.readable).not.toContain("lfcp-ref");
    expect(d.problem).toBe(
      "Line 6 has sharing metadata that could not be read. It is shown as it is.",
    );
  });

  it("hides nothing when the block's boundary does not read back as one section", () => {
    const open = ["## Launch", formatBoundary("start", S), "- [ ] A", `  ${ref(2)}`, ""].join("\n");
    expect(insertDisplay(open)).toEqual({
      readable: open,
      source: open,
      hidden: 0,
      problem: BOUNDARY_UNREAD,
    });
  });
});
