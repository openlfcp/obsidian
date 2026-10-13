// A cut block pasted back whose child was nested by a Tab that was never
// sent (sweep seed 2998, 0.4.0-beta.15): b2 is nested under b1 in the note
// and not in the model when the b1 block is cut; the paste restores both.
// Up to 0.4.0-beta.15 b1 went where it was pasted and b2 where the model
// had it, at the section's end: the note was rewritten so. A restored node
// the note shows under another restored parent than the model's is moved
// under it.

import { expect, it } from "vitest";
import { lines, taskId, twoVaults } from "../../support/section-vaults";

const tasks = (md: string) => md.split("\n").filter((l) => /^\s*- \[.\] /.test(l));

it("a cut block pasted back keeps its child under it, its Tab never sent", async () => {
  const { a } = await twoVaults(["- [ ] Alpha", "- [ ] Gamma", "- [ ] b1", "- [ ] b2"]);
  const md0 = a.note();
  const b1 = taskId(md0, "b1");
  const b2 = taskId(md0, "b2");
  // Tab on b2 (the editor moves its ref along); no pass.
  const L = lines(md0);
  const i = L.findIndex((l) => l.includes("] b2"));
  L[i] = `\t${L[i]}`;
  L[i + 1] = `\t${L[i + 1]}`;
  // The b1 block cut (b1, b2 under it); b3 typed after Gamma; one pass.
  const from = L.findIndex((l) => l.includes("] b1"));
  const clip = L.splice(from, 4);
  L.splice(L.findIndex((l) => l.includes("] Gamma")) + 2, 0, "- [ ] b3");
  await a.pass(L.join("\n"), { deletedIds: new Set([b1, b2]) });
  // Pasted back before Gamma, as the user left it.
  const P = lines(a.note());
  P.splice(
    P.findIndex((l) => l.includes("] Gamma")),
    0,
    ...clip,
  );
  const pasted = P.join("\n");
  await a.pass(pasted, { inserted: new Set([b1, b2]), cut: new Set([b1, b2]) });
  expect(tasks(a.note())).toEqual(tasks(pasted));
  expect(a.model()?.nodes[b2]?.parent).toBe(b1);
  // And it stays so.
  await a.pass(a.note());
  expect(tasks(a.note())).toEqual(tasks(pasted));
});
