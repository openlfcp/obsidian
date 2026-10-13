// A pass that projects a remote deletion next to remote moves (structure.ts
// over remote.ts, composed by engine.ts composeChanges): the 5000-seed
// interleavings sweep found B's note rewritten with overlapping changes.

import { describe, expect, it } from "vitest";
import { block, lines, reconnect, taskId, twoVaults } from "../../support/section-vaults";

describe("a remote deletion next to remote moves (the 5000-seed sweep, seed 2974)", () => {
  it("Alpha moved below Gamma, x deleted and planb moved above draft render whole in B", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "- [ ] x",
      "- [ ] draft",
      "- [ ] planb",
      "",
      "Clean paragraph.",
    ]);
    const md = a.note();
    const L = lines(md);
    const take = (t: string) => {
      const [f, to] = block(L.join("\n"), t);
      return L.splice(f, to - f);
    };
    const x = taskId(md, "x");
    const alpha = take("Alpha");
    L.splice(block(L.join("\n"), "Gamma")[1], 0, ...alpha);
    take("x");
    const planb = take("planb");
    L.splice(block(L.join("\n"), "draft")[0], 0, ...planb);
    await a.pass(L.join("\n"), { deletedIds: new Set([x]), cut: new Set([x]) });
    await reconnect(a, b);
    // B's note was rewritten with overlapping changes: a stray "… -->" line,
    // Alpha gone, a ref twice.
    expect(b.note()).toBe(a.note());
    expect(lines(b.note()).filter((l) => l.startsWith("- [ ]"))).toEqual([
      "- [ ] Beta",
      "- [ ] Gamma",
      "- [ ] Alpha",
      "- [ ] planb",
      "- [ ] draft",
    ]);
  });
});
