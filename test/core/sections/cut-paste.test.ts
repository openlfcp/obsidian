// Moving a Task by cut and paste (MARKDOWN-SECTIONS-01 §10, rules.ts
// pasteDecision), on the real section replica: two vaults offline, each
// with the engine and the port as the host wires them. In the editor a cut
// and its paste are separate passes (the scheduler waits 400 ms of quiet),
// so the cut is committed as a node.delete before the paste is seen. The
// paste of this session's cut is a move: the Task is restored and placed
// where it was pasted, in one batch. Found in the owner's two-vault check of
// 0.4.0-beta.1 (row 6): the pasted Task stayed deleted in the model, the
// other vault's move then lost it, and both badges were green.

import { describe, expect, it } from "vitest";
import {
  count,
  cut,
  id,
  paste,
  placementConflict,
  reconnect,
  type Vault,
  twoVaults as vaults,
} from "../../support/section-vaults";

// The engine of the first vault allocates IDs from 100: the three Tasks, then the paragraph.
const MILK = id(100);
const REPORT = id(101);
const MOVED = id(102);
const BODY = ["- [ ] Buy milk", "- [ ] Write report", "- [ ] Task from B", "", "A paragraph"];

/** Vault A with three Tasks and a paragraph shared, and vault B showing the same note. */
async function twoVaults() {
  const v = await vaults(BODY);
  expect(v.a.model()?.nodes[MOVED]?.lifecycle).toBe("active");
  return v;
}

/** A in Obsidian: the cut, the paste and the Tab, each its own pass. */
async function moveInSteps(v: Vault, title: string, parent: string) {
  const before = v.note();
  const removed = cut(before, title);
  const ids = new Set([MOVED]);
  await v.pass(removed, { deletedIds: ids, cut: ids });
  await v.pass(paste(before, removed, title, parent), { cut: ids });
  await v.pass(paste(before, removed, title, parent, "\t"), { cut: ids });
}

/** The same move as one edit (all within one pass). */
async function moveAtOnce(v: Vault, title: string, parent: string) {
  const before = v.note();
  await v.pass(paste(before, cut(before, title), title, parent, "\t"));
}

describe("moving a Task by cut and paste", () => {
  it("in one vault: the paste of the cut restores the Task where it was pasted", async () => {
    const { a } = await twoVaults();
    await moveInSteps(a, "Task from B", "Buy milk");
    expect(a.model()?.nodes[MOVED]).toMatchObject({ lifecycle: "active", parent: MILK });
    expect(count(a.note(), "Task from B")).toBe(1);
    expect(a.model()?.problems).toEqual([]);
  });

  it("the restored Task's later edits are shared", async () => {
    const { a } = await twoVaults();
    await moveInSteps(a, "Task from B", "Buy milk");
    await a.pass(a.note());
    await a.pass(a.note().replace("[ ] Task from B", "[ ] Task from B today"));
    expect(a.replica().task(MOVED)?.task?.title).toBe("Task from B today");
  });

  it("a cut without a paste stays a delete", async () => {
    const { a } = await twoVaults();
    const ids = new Set([MOVED]);
    await a.pass(cut(a.note(), "Task from B"), { deletedIds: ids, cut: ids });
    await a.pass(a.note(), { cut: ids });
    expect(a.model()?.nodes[MOVED]?.lifecycle).toBe("deleted");
  });

  it("a deleted Task back in the note without the cut: reported, nothing sent; restored when chosen", async () => {
    const { a } = await twoVaults();
    const before = a.note();
    const removed = cut(before, "Task from B");
    const ids = new Set([MOVED]);
    await a.pass(removed, { deletedIds: ids, cut: ids });
    // Pasted in another session (the cut is not this one's).
    const pasted = paste(before, removed, "Task from B", "Buy milk", "\t");
    const shown = await a.pass(pasted);
    expect(shown?.reappeared).toEqual([MOVED]);
    expect(a.model()?.nodes[MOVED]?.lifecycle).toBe("deleted");
    expect(count(a.note(), "Task from B")).toBe(1);
    // "Restore it where your note shows it".
    const restored = await a.pass(a.note(), { restore: ids });
    expect(restored?.reappeared).toBeUndefined();
    expect(a.model()?.nodes[MOVED]).toMatchObject({ lifecycle: "active", parent: MILK });
  });

  for (const [name, moveA, moveB] of [
    ["A in steps, B at once", moveInSteps, moveAtOnce],
    ["A at once, B in steps", moveAtOnce, moveInSteps],
    ["both in steps", moveInSteps, moveInSteps],
  ] as const)
    it(`under different parents offline (${name}): both keep the Task and need attention`, async () => {
      const { a, b } = await twoVaults();
      await moveA(a, "Task from B", "Buy milk");
      await moveB(b, "Task from B", "Write report");
      await reconnect(a, b);
      for (const v of [a, b]) {
        expect(v.model()?.nodes[MOVED]?.lifecycle).toBe("active");
        expect(placementConflict(v, MOVED)).toBe(true);
        expect(count(v.note(), "Task from B")).toBe(1);
      }
      expect([MILK, REPORT]).toContain(a.model()?.nodes[MOVED]?.parent);
    });
});
