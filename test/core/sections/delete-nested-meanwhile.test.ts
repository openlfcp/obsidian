// A Task cut while a collaborator nests another one under it. The cut's
// pass comes after the nesting arrived: the deletion is not concurrent with
// it (nothing for Review conflicts), and the nested Task, still where this
// note shows it, was hidden with its deleted parent in both notes. The
// peer-structure property test found it (seed 406).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { indentWithNode } from "../../../src/core/sections/line-moves";
import { block, lines, reconnect, taskId, twoVaults } from "../../support/section-vaults";

const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

describe("a Task nested under one the peer cut meanwhile", () => {
  it("stays where the cutting note shows it, in both notes", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] b2", "- [ ] a1", "", "A paragraph."]);
    const a1 = taskId(a.note(), "a1");
    const b2 = taskId(a.note(), "b2");
    // B cuts b2; its pass has not run yet.
    const L = lines(b.note());
    const [f, t] = block(b.note(), "b2");
    L.splice(f, t - f);
    const cut = L.join("\n");
    // A nests a1 under b2 (Tab); B gets it before its pass.
    const md = a.note();
    const at = offset(md, block(md, "a1")[0]);
    const tab = { from: at, to: at, insert: "\t" };
    await a.pass(applyChanges(md, indentWithNode(md, [tab]) ?? [tab]));
    for (const [res, ra] of a.replicas) b.replicas.get(res)?.receiveChanges(ra.changes());
    const r = await b.pass(cut, { deletedIds: new Set([b2]), cut: new Set([b2]) });
    expect(r?.local?.kind).toBe("committed");
    expect(b.model()?.nodes[b2]?.lifecycle).toBe("deleted");
    expect(b.model()?.nodes[a1]).toMatchObject({ parent: null, lifecycle: "active" });
    expect(b.model()?.nodes[a1]?.hidden).toBeUndefined();
    await reconnect(a, b);
    for (const v of [a, b])
      expect(lines(v.note()).filter((l) => /^\s*- \[ \]/.test(l))).toEqual([
        "- [ ] Alpha",
        expect.stringMatching(/^- \[ \] a1/),
      ]);
  });
});
