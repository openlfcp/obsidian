// LFCP-02-046: context-aware delete, detach, duplicate and cut/paste
// inside shared sections (MARKDOWN-SECTIONS-01 §7, §10).

import { toBase64url } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
  sameSection,
} from "../../../src/core/sections/grammar";
import {
  type ParsedSection,
  parseSections,
  type SectionNode,
} from "../../../src/core/sections/parser";
import {
  bindsOwnNode,
  classifyRemoval,
  detachAt,
  detachSection,
  duplicates,
  keepMarkerWithParagraph,
  keepRefWithTask,
  pasteBindings,
  pasteDecision,
  readableSection,
  removeNodeLines,
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

describe("removing a node from the note (Review conflicts)", () => {
  const apply = (md: string, cs: readonly { from: number; to: number; insert: string }[]) =>
    [...cs].reverse().reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), md);

  it("removes its own lines and those of its descendants that are gone too", () => {
    const md = note();
    const out = apply(md, removeNodeLines(md, S, id(3), new Set([id(4)])) ?? []);
    expect(out).toBe(
      note().replace(
        `- [ ] Child\n  ${ref(3)}\n  ${formatNodeMarker("paragraph", id(4))}\n  Draft\n`,
        "",
      ),
    );
  });

  it("keeps a descendant that is not gone, and finds nothing in another section", () => {
    const md = note();
    const out = apply(md, removeNodeLines(md, S, id(3)) ?? []);
    expect(out).toContain("  Draft");
    expect(out).not.toContain("- [ ] Child");
    expect(removeNodeLines(md, T, id(3))).toBeNull();
  });
});

