// Serializer edits: indentation, line endings, detach (MARKDOWN-REFS-01 §12, §18).

import { describe, expect, it } from "vitest";
import {
  attachRef,
  detachRef,
  formatRefComment,
  type MarkdownProjectionRef,
  type ObjectRef,
  scanRefs,
} from "../../../src/core/refs";

const REF: ObjectRef = {
  resourceId: new Uint8Array(32).fill(7),
  objectType: "task",
  objectId: "019a2f85-7b31-7c42-b85a-fc843e2f40ad",
};
const C = formatRefComment(REF);
const first = (text: string) => scanRefs(text).projections[0] as MarkdownProjectionRef;

describe("serializer", () => {
  it("emits the canonical comment (§6)", () => {
    expect(C).toBe(
      "<!-- lfcp-ref: lfcp1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc#task:019a2f85-7b31-7c42-b85a-fc843e2f40ad -->",
    );
    expect(first(`- [ ] T ${C}\n`).canonical).toBe(true);
  });

  it("indents child lines to the Task's content column (§12)", () => {
    expect(attachRef("1. [ ] Ordered\n", 0, REF)).toBe(`1. [ ] Ordered\n   ${C}\n`);
    expect(attachRef("- [ ] P\n    - [ ] Nested\n", 1, REF)).toBe(
      `- [ ] P\n    - [ ] Nested\n      ${C}\n`,
    );
    expect(attachRef("- [ ] P\n\t- [ ] Tab\n", 1, REF)).toBe(`- [ ] P\n\t- [ ] Tab\n\t  ${C}\n`);
  });

  it("keeps line endings (CRLF, CR, none at the end)", () => {
    expect(attachRef("- [ ] A\r\n- [ ] B\r\n", 0, REF)).toBe(`- [ ] A\r\n  ${C}\r\n- [ ] B\r\n`);
    expect(attachRef("x\r\n- [ ] Last", 1, REF)).toBe(`x\r\n- [ ] Last\r\n  ${C}`);
    expect(attachRef("- [ ] A\r", 0, REF, "inline")).toBe(`- [ ] A ${C}\r`);
  });

  it("detaches either placement and leaves the rest byte-identical (§18)", () => {
    const child = `before\r\n- [x] Done\r\n  ${C}\r\nafter`;
    expect(detachRef(child, first(child))).toBe("before\r\n- [x] Done\r\nafter");
    const inline = `- [x] Done  ${C}\n`;
    expect(detachRef(inline, first(inline))).toBe("- [x] Done\n");
    const last = `- [x] Done\n  ${C}`;
    expect(detachRef(last, first(last))).toBe("- [x] Done");
  });

  it("round-trips attach and detach", () => {
    for (const placement of ["child-line", "inline"] as const) {
      const text = "intro\n- [ ] Task\nouttro\n";
      const attached = attachRef(text, 1, REF, placement);
      expect(detachRef(attached, first(attached))).toBe(text);
    }
  });
});
