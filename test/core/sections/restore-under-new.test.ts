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