describe("bindings in pasted text (§10)", () => {
  const O = toBase64url(new Uint8Array(32).fill(9));
  const foreign = `<!-- lfcp-ref: lfcp1:${O}#task:${id(30)} -->`;
  const md = note();
  /** Offset of the start of line `n` of `md`. */
  const at = (n: number) =>
    md
      .split("\n")
      .slice(0, n)
      .reduce((k, l) => k + l.length + 1, 0);
  const paste = (line: number, insert: string, keep = (b: { id: string }) => b.id === id(3)) =>
    pasteBindings(md, { from: at(line), to: at(line), insert }, (b) => keep(b));

  it("removes a binding that is not its own there: a child-line ref with its line, an inline ref, a marker", () => {
    expect(paste(8, `- [ ] Copied\n  ${foreign}\n`)?.insert).toBe("- [ ] Copied\n");
    expect(paste(8, `- [ ] Copied ${foreign}\n`)?.insert).toBe("- [ ] Copied\n");
    expect(paste(8, `${formatNodeMarker("paragraph", id(31))}\nText\n`)?.insert).toBe("Text\n");
  });

  it("keeps its own binding, and changes nothing without bindings to remove", () => {
    expect(paste(8, `- [ ] Child\n  ${ref(3)}\n`)).toBeNull();
    expect(paste(8, "- [ ] Plain\n")).toBeNull();
  });

  it("tells where the text lands: in the section before its end marker, outside before its start", () => {
    const into: (SectionRef | null)[] = [];
    const record = (line: number) =>
      pasteBindings(md, { from: at(line), to: at(line), insert: `x ${foreign}` }, (_b, s) => {
        into.push(s);
        return true;
      });
    record(8);
    record(2);
    record(9);
    expect(into).toEqual([S, null, null]);
  });

  it("binds its own node: a node of that section there, a 0.1 Task ref outside sections", () => {
    const nodes = (s: SectionRef) => (sameSection(s, S) ? { [id(3)]: {} } : undefined);
    const isSection = (r: string) => r === R;
    expect(bindsOwnNode({ kind: "task", id: id(3), resource: R }, S, nodes, isSection)).toBe(true);
    expect(bindsOwnNode({ kind: "task", id: id(30), resource: R }, S, nodes, isSection)).toBe(
      false,
    );
    expect(bindsOwnNode({ kind: "task", id: id(3), resource: O }, S, nodes, isSection)).toBe(false);
    expect(bindsOwnNode({ kind: "paragraph", id: id(3) }, S, nodes, isSection)).toBe(true);
    // Not loaded: what is pasted is kept.
    expect(bindsOwnNode({ kind: "task", id: id(30), resource: O }, T, nodes, isSection)).toBe(true);
    expect(bindsOwnNode({ kind: "task", id: id(3), resource: R }, null, nodes, isSection)).toBe(
      false,
    );
    expect(bindsOwnNode({ kind: "task", id: id(30), resource: O }, null, nodes, isSection)).toBe(
      true,
    );
    expect(bindsOwnNode({ kind: "paragraph", id: id(3) }, null, nodes, isSection)).toBe(false);
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

// The owner's check of 0.4.0-beta.8: Enter at the start of a paragraph put
// the new line between its marker and its text, so the marker bound an empty
// paragraph and the text became a new node, on every vault.
describe("Enter at the start of a paragraph's text (§4.3, §5)", () => {
  const apply = (md: string, c: { from: number; to: number; insert: string }) =>
    md.slice(0, c.from) + c.insert + md.slice(c.to);
  const all = (ns: readonly SectionNode[]): SectionNode[] =>
    ns.flatMap((n) => [n, ...all(n.children)]);
  const paragraphs = (md: string) =>
    all(sectionOf(md).nodes)
      .filter((n) => n.kind === "paragraph")
      .map((n) => ({
        id: n.id,
        text: md
          .split(/\r?\n/)
          .slice(n.lines.from, n.lines.to + 1)
          .join("|"),
      }));

  for (const [name, eol] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ] as const)
    it(`the new line goes before the marker; the text keeps its node (first node, ${name})`, () => {
      const md = [
        "## Launch",
        formatBoundary("start", S),
        formatNodeMarker("paragraph", id(4)),
        "A paragraph for typing.",
        formatBoundary("end", S),
        "",
      ].join(eol);
      const at = md.indexOf("A paragraph");
      const moved = keepMarkerWithParagraph(md, { from: at, to: at, insert: eol });
      const marker = md.indexOf(formatNodeMarker("paragraph", id(4)));
      expect(moved).toEqual({ from: marker, to: marker, insert: eol });
      const after = apply(md, moved as NonNullable<typeof moved>);
      expect(paragraphs(after)).toEqual([
        { id: id(4), text: `${formatNodeMarker("paragraph", id(4))}|A paragraph for typing.` },
      ]);
    });

  it("after a Task, and nested under one with its indentation", () => {
    const md = [
      "## Launch",
      formatBoundary("start", S),
      "- [ ] 仕事",
      `  ${ref(3)}`,
      `  ${formatNodeMarker("paragraph", id(5))}`,
      "  Nested text",
      formatNodeMarker("paragraph", id(4)),
      "A paragraph for typing.",
      formatBoundary("end", S),
      "",
    ].join("\n");
    const top = md.indexOf("A paragraph");
    expect(keepMarkerWithParagraph(md, { from: top, to: top, insert: "\n" })).toEqual({
      from: md.indexOf(formatNodeMarker("paragraph", id(4))),
      to: md.indexOf(formatNodeMarker("paragraph", id(4))),
      insert: "\n",
    });
    const nested = md.indexOf("Nested text");
    const moved = keepMarkerWithParagraph(md, { from: nested, to: nested, insert: "\n  " });
    const marker = md.indexOf(`  ${formatNodeMarker("paragraph", id(5))}`);
    expect(moved).toEqual({ from: marker, to: marker, insert: "\n  " });
  });

  it("leaves any other edit alone", () => {
    const md = [
      "## Launch",
      formatBoundary("start", S),
      formatNodeMarker("paragraph", id(4)),
      "A paragraph for typing.",
      "",
      "Unbound paragraph",
      formatBoundary("end", S),
      "",
    ].join("\n");
    const start = md.indexOf("A paragraph");
    const mid = start + 2;
    const end = start + "A paragraph for typing.".length;
    const unbound = md.indexOf("Unbound");
    // Enter in the middle or at the end of the text: an ordinary split or new paragraph.
    expect(keepMarkerWithParagraph(md, { from: mid, to: mid, insert: "\n" })).toBeNull();
    expect(keepMarkerWithParagraph(md, { from: end, to: end, insert: "\n" })).toBeNull();
    // A paragraph without a marker, typed text, a replacement.
    expect(keepMarkerWithParagraph(md, { from: unbound, to: unbound, insert: "\n" })).toBeNull();
    expect(keepMarkerWithParagraph(md, { from: start, to: start, insert: "x" })).toBeNull();
    expect(keepMarkerWithParagraph(md, { from: start, to: start + 1, insert: "\n" })).toBeNull();
  });
});
