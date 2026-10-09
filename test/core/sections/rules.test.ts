// LFCP-02-046: context-aware delete, detach, duplicate and cut/paste
// inside shared sections (MARKDOWN-SECTIONS-01 §7, §10).

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import {
  type ParsedSection,
  parseSections,
  type SectionNode,
} from "../../../src/core/sections/parser";
import {
  classifyRemoval,
  detachAt,
  detachSection,
  duplicates,
  keepRefWithTask,
  pasteDecision,
  readableSection,
} from "../../../src/core/sections/rules";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const T = parseSectionRef(`lfcp1:${R}#section:${id(9)}`) as SectionRef;
const ref = (n: number) => `<!-- lfcp-ref: lfcp1:${R}#task:${id(n)} -->`;
const note = (eol = "\n", end = eol) =>
  [
    "Private before.",
    "## Launch",
    formatBoundary("start", S),
    `- [ ] Inline 📅 2026-11-01 ${ref(2)}`,
    "- [ ] Child",
    `  ${ref(3)}`,
    `  ${formatNodeMarker("paragraph", id(4))}`,
    "  Draft",
    formatBoundary("end", S),
    "Private after.",
  ].join(eol) + end;
const sectionOf = (md: string) => parseSections(md).sections[0] as ParsedSection;

describe("detach this projection (§10, MS10-detach)", () => {
  it("removes every binding of the section, inline refs included, and keeps the text and line endings", () => {
    for (const eol of ["\n", "\r\n"]) {
      const md = note(eol);
      expect(detachSection(md, sectionOf(md))).toBe(
        [
          "Private before.",
          "## Launch",
          "- [ ] Inline 📅 2026-11-01",
          "- [ ] Child",
          "  Draft",
          "Private after.",
        ].join(eol) + eol,
      );
    }
  });

  it("an end marker on the last line, without an ending, leaves no stray line ending", () => {
    const md = [
      "## Launch",
      formatBoundary("start", S),
      "- [ ] Child",
      `  ${ref(3)}`,
      formatBoundary("end", S),
    ].join("\n");
    expect(detachSection(md, sectionOf(md))).toBe("## Launch\n- [ ] Child");
  });
});

describe("detach at the cursor (§10)", () => {
  it("detaches the section the line is in; another section and private text stay as they are", () => {
    const other = [
      "## Other",
      formatBoundary("start", T),
      "- [ ] Theirs",
      `  ${ref(7)}`,
      formatBoundary("end", T),
      "",
    ].join("\n");
    const md = `${note()}${other}`;
    expect(detachAt(md, 0)).toBeNull();
    for (const line of [1, 7]) {
      const out = detachAt(md, line);
      expect(out?.title).toBe("Launch");
      expect(out?.section.sectionId).toBe(S.sectionId);
      expect(out?.markdown).toBe(`${detachSection(note(), sectionOf(note()))}${other}`);
    }
    expect(detachAt(md, 9)).toBeNull();
  });
});

describe("copy readable text (§10, MS25)", () => {
  it("the heading and content without bindings, LF, the note unchanged", () => {
    const md = note("\r\n");
    expect(readableSection(md, sectionOf(md))).toBe(
      "## Launch\n- [ ] Inline 📅 2026-11-01\n- [ ] Child\n  Draft\n",
    );
  });
});

describe("a missing node (§7)", () => {
  const md = note();
  const para = (sectionOf(md).nodes[1] as SectionNode).children[0] as SectionNode; // lines 6–7
  it("is a delete only when the transaction removed every line it owned (MS10-delete)", () => {
    expect(classifyRemoval(para, [{ from: 6, to: 7 }])).toBe("delete");
    expect(classifyRemoval(para, [{ from: 5, to: 8 }])).toBe("delete");
  });
  it("is lost when only its marker went (MS21) or no transaction is known (MS18)", () => {
    expect(classifyRemoval(para, [{ from: 6, to: 6 }])).toBe("lost");
    expect(classifyRemoval(para, null)).toBe("lost");
  });
});

describe("duplicates (§4.5, MS08)", () => {
  const md = note()
    .replace("Private after.", "")
    .replace(formatBoundary("end", S), `- [ ] Child\n  ${ref(3)}\n${formatBoundary("end", S)}`);
  it("the occurrence known before keeps the identity; the others are offered Duplicate as new", () => {
    const [d] = duplicates(sectionOf(md), new Set([id(3)]));
    expect(d?.id).toBe(id(3));
    expect(d?.keep?.lines.from).toBe(4);
    expect(d?.copies.map((n) => n.lines.from)).toEqual([8]);
  });
  it("with no base, none is the original", () => {
    expect(duplicates(sectionOf(md), new Set())[0]?.copies).toHaveLength(2);
  });
});

describe("cut and paste (§10)", () => {
  it("a same-session paste of a cut into the same section is a move", () => {
    expect(pasteDecision({ section: S, ids: [id(3), id(4)] }, S, [id(3), id(4)])).toBe("move");
  });
  it("into another section, an explicit copy with new identities; without a cut, not inferred", () => {
    expect(pasteDecision({ section: S, ids: [id(3)] }, T, [id(3)])).toBe(
      "copy-with-new-identities",
    );
    expect(pasteDecision(null, S, [id(3)])).toBe("not-a-cut");
    expect(pasteDecision({ section: S, ids: [id(3)] }, S, [id(3), id(7)])).toBe("not-a-cut");
  });
});

describe("Enter after a Task with a child-line ref (§4.1, MS27, MS28)", () => {
  const md = (lines: string[]) => `${lines.join("\n")}\n`;
  const doc = md([
    "## Launch",
    formatBoundary("start", S),
    "- [ ] Child",
    `  ${ref(3)}`,
    `  ${formatNodeMarker("paragraph", id(4))}`,
    "  Draft",
    formatBoundary("end", S),
  ]);
  const endOf = (text: string) => doc.indexOf(text) + text.length;

  it("moves the new line past the Task's ref and children", () => {
    const kept = keepRefWithTask(doc, {
      from: endOf("- [ ] Child"),
      to: endOf("- [ ] Child"),
      insert: "\n- [ ] ",
    });
    expect(kept).toEqual({ from: endOf("  Draft"), to: endOf("  Draft"), insert: "\n- [ ] " });
  });

  it("leaves any other edit alone", () => {
    const inline = md([
      "## Launch",
      formatBoundary("start", S),
      `- [ ] Inline ${ref(2)}`,
      formatBoundary("end", S),
    ]);
    const at = inline.indexOf(ref(2)) + ref(2).length;
    expect(keepRefWithTask(inline, { from: at, to: at, insert: "\n- [ ] " })).toBeNull();
    expect(
      keepRefWithTask(doc, { from: endOf("  Draft"), to: endOf("  Draft"), insert: "\nmore" }),
    ).toBeNull();
    expect(
      keepRefWithTask(doc, { from: endOf("- [ ] Child"), to: endOf("- [ ] Child"), insert: "x" }),
    ).toBeNull();
  });
});
