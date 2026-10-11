// "Review conflicts…": what is asked about a change retained under a
// deletion (§9). The model names the node but not whether it was edited or
// moved (baseline.8 retains a move as it does an edit), so the question
// covers both, and names a deleted Task once when it is the one deleted.
// It can be restored, or kept deleted (baseline.9: a fresh deletion after
// the change ends the attention).

import { describe, expect, it } from "vitest";
import { recoveryOptions } from "../../src/obsidian/ui/recovery";

const TASK = "019a2f85-7b31-7c42-b85a-fc843e2f4101";
const PARENT = "019a2f85-7b31-7c42-b85a-fc843e2f4100";
const KEEP = { label: "Keep it deleted", choice: { keep: false } };

describe("a change retained under a deletion", () => {
  it("the node itself deleted: asked once, restored by name or kept deleted", () => {
    const o = recoveryOptions({
      kind: "retained",
      key: `retained:${TASK}`,
      nodeId: TASK,
      label: 'Task "Write report"',
      ancestor: TASK,
      ancestorLabel: 'Task "Write report"',
      deleted: [TASK],
    });
    expect(o.question).toBe(
      'Task "Write report" was changed or moved while it was deleted. Restore it, or keep it deleted?',
    );
    expect(o.choices).toEqual([{ label: "Restore it", choice: { restore: true } }, KEEP]);
  });

  it("an item above it deleted: that item is the one restored, or kept deleted", () => {
    const o = recoveryOptions({
      kind: "retained",
      key: `retained:${TASK}`,
      nodeId: TASK,
      label: 'Task "Write report"',
      ancestor: PARENT,
      ancestorLabel: 'Task "Buy milk"',
      deleted: [PARENT],
    });
    expect(o.question).toBe(
      'Task "Write report" was changed or moved while Task "Buy milk", which holds it, was deleted. Restore Task "Buy milk", or keep it deleted?',
    );
    expect(o.choices).toEqual([
      { label: 'Restore Task "Buy milk"', choice: { restore: true } },
      KEEP,
    ]);
  });
});
