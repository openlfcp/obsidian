// A remote move of a node out of its parent, rendered (structure.ts): the
// peer-structure property test found the moved Task's line losing its list
// marker (" [ ] b1") when its new place, right after the old parent's
// subtree, fell inside its own removed lines (seed 3).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { indentWithNode } from "../../../src/core/sections/line-moves";
import { block, lines, reconnect, twoVaults } from "../../support/section-vaults";

const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

describe("a Task moved out of its parent by the peer", () => {
  it("renders whole in the other vault: its line keeps its list marker", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "",
      "A paragraph.",
    ]);
    // B adds b1 after Gamma, nests it under Gamma (Tab), then not (Shift+Tab).
    const L = lines(b.note());
    L.splice(block(b.note(), "Gamma")[1], 0, "- [ ] b1");
    await b.pass(L.join("\n"));
    await b.pass(b.note());
    await reconnect(a, b);
    const at = block(b.note(), "b1")[0];
    const tab = { from: offset(b.note(), at), to: offset(b.note(), at), insert: "\t" };
    await b.pass(applyChanges(b.note(), indentWithNode(b.note(), [tab]) ?? [tab]));
    await reconnect(a, b);
    expect(a.note()).toMatch(/\n\s+- \[ \] b1\n/);
    // A's own layout: a blank line after b1, before the paragraph (local, not shared).
    await a.pass(a.note().replace("\n<!-- lfcp-node: paragraph", "\n\n<!-- lfcp-node: paragraph"));
    expect(a.note()).toMatch(/b1\n.*-->\n\n<!-- lfcp-node/);
    const nested = b.note();
    const n = block(nested, "b1")[0];
    const dedent = { from: offset(nested, n), to: offset(nested, n) + 1, insert: "" };
    await b.pass(applyChanges(nested, indentWithNode(nested, [dedent]) ?? [dedent]));
    await reconnect(a, b);
    expect(lines(a.note()).filter((l) => l.includes("b1"))).toEqual(["- [ ] b1"]);
    expect(lines(a.note()).filter((l) => /^\s*\[ \]/.test(l))).toEqual([]);
  });
});

describe("a child moved out of its parent and the parent moved, in one update", () => {
  it("renders whole: no line twice, none cut (the peer-structure test, seed 666)", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] P",
      "  - [ ] c",
      "- [ ] X",
      "",
      "A paragraph.",
    ]);
    // B: c out of P, after Alpha; P after X (one pass, both moves).
    const L = lines(b.note());
    const [cf, ct] = block(b.note(), "c");
    const c = L.splice(cf, ct - cf).map((l) => l.slice(2));
    const note1 = L.join("\n");
    const M = lines(note1);
    const [pf, pt] = block(note1, "P");
    const p = M.splice(pf, pt - pf);
    M.splice(block(M.join("\n"), "X")[1], 0, ...p);
    M.splice(block(M.join("\n"), "Alpha")[1], 0, ...c);
    await b.pass(M.join("\n"));
    await reconnect(a, b);
    await reconnect(a, b);
    const refs = lines(a.note()).flatMap((l) => /#task:([0-9a-f-]{36})/.exec(l)?.[1] ?? []);
    expect(new Set(refs).size).toBe(refs.length);
    expect(lines(a.note()).filter((l) => /\[ \]/.test(l))).toEqual([
      "- [ ] Alpha",
      "- [ ] c",
      "- [ ] X",
      "- [ ] P",
    ]);
    expect(a.note()).toBe(b.note());
  });
});
