// The shared-section parser (LFCP-02-034/035) on the decisions already
// fixed for MVP 0.2: M1(a) Task refs on their child line, M2 tabs, M4 the
// start marker right after the heading, M6 raw blocks and no nested
// headings; fail-closed boundaries and the private tail (host fact H5).

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseBoundary,
  parseNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections, type SectionNode } from "../../../src/core/sections/parser";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const start = formatBoundary("start", S);
const end = formatBoundary("end", S);
const ref = (n: number, resource = R) => `<!-- lfcp-ref: lfcp1:${resource}#task:${id(n)} -->`;

/** kind:id(or "new") nested, for compact assertions. */
const shape = (nodes: readonly SectionNode[]): unknown[] =>
  nodes.map((n) => {
    const head = `${n.kind}:${n.id === null ? "new" : n.id.slice(-3)}`;
    return n.children.length === 0 ? head : [head, shape(n.children)];
  });
const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("grammar (one module, LFCP-02-007 may change it)", () => {
  it("round-trips boundaries and node markers, and tells malformed ones apart", () => {
    expect(parseBoundary(start)).toEqual({ kind: "start", ref: S });
    expect(parseBoundary(end)).toEqual({ kind: "end", ref: S });
    expect(parseBoundary(`${end}  `)?.kind).toBe("end");
    expect(parseBoundary("<!-- lfcp-section: lfcp1:nope#section:x -->")).toEqual({
      kind: "malformed",
    });
    expect(parseBoundary(`  ${start}`)).toEqual({ kind: "malformed" }); // not at column zero
    expect(parseBoundary("plain text")).toBeNull();
    expect(parseNodeMarker(formatNodeMarker("raw", id(9), "\t"))).toEqual({
      kind: "raw",
      nodeId: id(9),
      indent: "\t",
    });
    expect(parseNodeMarker("<!-- lfcp-node: heading:x -->")?.kind).toBe("malformed");
  });

  it("accepts extra spaces and tabs at each separator (§2, REFS-01 §6)", () => {
    const loose = `<!--\t lfcp-section:  lfcp1:${R}#section:${id(1)}\t-->\t`;
    expect(parseBoundary(loose)).toEqual({ kind: "start", ref: S });
    expect(parseNodeMarker(`  <!--  lfcp-node:\titem:${id(4)}  -->`)?.kind).toBe("item");
    // A section ref is only valid in a section marker; a Task ref stays a Task ref.
    expect(parseSectionRef(`lfcp1:${R}#task:${id(1)}`)).toBeUndefined();
  });
});

