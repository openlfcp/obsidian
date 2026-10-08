// LFCP-02-036: Text positions (UTF-16 ↔ Unicode scalars, SSP §10) and the
// source map between a node's Text and the note.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections, type SectionNode } from "../../../src/core/sections/parser";
import {
  docToText,
  nodeSource,
  stripIndent,
  textEditToDoc,
  textToDoc,
} from "../../../src/core/sections/source-map";
import {
  applyTextEdit,
  diffText,
  isWellFormed,
  scalarLength,
  scalarToUtf16,
  TextPositionError,
  utf16ToScalar,
} from "../../../src/core/sections/text";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const section = (body: readonly string[], eol = "\n") =>
  `${["## S", formatBoundary("start", S), ...body, formatBoundary("end", S)].join(eol)}${eol}`;
const nodesOf = (md: string): SectionNode[] => {
  const flat: SectionNode[] = [];
  const walk = (ns: readonly SectionNode[]) => {
    for (const n of ns) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(parseSections(md).sections[0]?.nodes ?? []);
  return flat;
};

describe("UTF-16 ↔ scalar (SSP §10)", () => {
  const t = "Ёж 🦔 и 👩‍💻!";
  it("counts scalars, not code units", () => {
    expect(t.length).toBe(14);
    expect(scalarLength(t)).toBe(11); // 👩‍💻 is three scalars: woman, ZWJ, laptop
    expect(utf16ToScalar(t, 5)).toBe(4); // after the hedgehog's pair
    expect(scalarToUtf16(t, 4)).toBe(5);
    for (let k = 0; k <= scalarLength(t); k++)
      expect(utf16ToScalar(t, scalarToUtf16(t, k))).toBe(k);
  });

  it("refuses an offset inside a pair and lone surrogates", () => {
    expect(() => utf16ToScalar(t, 4)).toThrow(TextPositionError);
    expect(isWellFormed("a\uD83Eb")).toBe(false);
    expect(isWellFormed("a\uDD94")).toBe(false);
    expect(isWellFormed(t)).toBe(true);
    expect(() => scalarToUtf16("a\uDD94", 2)).toThrow(TextPositionError);
  });

  it("diffs in scalars without splitting a pair, and applies back", () => {
    const before = "Call 🦔 today";
    const after = "Call 🦊 today";
    const edit = diffText(before, after);
    expect(edit).toEqual({ index: 5, deleteCount: 1, insert: "🦊" });
    expect(applyTextEdit(before, edit as NonNullable<typeof edit>)).toBe(after);
    expect(diffText("same", "same")).toBeNull();
  });
});

describe("stripIndent (M2: tabs to the next multiple of 4)", () => {
  it("strips to a column; a tab reaching past it leaves spaces", () => {
    expect(stripIndent("    text", 2)).toEqual({ rest: "  text", from: 2, virtual: 0 });
    expect(stripIndent("\ttext", 4)).toEqual({ rest: "text", from: 1, virtual: 0 });
    expect(stripIndent("\ttext", 2)).toEqual({ rest: "  text", from: 1, virtual: 2 });
    expect(stripIndent("text", 2)).toEqual({ rest: "text", from: 0, virtual: 0 });
  });
});

describe("node Text and the source map", () => {
  it("paragraph: marker excluded, indentation stripped, LF between lines, CRLF in the note", () => {
    for (const eol of ["\n", "\r\n"]) {
      const md = section(
        [
          "- [ ] Task",
          `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`,
          `  ${formatNodeMarker("paragraph", id(3))}`,
          "  Первая строка 🦔",
          "  second line",
        ],
        eol,
      );
      const p = nodesOf(md).find((n) => n.kind === "paragraph") as SectionNode;
      const src = nodeSource(md, p);
      expect(src?.text).toBe("Первая строка 🦔\nsecond line");
      expect(src?.indent).toBe("  ");
      expect(src?.eol).toBe(eol);
      // Every scalar position maps into the note and back.
      const text = src?.text ?? "";
      for (let k = 0; k <= scalarLength(text); k++) {
        const off = textToDoc(src as NonNullable<typeof src>, k);
        expect(docToText(src as NonNullable<typeof src>, off)).toBe(k);
      }
      // "s" of "second" sits right after the CRLF/LF and the two spaces.
      const s = textToDoc(src as NonNullable<typeof src>, Array.from("Первая строка 🦔\n").length);
      expect(md.slice(s, s + 6)).toBe("second");
    }
  });

  it("item: the inline text after the marker plus its continuation lines, lazy ones too", () => {
    const md = section([
      "- Check details",
      "  and the bank",
      "lazy line",
      `  ${formatNodeMarker("item", id(4))}`,
    ]);
    const item = nodesOf(md).find((n) => n.kind === "item") as SectionNode;
    expect(item.id).toBe(id(4));
    const src = nodeSource(md, item);
    expect(src?.text).toBe("Check details\nand the bank\nlazy line");
    expect(src?.indent).toBe("  ");
  });

  it("raw: the block relative to the content column, without a final LF", () => {
    const md = section([formatNodeMarker("raw", id(5)), "| a | b |", "| - | - |"]);
    const raw = nodesOf(md)[0] as SectionNode;
    expect(nodeSource(md, raw)?.text).toBe("| a | b |\n| - | - |");
  });

  it("a Task has no Text", () => {
    const md = section(["- [ ] Task", `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`]);
    expect(nodeSource(md, nodesOf(md)[0] as SectionNode)).toBeNull();
  });

  it("a Text edit projected into the note gives back the edited Text (LF and CRLF, Unicode)", () => {
    for (const eol of ["\n", "\r\n"]) {
      const md = section(
        [
          "- [ ] Parent",
          `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`,
          `  ${formatNodeMarker("paragraph", id(3))}`,
          "  Ёж 🦔 one",
          "  two",
        ],
        eol,
      );
      const p = nodesOf(md).find((n) => n.kind === "paragraph") as SectionNode;
      const src = nodeSource(md, p) as NonNullable<ReturnType<typeof nodeSource>>;
      for (const edit of [
        { index: 3, deleteCount: 1, insert: "🦊" },
        { index: 0, deleteCount: 0, insert: "Start " },
        { index: Array.from(src.text).length, deleteCount: 0, insert: "\nthree" },
        { index: 5, deleteCount: 6, insert: "" }, // across the line break
      ]) {
        const change = textEditToDoc(src, edit);
        const next = md.slice(0, change.from) + change.insert + md.slice(change.to);
        const again = nodeSource(
          next,
          nodesOf(next).find((n) => n.kind === "paragraph") as SectionNode,
        );
        expect(again?.text).toBe(applyTextEdit(src.text, edit));
        expect(next.includes("\r\n") || eol === "\n").toBe(true);
      }
    }
  });
});
