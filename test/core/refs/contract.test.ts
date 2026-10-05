// MARKDOWN-REFS-01 §29: the LFCP-060 acceptance contract, one test per item,
// each naming the golden fixture or behavior that proves it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attachRef,
  checkObjectType,
  detachRef,
  formatRefComment,
  type MarkdownProjectionRef,
  type ObjectRef,
  replaceTaskText,
  sameBinding,
  scanRefs,
} from "../../../src/core/refs";
import { DEFAULT_SETTINGS } from "../../../src/core/settings";

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/refs/${name}.md`, import.meta.url), "utf8");
const only = (text: string): MarkdownProjectionRef => {
  const { projections } = scanRefs(text);
  expect(projections).toHaveLength(1);
  return projections[0] as MarkdownProjectionRef;
};
const codes = (text: string) => scanRefs(text).diagnostics.map((d) => d.code);

const OBJECT = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
const REF: ObjectRef = {
  resourceId: Uint8Array.from({ length: 32 }, (_, i) => i),
  objectType: "task",
  objectId: OBJECT,
};

describe("MR§29 LFCP-060 acceptance contract", () => {
  it("1. parses a valid inline top-level Task ref", () => {
    const p = only(fixture("inline-top-level"));
    expect([p.placement, p.taskLine, p.refLine]).toEqual(["inline", 0, 0]);
  });

  it("2. parses a valid child-line top-level Task ref", () => {
    const p = only(fixture("child-top-level"));
    expect([p.placement, p.taskLine, p.refLine]).toEqual(["child", 0, 1]);
  });

  it("3. parses a valid nested child-line Task ref (spaces and tabs)", () => {
    const { projections } = scanRefs(fixture("nested-child"));
    expect(projections.map((p) => [p.taskLine, p.refLine])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("4. parses ordered-list Task refs (1. and 1))", () => {
    expect(scanRefs(fixture("ordered-list")).projections).toHaveLength(3);
  });

  it("5. normalizes both forms to the same (resource, type, id) binding", () => {
    const [inline, child] = scanRefs(fixture("both-placements-same-binding")).projections;
    expect(inline?.placement).toBe("inline");
    expect(child?.placement).toBe("child");
    expect(inline && child && sameBinding(inline, child)).toBe(true);
  });

  it("6. rejects malformed Resource encoding", () => {
    expect(codes(fixture("malformed-resource"))).toEqual(Array(5).fill("RESOURCE_ID_INVALID"));
  });

  it("7. rejects malformed Object IDs", () => {
    expect(codes(fixture("malformed-object-id"))).toEqual(Array(3).fill("OBJECT_ID_INVALID"));
  });

  it("8. reports two child refs as duplicate", () => {
    expect(codes(fixture("duplicate-two-child"))).toEqual([
      "DUPLICATE_LFCP_REF",
      "DUPLICATE_LFCP_REF",
    ]);
    expect(scanRefs(fixture("duplicate-two-child")).projections).toEqual([]);
  });

  it("9. reports inline + child refs as duplicate, even when identical", () => {
    expect(codes(fixture("duplicate-inline-and-child"))).toEqual([
      "DUPLICATE_LFCP_REF",
      "DUPLICATE_LFCP_REF",
    ]);
  });

  it("10. reports orphan child refs", () => {
    expect(codes(fixture("orphans"))).toEqual(Array(6).fill("ORPHAN_LFCP_REF"));
  });

  it("11. ignores examples inside fenced code blocks", () => {
    const scan = scanRefs(fixture("fenced-code"));
    expect(scan.projections.map((p) => p.taskText)).toEqual(["Real task"]);
    expect(scan.diagnostics).toEqual([]);
  });

  it("12. distinguishes a missing ref (local) from a malformed one (blocked)", () => {
    const tasks = scanRefs(fixture("missing-vs-malformed")).tasks;
    expect(tasks.map((t) => t.binding)).toEqual(["local", "blocked", "bound"]);
  });

  it("13. keeps Task semantic content separate from inline metadata", () => {
    const p = only(fixture("inline-top-level"));
    expect(p.taskText).toBe("Prepare API contract");
    expect(p.taskText).not.toContain("lfcp-ref");
  });

  it("14. preserves an existing valid placement during unrelated rewrites", () => {
    for (const name of ["inline-top-level", "child-top-level", "crlf"]) {
      const text = fixture(name);
      for (const p of scanRefs(text).projections) {
        const rewritten = replaceTaskText(text, p, "Renamed task");
        const again = scanRefs(rewritten).projections.find((q) => q.taskLine === p.taskLine);
        expect(again?.placement, name).toBe(p.placement);
        expect(again?.comment.text, name).toBe(p.comment.text);
        expect(again?.taskText, name).toBe("Renamed task");
      }
    }
  });

  it("15. serializer emits the child-line form", () => {
    const out = attachRef("- [ ] Task\n", 0, REF, "child-line");
    expect(out).toBe(`- [ ] Task\n  ${formatRefComment(REF)}\n`);
    expect(only(out).placement).toBe("child");
  });

  it("16. serializer emits the inline form when requested", () => {
    const out = attachRef("- [ ] Task\n", 0, REF, "inline");
    expect(out).toBe(`- [ ] Task ${formatRefComment(REF)}\n`);
    expect(only(out).placement).toBe("inline");
  });

  it("17. the Obsidian default emits child-line unless configured otherwise", () => {
    expect(DEFAULT_SETTINGS.refPlacement).toBe("child-line");
    expect(only(attachRef("- [ ] Task\n", 0, REF)).placement).toBe("child");
  });

  // Cases 18-21 were added in baseline.5 (MR-A1 to MR-A4 made normative).
  it("18. accepts extra whitespace at each separator of the ref comment (§6)", () => {
    const scan = scanRefs(fixture("spacing"));
    expect(scan.projections.map((p) => [p.taskLine, p.canonical])).toEqual([
      [0, false],
      [4, false],
    ]);
    expect(codes(fixture("spacing"))).toEqual(Array(4).fill("MALFORMED_LFCP_REF"));
  });

  it("19. reports a well-formed unsupported type as OBJECT_TYPE_UNSUPPORTED, not malformed", () => {
    const scan = scanRefs(fixture("object-types"));
    expect(scan.diagnostics[0]?.code).toBe("OBJECT_TYPE_UNSUPPORTED");
    expect(scan.diagnostics.slice(1).every((d) => d.code === "MALFORMED_LFCP_REF")).toBe(true);
    expect(scan.projections).toEqual([]);
  });

  it("20. reports a ref separated from its Task by a blank or other line as an orphan", () => {
    const scan = scanRefs(fixture("orphans"));
    expect(scan.diagnostics.filter((d) => d.code === "ORPHAN_LFCP_REF").length).toBeGreaterThan(1);
    expect(scan.projections).toEqual([]);
  });

  it("21. reports DUPLICATE and the malformed ref's own code, and binds nothing", () => {
    for (const [name, own] of [
      ["duplicate-with-malformed-shape", "MALFORMED_LFCP_REF"],
      ["duplicate-with-malformed", "RESOURCE_ID_INVALID"],
    ] as const) {
      const scan = scanRefs(fixture(name));
      const got = scan.diagnostics.map((d) => d.code);
      expect(
        got.filter((c) => c === "DUPLICATE_LFCP_REF"),
        name,
      ).toHaveLength(2);
      expect(got, name).toContain(own);
      expect(scan.projections, name).toEqual([]);
      expect(
        scan.tasks.map((t) => t.binding),
        name,
      ).toEqual(["blocked"]);
    }
  });
});

describe("beyond §29", () => {
  it("binding is independent of file name or path (§23): the scanner takes text only", () => {
    const text = fixture("child-top-level");
    expect(scanRefs.length).toBe(1);
    expect(scanRefs(text)).toEqual(scanRefs(`${text}`));
  });

  it("a ref carries no endpoint (§24): server URLs are malformed, canonical refs have none", () => {
    expect(codes(fixture("endpoint-in-ref"))).toEqual(Array(3).fill("MALFORMED_LFCP_REF"));
    expect(formatRefComment(REF)).not.toMatch(/wss?:\/\//);
  });

  it("type mismatch with the Shared Object is reported, never repaired (§9)", () => {
    expect(checkObjectType(REF, "task")).toBeUndefined();
    expect(checkObjectType(REF, "org.example.poll")).toBe("OBJECT_TYPE_MISMATCH");
  });

  it("blocked Tasks are neither bound nor local (duplicate, malformed, misplaced, unsupported)", () => {
    for (const name of [
      "duplicate-two-inline",
      "duplicate-with-malformed",
      "metadata-after-inline",
      "object-types",
    ]) {
      const scan = scanRefs(fixture(name));
      expect(scan.projections, name).toEqual([]);
      expect(new Set(scan.tasks.map((t) => t.binding)), name).toEqual(new Set(["blocked"]));
    }
  });

  it("blockquoted refs are diagnosed, not silently ignored", () => {
    expect(codes(fixture("blockquote"))).toEqual([
      "LFCP_REF_UNSUPPORTED_CONTEXT",
      "LFCP_REF_UNSUPPORTED_CONTEXT",
    ]);
  });

  it("refuses to attach to a Task that already has a ref, or to a non-Task line", () => {
    expect(() => attachRef(fixture("child-top-level"), 0, REF)).toThrow(/already has a ref/);
    expect(() => attachRef(fixture("missing-vs-malformed"), 1, REF)).toThrow(/already has a ref/);
    expect(() => attachRef("Paragraph\n", 0, REF)).toThrow(/not a Task line/);
  });
});
