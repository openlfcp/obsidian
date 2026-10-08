// The port against the real SDK (sdk-ts at sdk-ts.lock): SectionReplica's
// snapshot in the port's terms, and the batches the engine builds accepted
// by the replica as they are. Not a fake: these are the SDK's own rules.

import { principalId, resourceId } from "@openlfcp/core";
import { createTask } from "@openlfcp/shared-objects";
import { type SectionIntent as SdkIntent, SectionReplica } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import { intentsOf, type LocalPass } from "../../../src/core/sections/commit";
import { fromSdkSnapshot } from "../../../src/core/sections/sdk-snapshot";

const resource = resourceId(new Uint8Array(32).fill(7));
const alice = principalId(new Uint8Array(32).fill(4));
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const SECTION = id(1);
const T = id(2);
const P = id(3);
const X = id(4);

function section(ready = true): SectionReplica {
  const r = SectionReplica.empty({ resource, principal: alice });
  const intents: SdkIntent[] = [
    { intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: alice, ready },
    {
      intent: "task.create_in_section",
      task: createTask({ id: T as never, title: "Contract", createdBy: alice }).task,
      parent: SECTION,
      after: null,
    },
    { intent: "paragraph.create", id: P, parent: T, after: null, text: "Draft", createdBy: alice },
    { intent: "item.create", id: X, parent: SECTION, after: T, text: "Check", createdBy: alice },
  ];
  r.commit(intents);
  return r;
}

const EMPTY = { textEdits: [], moves: [], missing: [], kindMismatch: [] };

describe("fromSdkSnapshot", () => {
  it("maps nodes, parents, order, title and revision", () => {
    const r = section();
    const s = fromSdkSnapshot(r.snapshot(), SECTION);
    expect(s).toEqual({
      revision: r.revision(),
      title: "Launch",
      ready: true,
      nodes: {
        [T]: { kind: "task", parent: null, lifecycle: "active" },
        [P]: { kind: "paragraph", parent: T, lifecycle: "active", text: "Draft" },
        [X]: { kind: "item", parent: null, lifecycle: "active", text: "Check" },
      },
      order: { "": [T, X], [T]: [P] },
      problems: [],
    });
  });

  it("an import in progress is not ready", () => {
    expect(fromSdkSnapshot(section(false).snapshot(), SECTION)?.ready).toBe(false);
  });
});

describe("the engine's batches against the real replica", () => {
  const pass = (r: SectionReplica, over: Partial<LocalPass>): LocalPass => ({
    projectionId: "p",
    resource: "r",
    sectionId: SECTION,
    createdBy: alice,
    sourceHash: "h",
    sourceText: "",
    baseRevision: r.revision(),
    plan: EMPTY,
    newTask: (_c, taskId) =>
      createTask({ id: taskId as never, title: "Call Anna", createdBy: alice }).task,
    ...over,
  });

  it("creations, a Text edit against the snapshot's revision and a move are accepted as one change", () => {
    const r = section();
    const { intents } = intentsOf(
      pass(r, {
        plan: {
          ...EMPTY,
          title: "Launch plan",
          textEdits: [{ nodeId: P, edit: { index: 5, deleteCount: 0, insert: " v2" } }],
          moves: [{ nodeId: X, parent: null, after: null }],
        },
        creations: [
          { kind: "paragraph", parent: T, after: P, text: "More", line: 9 },
          { kind: "task", parent: null, after: X, line: 11 },
        ],
      }),
      {},
      (() => {
        let n = 100;
        return () => id(n++);
      })(),
    );
    expect(r.commit(intents as unknown as SdkIntent[])).not.toBeNull();
    const s = fromSdkSnapshot(r.snapshot(), SECTION);
    expect(s?.title).toBe("Launch plan");
    expect(s?.nodes[P]?.text).toBe("Draft v2");
    expect(s?.nodes[id(100)]).toEqual({
      kind: "paragraph",
      parent: T,
      lifecycle: "active",
      text: "More",
    });
    expect(s?.nodes[id(101)]).toEqual({ kind: "task", parent: null, lifecycle: "active" });
    expect(s?.order[""]).toEqual([X, T, id(101)]);
    expect(s?.order[T]).toEqual([P, id(100)]);
  });

  it("a deletion: the node is deleted, its children only hidden", () => {
    const r = section();
    const { intents } = intentsOf(pass(r, { deletes: [T] }), {}, () => id(100));
    r.commit(intents as unknown as SdkIntent[]);
    const s = fromSdkSnapshot(r.snapshot(), SECTION);
    expect(s?.nodes[T]).toMatchObject({ lifecycle: "deleted", hidden: true });
    expect(s?.nodes[P]).toMatchObject({ lifecycle: "active", hidden: true });
    expect(s?.order[""]).toEqual([X]);
  });
});
