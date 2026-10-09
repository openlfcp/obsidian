// LFCP-02-061: recovery items from real conflicts of the SDK's
// SectionReplica (two writers, merged): every alternative shown, each choice
// a fresh causal intent that clears its conflict, and a comparison that
// changed meanwhile is shown again instead of applied (UX15; SS08, SS15,
// SS26, SS27 at the model level).

import { type ObjectId, type PrincipalId, principalId, resourceId } from "@openlfcp/core";
import { createTask } from "@openlfcp/shared-objects";
import { type SectionIntent, SectionReplica } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import {
  type RecoveryItem,
  recoveryItems,
  resolution,
  revalidate,
} from "../../../src/core/sections/recovery";

const id = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const [SECTION, T, P, X, I1, I2, D] = [1, 2, 3, 4, 5, 6, 7].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const resource = resourceId(new Uint8Array(32).fill(9));
const alice = principalId(new Uint8Array(32).fill(1)) as PrincipalId;
const who = (n: number) => principalId(new Uint8Array(32).fill(n)) as PrincipalId;

function base(): SectionReplica {
  const r = SectionReplica.empty({ resource, principal: alice });
  r.commit([
    { intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: alice },
    {
      intent: "task.create_in_section",
      task: createTask({ id: T as ObjectId, title: "Prepare contract", createdBy: alice }).task,
      parent: SECTION,
      after: null,
    },
    { intent: "paragraph.create", id: P, parent: T, after: null, text: "Notes", createdBy: alice },
    {
      intent: "paragraph.create",
      id: X,
      parent: SECTION,
      after: T,
      text: "Draft",
      createdBy: alice,
    },
    { intent: "item.create", id: I1, parent: SECTION, after: X, text: "One", createdBy: alice },
    { intent: "item.create", id: I2, parent: SECTION, after: I1, text: "Two", createdBy: alice },
    {
      intent: "paragraph.create",
      id: D,
      parent: SECTION,
      after: I2,
      text: "Doomed",
      createdBy: alice,
    },
  ] as SectionIntent[]);
  return r;
}

/** `r`'s history plus one branch per writer, each committing its intents in order. */
function merged(r: SectionReplica, branches: readonly SectionIntent[][]): SectionReplica {
  const save = r.save();
  const changes = branches.flatMap((intents, k) => {
    const w = SectionReplica.fromSave(save, { resource, principal: who(50 + k) }, "local-state");
    const before = w.changes().length;
    for (const i of intents) w.commit([i]);
    return w.changes().slice(before);
  });
  return SectionReplica.fromChanges([...r.changes(), ...changes], { resource, principal: alice })
    .replica;
}

const model = (r: SectionReplica) => ({
  sectionId: SECTION,
  tree: r.tree(),
  snapshot: r.snapshot(),
  taskTitle: (taskId: string) => r.task(taskId)?.task?.title,
});

const kinds = (items: readonly RecoveryItem[]) => items.map((i) => i.kind).sort();