describe("boundaries (M4, fail closed)", () => {
  it("a section: its ATX heading right above the start marker, title and level local", () => {
    const text = lines(
      "Private.",
      "",
      "### Joint launch",
      start,
      `- [ ] One`,
      `  ${ref(2)}`,
      end,
      "",
      "## Next",
    );
    const scan = parseSections(text);
    expect(scan.diagnostics).toEqual([]);
    expect(scan.sections).toHaveLength(1);
    expect(scan.sections[0]).toMatchObject({
      heading: { line: 2, level: 3, title: "Joint launch" },
      startLine: 3,
      endLine: 6,
      privateTail: null,
      blocked: false,
    });
    expect(shape(scan.sections[0]?.nodes ?? [])).toEqual(["task:002"]);
    expect(scan.claimed).toEqual([{ from: 2, to: 6 }]);
  });

  it("the packet's form, marker above the heading, is not a section (SECTION_HEADING_INVALID)", () => {
    const text = lines("# Doc", "", start, "## Shared", "- [ ] One", end, "", "Private.");
    const scan = parseSections(text);
    expect(scan.sections).toEqual([]);
    expect(scan.diagnostics.map((d) => d.code)).toEqual(["SECTION_HEADING_INVALID"]);
    // Claimed down to the end of the note: no engine acts on lines whose owner is unclear.
    expect(scan.claimed).toEqual([{ from: 1, to: 7 }]);
  });

  it("a missing end marker claims to the end of the note and never captures the text after it", () => {
    const text = lines("## Shared", start, "- [ ] One", "", "## Private", "Secret.");
    const scan = parseSections(text);
    expect(scan.sections).toEqual([]);
    expect(scan.diagnostics.map((d) => d.code)).toEqual(["SECTION_BOUNDARY_MISSING"]);
    expect(scan.claimed).toEqual([{ from: 0, to: 5 }]);
  });

  it("mismatched and overlapping markers yield no section", () => {
    const T = parseSectionRef(`lfcp1:${R}#section:${id(7)}`) as SectionRef;
    expect(
      parseSections(lines("## A", start, formatBoundary("end", T))).diagnostics.map((d) => d.code),
    ).toEqual(["SECTION_BOUNDARY_MISMATCH"]); // one cause, one diagnostic (fixture MS19)
    const nested = parseSections(lines("## A", start, "## B", formatBoundary("start", T), end));
    expect(nested.sections).toEqual([]);
    expect(nested.diagnostics.map((d) => d.code)).toContain("SECTION_BOUNDARY_OVERLAP");
  });

  it("markers inside fences and Obsidian comments are text", () => {
    const text = lines("## Example", "```", start, end, "```", "%%", start, "%%");
    const scan = parseSections(text);
    expect(scan).toEqual({ sections: [], claimed: [], diagnostics: [] });
  });

  it("H5: private text after the end marker, under the same heading, is reported", () => {
    const text = lines(
      "## Shared",
      start,
      "- [ ] One",
      end,
      "",
      "Private tail.",
      "",
      "### Sub",
      "x",
      "## Next",
      "y",
    );
    const [s] = parseSections(text).sections;
    expect(s?.privateTail).toEqual({ from: 5, to: 8 });
    expect(parseSections(text).diagnostics).toEqual([
      { code: "SECTION_PRIVATE_TAIL", severity: "info", line: 5 },
    ]);
  });
});

