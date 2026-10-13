// A cut Task pasted under a Task typed in the same pass (no binding yet):
// the restore goes in that batch, the placement under the new parent once
// it is bound. The peer-structure property test found the placement never
// sent: the base took the note's place, the model kept the old one (seed 38).

import { describe, expect, it } from "vitest";
import { block, lines, reconnect, taskId, twoVaults } from "../../support/section-vaults";

describe("a cut Task pasted under a new Task", () => {
  it("ends up under it in the model and in the other vault", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] b2",
      "- [ ] Gamma",
      "",
      "A paragraph.",
    ]);
    const md = b.note();
    const b2 = taskId(md, "b2");
    const L = lines(md);
    const [f, t] = block(md, "b2");
    const clip = L.splice(f, t - f);
    const cut = L.join("\n");
    await b.pass(cut, { deletedIds: new Set([b2]), cut: new Set([b2]) });
    // A new Task typed after Gamma, and the cut pasted under it (nested), in one pass.
    const M = lines(cut);
    const end = block(cut, "Gamma")[1];
    M.splice(end, 0, "- [ ] b4", ...clip.map((l) => `\t${l}`));
    await b.pass(M.join("\n"), { inserted: new Set([b2]), cut: new Set([b2]) });
    await b.pass(b.note());
    const b4 = taskId(b.note(), "b4");
    expect(b.model()?.nodes[b2]?.parent).toBe(b4);
    await reconnect(a, b);
    expect(a.note()).toMatch(/- \[ \] b4\n.*\n\s+- \[ \] b2\n/);
  });
});

describe("a cut Task pasted under a new Task after its old parent was deleted", () => {
  it("ends up under the new Task, though the model hid it under the deleted parent (seed 757)", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] b1", "  - [ ] b2", "", "A paragraph."]);
    const md = b.note();
    const b2 = taskId(md, "b2");
    const b1 = taskId(md, "b1");
    const L = lines(md);
    const [f, t] = block(md, "b2");
    const clip = L.splice(f, t - f).map((l) => l.replace(/^ {2}/, ""));
    await b.pass(L.join("\n"), { deletedIds: new Set([b2]), cut: new Set([b2]) });
    const M = lines(b.note());
    const [g, u] = block(b.note(), "b1");
    M.splice(g, u - g);
    await b.pass(M.join("\n"), { deletedIds: new Set([b1]) });
    const N = lines(b.note());
    N.splice(block(b.note(), "Alpha")[1], 0, "- [ ] b3", ...clip.map((l) => `\t${l}`));
    await b.pass(N.join("\n"), { inserted: new Set([b2]), cut: new Set([b2]) });
    await b.pass(b.note());
    const b3Line = lines(b.note()).indexOf("- [ ] b3");
    const b3 = /#task:([0-9a-f-]{36})/.exec(lines(b.note())[b3Line + 1] ?? "")?.[1];
    expect(b.model()?.nodes[b2]?.parent).toBe(b3);
    await reconnect(a, b);
    expect(a.note()).toMatch(/- \[ \] b3\n.*\n\s+- \[ \] b2\n/);
  });
});