describe("recovery items (061)", () => {
  const conflicted = () =>
    merged(base(), [
      [
        { intent: "node.move", id: X, parent: T, after: P },
        { intent: "node.move", id: I1, parent: I2, after: null },
        { intent: "task.set_title", id: T as ObjectId, title: "Prepare the contract" },
        { intent: "section.set_title", title: "Busy" },
        { intent: "section.set_title", title: "Launch" },
        { intent: "node.delete", id: D },
      ],
      [
        { intent: "node.move", id: X, parent: I2, after: null },
        { intent: "node.move", id: I2, parent: I1, after: null },
        { intent: "task.set_title", id: T as ObjectId, title: "Prepare contract v2" },
        { intent: "node.restore", id: D },
      ],
    ] as SectionIntent[][]);

  it("shows every alternative of each conflict, labelled by place", () => {
    const items = recoveryItems(model(conflicted()));
    expect(kinds(items)).toEqual(["cycle", "field", "lifecycle", "placement"]);
    const placement = items.find((i) => i.kind === "placement");
    expect(placement).toMatchObject({ nodeId: X, label: 'Paragraph "Draft"' });
    expect(placement?.kind === "placement" && placement.choices.map((c) => c.label).sort()).toEqual(
      // "Two" is itself in the cycle: its own place is shown too.
      ['Under List item "Two" under "One"', 'Under Task "Prepare contract v2"'],
    );
    const field = items.find((i) => i.kind === "field");
    expect(field).toMatchObject({ nodeId: T, field: "title" });
    expect(field?.kind === "field" && [...field.values].sort()).toEqual([
      "Prepare contract v2",
      "Prepare the contract",
    ]);
    const cycle = items.find((i) => i.kind === "cycle");
    expect(cycle?.kind === "cycle" && cycle.members.map((m) => m.nodeId).sort()).toEqual(
      [I1, I2].sort(),
    );
  });

  it("each choice is a fresh intent that clears its conflict", () => {
    const r = conflicted();
    for (const item of recoveryItems(model(r))) {
      const choice =
        item.kind === "placement"
          ? { parent: item.choices[0]?.parent as string }
          : item.kind === "field"
            ? { value: item.values[0] as string }
            : item.kind === "cycle"
              ? { move: item.members[0]?.nodeId as string }
              : item.kind === "lifecycle"
                ? { keep: true }
                : { restore: true as const };
      r.commit(resolution(item, choice, SECTION) as never);
    }
    expect(recoveryItems(model(r))).toEqual([]);
    expect(r.tree().classification).toBe("VALID");
    expect(r.tree().hidden).toEqual([]);
  });

  it("an edit under a deleted ancestor is shown with the ancestor to restore", () => {
    const b = base();
    const r = merged(b, [
      [{ intent: "node.delete", id: T }],
      [
        {
          intent: "text.edit",
          id: P,
          base: b.revision(),
          edits: [{ index: 5, deleteCount: 0, insert: " more" }],
        },
      ],
    ] as SectionIntent[][]);
    const items = recoveryItems(model(r));
    expect(items).toEqual([
      {
        kind: "retained",
        key: `retained:${P}`,
        nodeId: P,
        label: 'Paragraph "Notes more" under "Prepare contract"',
        ancestor: T,
        ancestorLabel: 'Task "Prepare contract"',
      },
    ]);
    r.commit(resolution(items[0] as RecoveryItem, { restore: true }, SECTION) as never);
    expect(r.tree().retainedConcurrentEdits).toEqual([]);
    expect(r.tree().hidden).toEqual([]);
  });

  it("a comparison that changed meanwhile is shown again, not applied", () => {
    const b = base();
    const A = [
      { intent: "node.move", id: X, parent: T, after: P },
      { intent: "task.set_title", id: T as ObjectId, title: "Prepare the contract" },
    ] as SectionIntent[];
    const B = [
      { intent: "node.move", id: X, parent: I2, after: null },
      { intent: "task.set_title", id: T as ObjectId, title: "Prepare contract v2" },
    ] as SectionIntent[];
    const before = recoveryItems(model(merged(b, [A, B])));
    const field = before.find((i) => i.kind === "field") as RecoveryItem;
    const placement = before.find((i) => i.kind === "placement") as RecoveryItem;
    // A third writer's concurrent title arrives while the form is open.
    const later = merged(b, [
      A,
      B,
      [{ intent: "task.set_title", id: T as ObjectId, title: "Third" }] as SectionIntent[],
    ]);
    const now = recoveryItems(model(later));
    expect(revalidate(field, now)).toMatchObject({ kind: "changed" });
    expect(revalidate(placement, now).kind).toBe("same");
    // Once resolved, it is gone.
    later.commit(resolution(field, { value: "Third" }, SECTION) as never);
    expect(revalidate(field, recoveryItems(model(later))).kind).toBe("gone");
  });
});
