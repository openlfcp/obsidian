// LFCP-02-063: readable copy removes LFCP metadata only; shared copy keeps
// the whole projection with its bindings (unit evidence; the native spec
// inspects the actual clipboard).

import { describe, expect, it } from "vitest";
import { readableText, sharedSectionText } from "../../../src/core/sections/clipboard";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";

const ref = {
  resourceId: new Uint8Array(32).fill(5),
  sectionId: "0192e4a0-0000-7000-8000-000000000001",
};
const R = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU";
const md = [
  "Private **intro**.",
  "",
  "## Launch",
  formatBoundary("start", ref),
  "- [ ] Prepare contract 📅 2026-10-20",
  `  <!-- lfcp-ref: lfcp1:${R}#task:0192e4a0-0000-7000-8000-000000000002 -->`,
  `- [ ] Inline task <!-- lfcp-ref: lfcp1:${R}#task:0192e4a0-0000-7000-8000-000000000003 --> ⏫`,
  "",
  formatNodeMarker("paragraph", "0192e4a0-0000-7000-8000-000000000004"),
  "Draft the *plan*.",
  formatBoundary("end", ref),
  "",
  "Private outro.",
  "",
].join("\n");

describe("copying (063)", () => {
  it("readable text: only LFCP metadata goes; private text and formatting stay", () => {
    expect(readableText(md)).toBe(
      [
        "Private **intro**.",
        "",
        "## Launch",
        "- [ ] Prepare contract 📅 2026-10-20",
        "- [ ] Inline task ⏫",
        "",
        "Draft the *plan*.",
        "",
        "Private outro.",
        "",
      ].join("\n"),
    );
  });

  it("readable text of a partial selection keeps CRLF and partial lines", () => {
    expect(readableText("one\r\n<!-- lfcp-node: paragraph:x -->\r\ntw")).toBe("one\r\ntw");
  });

  it("shared section: the whole projection with every binding, nothing around it", () => {
    const shared = sharedSectionText(md, 9) as string;
    expect(shared.startsWith("## Launch\n<!-- lfcp-section: ")).toBe(true);
    expect(shared).toContain("lfcp-ref:");
    expect(shared).toContain("lfcp-node: paragraph:");
    expect(shared.trimEnd().endsWith("-->")).toBe(true);
    expect(shared).not.toContain("Private");
    expect(sharedSectionText(md, 0)).toBeNull();
  });
});
