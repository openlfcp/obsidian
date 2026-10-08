// LFCP-02-049: the exact range and preflight of "Share section…"
// (OBSIDIAN-SHARED-SECTIONS-UX-01 §3; UX01, UX02, UX05, UX13 with private
// canaries; MS36).

import { describe, expect, it } from "vitest";
import { parseSections } from "../../../src/core/sections/parser";
import {
  preflight,
  proposeRange,
  revalidate,
  sectionPreview,
} from "../../../src/core/sections/share";

const BEFORE = "PRIVATE_BEFORE_8f3a: budget and personal thoughts.";
const AFTER = "PRIVATE_AFTER_71c2: do not transmit.";
const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("the proposed range", () => {
  it("runs from a heading to the next heading of the same or a higher level, blank lines trimmed", () => {
    const md = lines(
      "Intro",
      "## Launch",
      "- [ ] One",
      "### Detail",
      "text",
      "",
      "## Next",
      "after",
    );
    expect(proposeRange(md, 1)).toEqual({ headingLine: 1, lastLine: 4 });
    expect(proposeRange(md, 6)).toEqual({ headingLine: 6, lastLine: 7 });
    expect(proposeRange(md, 0)).toBeNull();
  });
});

describe("preflight", () => {
  it("UX01: 200 Tasks with child notes in one preview, every child text in it, canaries outside", () => {
    const body: string[] = [];
    for (let i = 0; i < 200; i++) body.push(`- [ ] Task ${i}`, `  Note for task ${i}`);
    const md = lines(BEFORE, "", "## Launch", ...body, "", "## Other", AFTER);
    const range = proposeRange(md, 2);
    if (range === null) throw new Error("no range");
    const p = preflight(md, range);
    expect(p.problems).toEqual([]);
    expect(p.title).toBe("Launch");
    expect(p.counts).toMatchObject({ tasks: 200, items: 0 });
    expect(p.content).toContain("Note for task 199");
    expect(p.content).not.toContain(BEFORE);
    expect(p.content).not.toContain(AFTER);
    expect(p.warnings).toContain("future-additions");
  });

  it("estimates the import's changes from the authoring budgets (SSP §16.3: 40,000 characters take five)", () => {
    const para = "x".repeat(199);
    const body: string[] = [];
    for (let i = 0; i < 200; i++) body.push(`- [ ] T${i}`, "", para, "");
    const md = lines("## Big", ...body);
    const range = proposeRange(md, 0);
    if (range === null) throw new Error("no range");
    expect(preflight(md, range).changes).toBe(5);
  });

  it("UX05: an earlier end leaves the rest under the heading private, and says so", () => {
    const md = lines(
      "## Launch",
      "- [ ] Shared",
      "",
      "Looks the same but is private.",
      "",
      "## Next",
    );
    const p = preflight(md, { headingLine: 0, lastLine: 1 });
    expect(p.problems).toEqual([]);
    expect(p.content).toBe("- [ ] Shared");
    expect(p.privateTail).toBe("Looks the same but is private.");
    expect(p.warnings).toContain("private-text-before-next-heading");
  });

  it("refuses a heading inside (offering a split), a cut block, an unclosed fence", () => {
    const nested = lines("## Launch", "- [ ] One", "### Inside", "text");
    expect(preflight(nested, { headingLine: 0, lastLine: 3 }).problems).toEqual([
      { code: "NESTED_HEADING", line: 2 },
    ]);
    // A range that ends on a blank line ends on a block boundary.
    expect(
      preflight(lines("## Launch", "One", "", "Two"), { headingLine: 0, lastLine: 2 }).problems,
    ).toEqual([]);
    const cut = lines("## Launch", "A paragraph", "goes on here");
    expect(preflight(cut, { headingLine: 0, lastLine: 1 }).problems).toEqual([
      { code: "PARTIAL_BLOCK", line: 2 },
    ]);
    const fence = lines("## Launch", "```js", "never closed");
    expect(preflight(fence, { headingLine: 0, lastLine: 2 }).problems.map((p) => p.code)).toContain(
      "UNCLOSED_FENCE",
    );
  });

  it("routes 0.1 shared Tasks to the import path, and refuses bindings already there", () => {
    const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
    const legacy = lines(
      "## Launch",
      "- [ ] Old shared",
      `  <!-- lfcp-ref: lfcp1:${R}#task:019a2f85-7b31-7c42-b85a-fc843e2f4002 -->`,
    );
    expect(preflight(legacy, { headingLine: 0, lastLine: 2 }).problems).toEqual([
      { code: "LEGACY_SHARED_TASKS", lines: [1] },
    ]);
    const bound = lines(
      "## Launch",
      "<!-- lfcp-node: paragraph:019a2f85-7b31-7c42-b85a-fc843e2f4003 -->",
      "Text",
    );
    expect(preflight(bound, { headingLine: 0, lastLine: 2 }).problems.map((p) => p.code)).toContain(
      "ALREADY_BOUND",
    );
  });

  it("keeps comments local and warns about them", () => {
    const md = lines("## Launch", "- [ ] One", "", "%% a private note %%");
    const p = preflight(md, { headingLine: 0, lastLine: 3 });
    expect(p.problems).toEqual([]);
    expect(p.warnings).toContain("local-comments");
  });
});

describe("revalidation (UX02)", () => {
  const md = lines("Intro", "## Launch", "- [ ] One", "", "## Next");
  const range = proposeRange(md, 1);
  if (range === null) throw new Error("no range");
  const approved = preflight(md, range);

  it("holds for the same note, and for the same content moved by an edit elsewhere", () => {
    expect(revalidate(md, approved).kind).toBe("unchanged");
    const moved = revalidate(`New first line\n${md}`, approved);
    expect(moved.kind).toBe("moved");
    if (moved.kind === "moved") expect(moved.preview.range.headingLine).toBe(2);
  });

  it("asks for a new review when the range itself changed", () => {
    const edited = revalidate(md.replace("- [ ] One", "- [ ] One, edited"), approved);
    expect(edited.kind).toBe("changed");
    expect(edited.preview?.content).toBe("- [ ] One, edited");
  });
});

describe("an existing section (MS36)", () => {
  it("warns about private text between its end marker and the next heading", () => {
    const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
    const S = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
    const md = lines(
      BEFORE,
      "",
      "## Joint launch",
      `<!-- lfcp-section: ${S} -->`,
      "Shared text",
      `<!-- /lfcp-section: ${S} -->`,
      "Private tail between the end marker and the next heading.",
      "",
      "## Next heading",
    );
    const s = parseSections(md).sections[0];
    if (s === undefined) throw new Error("no section");
    expect(sectionPreview(s)).toEqual(["private-text-before-next-heading"]);
  });
});