describe("nodes", () => {
  it("M1(a): Task refs on their child line bind Tasks; nesting by content column", () => {
    const text = lines(
      "## Shared",
      start,
      "- [ ] Prepare contract",
      `  ${ref(2)}`,
      `  ${formatNodeMarker("paragraph", id(3))}`,
      "  Use the updated draft.",
      "",
      "  - Check details",
      `    ${formatNodeMarker("item", id(4))}`,
      "  - [ ] Obtain approval",
      `    ${ref(5)}`,
      "",
      formatNodeMarker("paragraph", id(6)),
      "Release date pending.",
      "- [ ] New task",
      end,
    );
    const [s] = parseSections(text).sections;
    expect(shape(s?.nodes ?? [])).toEqual([
      ["task:002", ["paragraph:003", "item:004", "task:005"]],
      "paragraph:006",
      "task:new",
    ]);
    expect(s?.nodes[0]?.lines).toEqual({ from: 2, to: 3 });
  });

  it("M2: tab indentation nests like spaces (tab stop 4)", () => {
    const text = lines(
      "## Shared",
      start,
      "- [ ] Parent",
      `\t${ref(2)}`,
      "\t- Child",
      `\t  ${formatNodeMarker("item", id(3))}`,
      "\t\t- [ ] Grandchild",
      `\t\t  ${ref(4)}`,
      end,
    );
    const [s] = parseSections(text).sections;
    expect(shape(s?.nodes ?? [])).toEqual([["task:002", [["item:003", ["task:004"]]]]]);
  });

  it("M6: tables, fences, callouts and HTML are raw nodes, not a paused section", () => {
    const text = lines(
      "## Shared",
      start,
      formatNodeMarker("raw", id(2)),
      "| a | b |",
      "| - | - |",
      "",
      "```js",
      "const x = 1;",
      "```",
      "> [!note] A callout",
      "> still the callout",
      "<div>html</div>",
      "",
      "- [ ] One",
      `  ${ref(3)}`,
      end,
    );
    const scan = parseSections(text);
    expect(scan.diagnostics).toEqual([]);
    const [s] = scan.sections;
    expect(s?.blocked).toBe(false);
    expect(shape(s?.nodes ?? [])).toEqual(["raw:002", "raw:new", "raw:new", "raw:new", "task:003"]);
    expect(s?.nodes.map((n) => n.lines)).toEqual([
      { from: 2, to: 4 },
      { from: 6, to: 8 },
      { from: 9, to: 10 },
      { from: 11, to: 11 },
      { from: 13, to: 14 },
    ]);
  });

  it("M6: a heading inside a section is SECTION_UNSUPPORTED_SYNTAX: the section is blocked, offer a split", () => {
    const scan = parseSections(lines("## Shared", start, "- [ ] One", "### Sub", "- [ ] Two", end));
    expect(scan.sections[0]?.blocked).toBe(true);
    expect(scan.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["SECTION_UNSUPPORTED_SYNTAX", 3],
    ]);
  });

  it("a duplicate ID, a foreign Task ref or a malformed marker blocks the section", () => {
    const dup = parseSections(
      lines("## S", start, "- [ ] A", `  ${ref(2)}`, "- [ ] B", `  ${ref(2)}`, end),
    );
    expect(dup.sections[0]?.blocked).toBe(true);
    expect(dup.diagnostics.map((d) => d.code)).toEqual(["NODE_BINDING_DUPLICATE"]);
    const foreign = `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const f = parseSections(lines("## S", start, "- [ ] A", `  ${ref(2, foreign)}`, end));
    expect(f.diagnostics.map((d) => d.code)).toEqual(["FOREIGN_RESOURCE_REF"]);
    const m = parseSections(lines("## S", start, "<!-- lfcp-node: paragraph:nope -->", "x", end));
    expect(m.diagnostics.map((d) => d.code)).toEqual(["NODE_MARKER_MALFORMED"]);
  });

  it("an empty saved paragraph keeps its identity (§4.3)", () => {
    const [s] = parseSections(
      lines("## S", start, formatNodeMarker("paragraph", id(2)), "", end),
    ).sections;
    expect(shape(s?.nodes ?? [])).toEqual(["paragraph:002"]);
  });

  it("§4.5: an Obsidian comment is not shared: kept in place, the rest of the section syncs", () => {
    const text = lines(
      "## S",
      start,
      "- [ ] One",
      `  ${ref(2)}`,
      "%% a note to self %%",
      "",
      "%%",
      formatNodeMarker("paragraph", id(5)),
      "",
      "still the comment",
      "%%",
      "- [ ] Two",
      `  ${ref(3)}`,
      end,
    );
    const scan = parseSections(text);
    const [s] = scan.sections;
    expect(s?.blocked).toBe(false);
    expect(shape(s?.nodes ?? [])).toEqual(["task:002", "task:003"]);
    expect(s?.localBlocks).toEqual([
      { from: 4, to: 4 },
      { from: 6, to: 10 },
    ]);
    expect(scan.diagnostics).toEqual([
      {
        code: "SECTION_UNSUPPORTED_SYNTAX",
        severity: "warning",
        line: 4,
        detail: "obsidian-comment",
      },
      {
        code: "SECTION_UNSUPPORTED_SYNTAX",
        severity: "warning",
        line: 6,
        detail: "obsidian-comment",
      },
    ]);
  });

  it("§4.4: an unclosed fence hides the end marker and fails closed", () => {
    const scan = parseSections(lines("## S", start, "```", "code", end, "", "Private."));
    expect(scan.sections).toEqual([]);
    expect(scan.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["SECTION_BOUNDARY_MISSING", 1],
      ["SECTION_UNSUPPORTED_SYNTAX", 2], // detail "unclosed-fence"
    ]);
    expect(scan.claimed).toEqual([{ from: 0, to: 6 }]);
  });

  it("a marker of another kind than its block, or with nothing to bind", () => {
    const k = parseSections(
      lines("## S", start, formatNodeMarker("raw", id(2)), "Plain text.", end),
    );
    expect(k.diagnostics.map((d) => d.code)).toEqual(["NODE_KIND_MISMATCH"]);
    const o = parseSections(lines("## S", start, formatNodeMarker("item", id(2)), end));
    expect(o.diagnostics.map((d) => d.code)).toEqual(["NODE_BINDING_ORPHAN"]);
  });

  it("§4.5 (spec 2d1a829): an HTML comment is local too, blank lines inside it included", () => {
    const text = lines(
      "## S",
      start,
      "<!-- private",
      "",
      "still private -->",
      "<div>shared</div>",
      end,
    );
    const scan = parseSections(text);
    expect(scan.sections[0]?.localBlocks).toEqual([{ from: 2, to: 4 }]);
    expect(shape(scan.sections[0]?.nodes ?? [])).toEqual(["raw:new"]);
    expect(scan.diagnostics).toEqual([
      { code: "SECTION_UNSUPPORTED_SYNTAX", severity: "warning", line: 2, detail: "html-comment" },
    ]);
  });

  it("§4.2: an item's continuation lines belong to it; its marker follows the last one", () => {
    const text = lines(
      "## S",
      start,
      "- Check details",
      "  and the bank",
      "lazy",
      `  ${formatNodeMarker("item", id(4))}`,
      end,
    );
    const [s] = parseSections(text).sections;
    expect(shape(s?.nodes ?? [])).toEqual(["item:004"]);
    expect(s?.nodes[0]?.lines).toEqual({ from: 2, to: 5 });
  });

  it("an item marker indented with tabs past the content column still binds (fixture MS31)", () => {
    // "\t- " has its content at column 6; the marker's "\t\t" reaches column 8.
    const text = lines(
      "## S",
      start,
      "\t- Check details",
      `\t\t${formatNodeMarker("item", id(4))}`,
      end,
    );
    const scan = parseSections(text);
    expect(scan.diagnostics).toEqual([]);
    expect(shape(scan.sections[0]?.nodes ?? [])).toEqual(["item:004"]);
  });

  it("an overlap is one diagnostic: the end markers it leaves are not MISSING (fixture MS22)", () => {
    const text = lines(
      "## A",
      start,
      "- [ ] One",
      "## B",
      start,
      "- [ ] Two",
      end,
      "",
      end,
      "",
      "Private.",
    );
    const scan = parseSections(text);
    expect(scan.sections).toEqual([]);
    expect(scan.diagnostics.map((d) => d.code)).toEqual(["SECTION_BOUNDARY_OVERLAP"]);
    expect(scan.claimed.at(-1)?.to).toBeGreaterThanOrEqual(8);
  });
});

