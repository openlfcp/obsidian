// A bound Task the note shows and the projection's base does not know,
// while the model has it active. The peer-structure property test reached
// it in seed 346: a Task cut (its deletion sent), pasted under another while
// the section waited for Review conflicts (MS14: nothing sent), then kept,
// back where a collaborator had moved it. Neither a local edit (no base) nor
// a remote change (the note has it), the note and the model stayed apart on
// every pass. The base takes the Task as the note shows it, and its place
// there, the user's paste, is sent when it is not the model's.

import { describe, expect, it } from "vitest";
import { markdownState } from "../../../src/core/sections/base";
import { parseSections } from "../../../src/core/sections/parser";
import {
  block,
  lines,
  PATH,
  reconnect,
  taskId,
  twoVaults,
  type Vault,
} from "../../support/section-vaults";

const parentIn = (md: string, id: string) => {
  const section = parseSections(md).sections[0];
  if (section === undefined) throw new Error("no section");
  return markdownState(md, section).state.nodes[id]?.parent;
};

/** `v`'s stored base without `id`, as if this projection never had it. */
async function forget(v: Vault, id: string) {
  const [projection] = await v.bases.projectionsOf(PATH);
  const stored = await v.bases.load(projection as string);
  if (stored === undefined) throw new Error("no base");
  const nodes = { ...stored.state.nodes };
  delete nodes[id];
  const order = Object.fromEntries(
    Object.entries(stored.state.order).map(([k, ids]) => [k, ids.filter((x) => x !== id)]),
  );
  await v.bases.save(projection as string, { ...stored, state: { ...stored.state, nodes, order } });
}

describe("a Task the note shows and its base does not know, active in the model", () => {
  it("shown elsewhere than the model's place: that place is sent, both notes follow", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] a1", "- [ ] a2", "", "A paragraph."]);
    const a1 = taskId(a.note(), "a1");
    const a2 = taskId(a.note(), "a2");
    await forget(a, a1);
    // A's note has a1 under a2.
    const L = lines(a.note());
    const [f, t] = block(a.note(), "a1");
    const moved = L.splice(f, t - f).map((l) => `  ${l}`);
    L.splice(block(L.join("\n"), "a2")[1], 0, ...moved);
    const r = await a.pass(L.join("\n"));
    expect(r?.local?.kind).toBe("committed");
    expect(a.model()?.nodes[a1]?.parent).toBe(a2);
    await reconnect(a, b);
    for (const v of [a, b]) expect(parentIn(v.note(), a1)).toBe(a2);
    expect(b.model()?.nodes[a1]?.parent).toBe(a2);
  });

  it("shown where the model has it: nothing is sent, the base takes it", async () => {
    const { a } = await twoVaults(["- [ ] Alpha", "- [ ] a1", "- [ ] a2", "", "A paragraph."]);
    const a1 = taskId(a.note(), "a1");
    await forget(a, a1);
    const r = await a.pass(a.note());
    expect(r?.local?.kind).toBe("nothing");
    const [projection] = await a.bases.projectionsOf(PATH);
    expect((await a.bases.load(projection as string))?.state.nodes[a1]).toBeDefined();
  });
});
