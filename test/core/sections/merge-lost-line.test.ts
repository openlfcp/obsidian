// LFCP-03-057 (obsidian#63): Obsidian merges two views of one note and the
// note comes back without a line (Task) the user never touched. The engine
// cannot tell that from the host's doing, so it is NODE_BINDING_LOST: the
// node is not deleted (the model and a collaborator keep it), the pass is
// blocked, and the badge says ATTENTION. These tests pin what is sent.

import { describe, expect, it } from "vitest";
import { cut, taskId, twoVaults } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta"];

describe("a line missing from the note without the user's deletion", () => {
  it("is not deleted for the others: the model and the peer keep it, the pass reports it lost", async () => {
    const { a, b } = await twoVaults(BODY);
    const delta = taskId(a.note(), "Delta");
    // The merge's result: the note without Delta, and no deletion recorded by the editor.
    const merged = cut(a.note(), "Delta");
    const r = await a.pass(merged, { deletedIds: new Set() });
    expect(r?.lost).toEqual([delta]);
    expect(a.model()?.nodes[delta]?.lifecycle).toBe("active");
    for (const rb of b.replicas.values()) rb.receiveChanges(a.replica().changes());
    expect(b.model()?.nodes[delta]?.lifecycle).toBe("active");
  });
});
