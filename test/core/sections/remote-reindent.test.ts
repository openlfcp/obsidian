// A remote move renders the moved subtree re-indented (structure.ts). A
// Task nested with Tab under a Task the plugin rendered with spaces has
// other leading whitespace than its parent; re-indented by stripping the
// parent's prefix, it fell to column 0 with its ref, and the copy was
// held (the peer-structure property test, seed 15).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { indentWithNode } from "../../../src/core/sections/line-moves";
import { block, lines, reconnect, twoVaults, type Vault } from "../../support/section-vaults";

const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);
/** Tab (or Shift+Tab) on the line of the Task `title` of `v`'s note, as the editor writes it. */
async function tab(v: Vault, title: string, out = false) {
  const md = v.note();
  const at = block(md, title)[0];
  const pos = offset(md, at);
  const change = out
    ? { from: pos, to: pos + 1, insert: "" }
    : { from: pos, to: pos, insert: "\t" };
  await v.pass(applyChanges(md, indentWithNode(md, [change]) ?? [change]));
}

describe("a subtree moved by the peer, re-indented", () => {
  it("keeps a Task nested with Tab under a space-indented Task nested, its ref with it", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "",
      "A paragraph.",
    ]);
    // B adds b2 and nests it under Gamma: A renders it with spaces.
    const L = lines(b.note());
    L.splice(block(b.note(), "Gamma")[1], 0, "- [ ] b2");
    await b.pass(L.join("\n"));
    await b.pass(b.note());
    await tab(b, "b2");
    await reconnect(a, b);
    expect(a.note()).toMatch(/\n {2}- \[ \] b2\n/);
    // A adds a2 after b2 and nests it under b2 with Tab.
    const M = lines(a.note());
    M.splice(block(a.note(), "b2")[1], 0, "- [ ] a2");
    await a.pass(M.join("\n"));
    await a.pass(a.note());
    await tab(a, "a2");
    await a.pass(a.note());
    expect(a.note()).toMatch(/\n\t- \[ \] a2\n\t {2}<!-- lfcp-ref: /);
    await reconnect(a, b);
    // B takes b2 out of Gamma (Shift+Tab): A moves b2's subtree, a2 included.
    await tab(b, "b2", true);
    await reconnect(a, b);
    const at = lines(a.note()).findIndex((l) => l.includes("[ ] a2"));
    expect(lines(a.note())[at]).toMatch(/^ {2}- \[ \] a2$/);
    expect(lines(a.note())[at + 1]).toMatch(/^ {4}<!-- lfcp-ref: /);
    const r = await a.pass(a.note());
    expect(r?.skipped).toBeUndefined();
  });
});
