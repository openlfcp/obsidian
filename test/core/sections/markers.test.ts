// Bindings for new nodes (LFCP-02-039's projected step): written where the
// parser reads them, the Text unchanged, every line ending kept.

import { fromBase64url } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { markdownState } from "../../../src/core/sections/base";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { bindingChanges, type NewBinding } from "../../../src/core/sections/markers";
import { parseSections } from "../../../src/core/sections/parser";
import type { DocChange } from "../../../src/core/sections/source-map";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;

const apply = (md: string, changes: readonly DocChange[]) =>
  [...changes].reverse().reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), md);

const section = (md: string) => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return s;
};

/** The new nodes of a note's section, with IDs from `next` on. */
function bindAll(md: string, next = 100) {
  const s = section(md);
  const { unbound } = markdownState(md, s);
  const bindings: NewBinding[] = unbound.map((u, k) => ({
    line: u.line,
    kind: u.kind,
    id: id(next + k),
  }));
  return { s, unbound, bindings, ...bindingChanges(md, s, bindings, fromBase64url(R)) };
}

/**
 * Binds pass by pass (a new node's new children bind once it has an ID),
 * checking each pass: no new diagnostics, every node bound to its ID with
 * the same Text.
 */
function check(md: string) {
  let out = md;
  let next = 100;
  for (let pass = 0; pass < 5; pass++) {
    const { unbound, bindings, changes, missed } = bindAll(out, next);
    if (unbound.length === 0) break;
    expect(missed).toEqual([]);
    out = apply(out, changes);
    next += bindings.length;
    const scan = parseSections(out);
    expect(scan.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const after = markdownState(out, section(out));
    for (const [k, u] of unbound.entries()) {
      const n = after.state.nodes[bindings[k]?.id as string];
      expect(n?.kind).toBe(u.kind);
      expect(n?.text).toBe(u.text);
    }
  }
  expect(markdownState(out, section(out)).unbound).toEqual([]);
  return out;
}

const note = (body: string[], eol = "\n") =>
  ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join(eol);

describe("bindingChanges", () => {
  it("binds a paragraph, a raw block, an item and a Task where the parser reads them", () => {
    const out = check(
      note([
        "Intro text",
        "spanning two lines",
        "",
        "```js",
        "x()",
        "```",
        "",
        "- An item",
        "",
        "- [ ] A task",
      ]),
    );
    expect(out).toBe(
      note([
        `<!-- lfcp-node: paragraph:${id(100)} -->`,
        "Intro text",
        "spanning two lines",
        "",
        `<!-- lfcp-node: raw:${id(101)} -->`,
        "```js",
        "x()",
        "```",
        "",
        "- An item",
        `  <!-- lfcp-node: item:${id(102)} -->`,
        "",
        "- [ ] A task",
        `  <!-- lfcp-ref: lfcp1:${R}#task:${id(103)} -->`,
      ]),
    );
  });

  it("puts an item's marker after its continuation lines, before its children", () => {
    check(note(["- Item text", "  goes on", "  - Child"]));
  });

  it("keeps CRLF and tab indentation (M2)", () => {
    const md = note(
      ["- [ ] Parent", "\t- [ ] Tab child", "\tA lazy line?", "", "\tIndented para"],
      "\r\n",
    );
    const out = check(md);
    expect(out.split("\r\n").length).toBe(out.split("\n").length);
  });

  it("binds nested Tasks at their own content column", () => {
    const out = check(note(["1. [ ] Ordered task", "   - [ ] Nested task"]));
    expect(out).toContain(`\n   <!-- lfcp-ref: lfcp1:${R}#task:${id(100)} -->\n`);
    expect(out).toContain(`\n     <!-- lfcp-ref: lfcp1:${R}#task:${id(101)} -->\n`);
  });

  it("reports a binding whose node is no longer there unbound", () => {
    const md = note(["Para"]);
    const s = section(md);
    const gone: NewBinding = { line: 9, kind: "paragraph", id: id(100) };
    const wrongKind: NewBinding = { line: 2, kind: "item", id: id(101) };
    const r = bindingChanges(md, s, [gone, wrongKind], fromBase64url(R));
    expect(r.changes).toEqual([]);
    expect(r.missed).toEqual([gone, wrongKind]);
  });
});
