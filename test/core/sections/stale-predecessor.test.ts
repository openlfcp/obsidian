// A placement after a sibling the note still shows but the model deleted
// (§6: a placement follows a visible child of its parent). The peer-structure
// property test found a pasted Task refused as INVALID_PREDECESSOR on every
// pass, its edits held as "the server refused an edit" (seed 10).

import { describe, expect, it } from "vitest";
import { block, lines, reconnect, taskId, twoVaults } from "../../support/section-vaults";

describe("a placement after a Task the peer deleted meanwhile", () => {
  it("a cut Task pasted right after it is restored after the nearest shown sibling", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "- [ ] a1",
      "- [ ] b2",
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
    // A deletes a1 meanwhile; B gets it, its note still showing a1.
    const A = lines(a.note());
    const [af, at] = block(a.note(), "a1");
    A.splice(af, at - af);
    await a.pass(A.join("\n"), { deletedIds: new Set([taskId(a.note(), "a1")]) });
    for (const [res, ra] of a.replicas) b.replicas.get(res)?.receiveChanges(ra.changes());
    // B pastes b2 back right after a1.
    const M = lines(cut);
    M.splice(block(cut, "a1")[1], 0, ...clip);
    const r = await b.pass(M.join("\n"), {
      deletedIds: new Set([b2]),
      inserted: new Set([b2]),
      cut: new Set([b2]),
    });
    expect(r?.local?.kind).toBe("committed");
    expect(b.model()?.nodes[b2]?.lifecycle).toBe("active");
    await reconnect(a, b);
    expect(lines(a.note()).filter((l) => l.startsWith("- [ ]"))).toEqual([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "- [ ] b2",
    ]);
  });

  it("a new Task typed right after it is created after the nearest shown sibling", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] a1", "", "A paragraph."]);
    const A = lines(a.note());
    const [af, at] = block(a.note(), "a1");
    A.splice(af, at - af);
    await a.pass(A.join("\n"), { deletedIds: new Set([taskId(a.note(), "a1")]) });
    for (const [res, ra] of a.replicas) b.replicas.get(res)?.receiveChanges(ra.changes());
    const M = lines(b.note());
    M.splice(block(b.note(), "a1")[1], 0, "- [ ] b9");
    const r = await b.pass(M.join("\n"));
    expect(r?.local?.kind).toBe("committed");
    await reconnect(a, b);
    expect(lines(a.note()).filter((l) => l.startsWith("- [ ]"))).toEqual([
      "- [ ] Alpha",
      "- [ ] b9",
    ]);
  });
});

describe("a placement under a Task the peer deleted meanwhile", () => {
  it("waits; the rest of the pass is sent", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] b3", "", "A paragraph."]);
    const b3 = taskId(b.note(), "b3");
    // B deletes b3; A, not knowing yet, nests a new Task under it and edits Alpha.
    const B = lines(b.note());
    const [bf, bt] = block(b.note(), "b3");
    B.splice(bf, bt - bf);
    await b.pass(B.join("\n"), { deletedIds: new Set([b3]) });
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    const A = lines(a.note());
    A.splice(block(a.note(), "b3")[1], 0, "\t- [ ] a9");
    const r = await a.pass(A.join("\n").replace("- [ ] Alpha", "- [ ] Alpha edited"));
    expect(r?.local?.kind).toBe("committed");
    await reconnect(a, b);
    expect(lines(b.note())).toContain("- [ ] Alpha edited");
  });
});

describe("a waiting placement, once its parent is back", () => {
  it("is sent: the Task typed under the deleted Task ends up under it everywhere", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] b3", "", "A paragraph."]);
    const b3 = taskId(b.note(), "b3");
    const B = lines(b.note());
    const [bf, bt] = block(b.note(), "b3");
    B.splice(bf, bt - bf);
    await b.pass(B.join("\n"), { deletedIds: new Set([b3]) });
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    const A = lines(a.note());
    A.splice(block(a.note(), "b3")[1], 0, "\t- [ ] a9");
    await a.pass(A.join("\n"));
    await a.pass(a.note());
    // b3 comes back (B restores it), and a remote change makes A's pass write.
    const restore = b.recovery();
    expect(restore).toEqual([]);
    await b.pass(b.note().replace("- [ ] Alpha", "- [ ] Alpha 2"));
    const replica = b.replica();
    replica.commit([{ intent: "node.restore", id: b3 }] as never);
    await reconnect(a, b);
    await reconnect(a, b);
    const a9 = taskId(a.note(), "a9");
    expect(a.model()?.nodes[a9]?.parent).toBe(b3);
    expect(b.note()).toMatch(/- \[ \] b3\n.*\n\s+- \[ \] a9/);
  });
});