describe("a Task ref no Task owns (MS17-transient)", () => {
  it("is a broken binding that pauses the section, never Text of the line it ends up under", () => {
    for (const md of [
      // The checkbox damaged while typing: the child-line ref is left under an item.
      lines("## Launch", start, "- [ Prepare contract", `  ${ref(2)}`, end),
      // The same with an inline ref.
      lines("## Launch", start, `- [ Prepare contract ${ref(2)}`, end),
      // A paragraph line with a ref.
      lines("## Launch", start, "Prepare contract", ref(2), end),
    ]) {
      const scan = parseSections(md);
      const [s] = scan.sections;
      expect(s?.blocked, md).toBe(true);
      expect(scan.diagnostics.map((d) => d.code)).toContain("NODE_BINDING_ORPHAN");
      expect(JSON.stringify(s?.nodes)).not.toContain('"to":3');
    }
  });

  it("leaves a Task's own refs alone", () => {
    const md = lines(
      "## Launch",
      start,
      "- [ ] Prepare contract",
      `  ${ref(2)}`,
      `- [ ] Inline ${ref(3)}`,
      end,
    );
    const scan = parseSections(md);
    expect(scan.sections[0]?.blocked).toBe(false);
    expect(shape(scan.sections[0]?.nodes ?? [])).toEqual(["task:002", "task:003"]);
  });
});
