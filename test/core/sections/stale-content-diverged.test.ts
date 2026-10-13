// A remote change that waits for "the user's edit" that nothing sends is a
// divergence the badge must show (after sweep seed 4839, where a Task line
// taken as edited for its indentation alone kept a collaborator's title out
// of the note for good, the section CURRENT). The remote planner defers it
// as "local-edit"; when this pass committed nothing for that node, the
// coalescer holds nothing for it and it is not held, the pass reports it as
// diverged. Here the stale base line is made by hand (trailing spaces the
// field planner reads as the same Task): the seam for a disagreement the
// planners no longer have.

import { describe, expect, it } from "vitest";
import type { NodeState } from "../../../src/core/sections/base";
import { PATH, reconnect, taskId, twoVaults, type Vault } from "../../support/section-vaults";

/** B's base line of `id` made to differ from its note line without a field changing. */
async function staleBaseLine(b: Vault, id: string) {
  const pid = (await b.bases.projectionsOf(PATH))[0] as string;
  const base = await b.bases.load(pid);
  const n: NodeState | undefined = base?.state.nodes[id];
  if (base === undefined || n?.line === undefined) throw new Error("no base line");
  await b.bases.save(pid, {
    ...base,
    state: { ...base.state, nodes: { ...base.state.nodes, [id]: { ...n, line: `${n.line}  ` } } },
  });
}

describe("a remote change held for an edit nothing sends", () => {
  it("is reported as diverged, not current", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] a1"]);
    const id = taskId(b.note(), "a1");
    await staleBaseLine(b, id);
    await a.pass(a.note().replace("- [ ] a1", "- [ ] a1 edited"));
    const ra = a.replica();
    const rb = b.replica();
    const fromA = ra.changes();
    ra.receiveChanges(rb.changes());
    rb.receiveChanges(fromA);
    const res = await b.pass(b.note());
    expect(b.note()).toContain("- [ ] a1\n");
    expect(res?.diverged).toContain(id);
  });

  it("an ordinary remote change is rendered, nothing diverged", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] a1"]);
    await a.pass(a.note().replace("- [ ] a1", "- [ ] a1 edited"));
    await reconnect(a, b);
    const res = await b.pass(b.note());
    expect(b.note()).toContain("- [ ] a1 edited");
    expect(res?.diverged ?? []).toEqual([]);
  });

  it("the user's own edit, committed in the pass, is no divergence", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] a1"]);
    await a.pass(a.note().replace("- [ ] Alpha", "- [ ] Alpha edited"));
    const ra = a.replica();
    const rb = b.replica();
    const fromA = ra.changes();
    ra.receiveChanges(rb.changes());
    rb.receiveChanges(fromA);
    const res = await b.pass(b.note().replace("- [ ] a1", "- [ ] a1 by B"));
    expect(res?.local?.kind).toBe("committed");
    expect(res?.diverged ?? []).toEqual([]);
  });
});
