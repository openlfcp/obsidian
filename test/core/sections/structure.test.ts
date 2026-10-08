// Nodes a collaborator created or moved, written into the note
// (MARKDOWN-SECTIONS-01 §4–§6). MS41's notes are copied from
// MARKDOWN-SECTIONS-FIXTURES-01 (spec mvp-0.2-baseline.1).

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { createTask, SharedObjectsReplica, type Task } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { markdownState, ROOT, type SectionState } from "../../../src/core/sections/base";
import { parseSections } from "../../../src/core/sections/parser";
import type { ModelNode, SectionSnapshot } from "../../../src/core/sections/port";
import type { DocChange } from "../../../src/core/sections/source-map";
import { planStructure } from "../../../src/core/sections/structure";

const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SECTION = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const TASK = "2372cd94-58dc-7fd0-bbc6-6e17c0aebc80";
const PARA = "84cf3237-3432-7041-881f-c34897689278";
const ITEM = "be46412d-1708-757e-ad18-e21fa7c61c68";
const START = `<!-- lfcp-section: ${SECTION} -->`;
const END = `<!-- /lfcp-section: ${SECTION} -->`;
const REF = (id: string) => `<!-- lfcp-ref: lfcp1:${R}#task:${id} -->`;
const BEFORE = "PRIVATE_BEFORE_8f3a: budget and personal thoughts.";
const AFTER = "PRIVATE_AFTER_71c2: do not transmit.";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;

const note = (body: string[]) =>
  [BEFORE, "", "## Joint launch", START, ...body, END, "", AFTER, ""].join("\n");
const NESTED = [
  "- [ ] Prepare contract",
  `  ${REF(TASK)}`,
  `  <!-- lfcp-node: paragraph:${PARA} -->`,
  "  Draft contract",
  "",
  "  - Check details",
  `    <!-- lfcp-node: item:${ITEM} -->`,
];

const sectionOf = (md: string) => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return s;
};
const stateOf = (md: string) => markdownState(md, sectionOf(md)).state;
const apply = (md: string, changes: readonly DocChange[]) =>
  [...changes].reverse().reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), md);

/** The model: the base with nodes added or moved, in this order per parent. */
function model(
  base: SectionState,
  nodes: Record<string, Partial<ModelNode>>,
  order: Record<string, string[]>,
  problems: SectionSnapshot["problems"] = [],
): SectionSnapshot {
  const all: Record<string, ModelNode> = {};
  for (const [k, n] of Object.entries(base.nodes))
    all[k] = {
      kind: n.kind,
      parent: n.parent,
      lifecycle: "active",
      ...(n.text === undefined ? {} : { text: n.text }),
    };
  for (const [k, n] of Object.entries(nodes))
    all[k] = Object.assign({ lifecycle: "active" }, all[k], n) as ModelNode;
  return {
    revision: "h2",
    title: base.title,
    ready: true,
    nodes: all,
    order: { ...base.order, ...order },
    problems,
  };
}

const me = principalId(new Uint8Array(32).fill(4));
function taskView(taskId: string, title: string): (id: string) => Task | undefined {
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: me,
  });
  replica.apply(createTask({ id: taskId as never, title, createdBy: me }).intent);
  return (i) => (i === taskId ? replica.task(taskId)?.task : undefined);
}

function plan(
  md: string,
  m: SectionSnapshot,
  task: (id: string) => Task | undefined = () => undefined,
) {
  return planStructure(md, sectionOf(md), stateOf(md), m, { resourceId: fromBase64url(R), task });
}

/** After the plan, the note parses to exactly the model's tree, with no diagnostics. */
function expectModel(out: string, m: SectionSnapshot) {
  expect(parseSections(out).diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  const s = stateOf(out);
  for (const [k, n] of Object.entries(m.nodes)) {
    expect(s.nodes[k]?.kind).toBe(n.kind);
    expect(s.nodes[k]?.parent).toBe(n.parent);
    if (n.text !== undefined) expect(s.nodes[k]?.text).toBe(n.text);
  }
  for (const [parent, ids] of Object.entries(m.order))
    expect(s.order[parent] ?? [], `order under ${parent || "the root"}`).toEqual(ids);
}

describe("created nodes", () => {
  it("MS41: a received comment is projected as a raw node, after the last root node", () => {
    const md = note(NESTED);
    const RAW = "f9b42f42-50f6-7592-b1f9-ceb919b09c8b";
    const m = model(
      stateOf(md),
      { [RAW]: { kind: "raw", parent: null, text: "%% shared note %%" } },
      { [ROOT]: [TASK, RAW] },
    );
    const out = apply(md, plan(md, m).changes);
    expect(out).toBe(note([...NESTED, "", `<!-- lfcp-node: raw:${RAW} -->`, "%% shared note %%"]));
    expectModel(out, m);
  });

  it("a Task added by a collaborator appears under its parent, rendered as 0.1 renders it", () => {
    const md = note(NESTED);
    const T2 = id(2);
    const m = model(
      stateOf(md),
      { [T2]: { kind: "task", parent: TASK } },
      { [TASK]: [PARA, ITEM, T2] },
    );
    expect(plan(md, m).deferred).toEqual([{ nodeId: T2, reason: "no-task" }]);
    const out = apply(md, plan(md, m, taskView(T2, "Call Anna")).changes);
    expect(out).toBe(note([...NESTED, "  - [ ] Call Anna", `    ${REF(T2)}`]));
    expectModel(out, m);
  });

  it("a paragraph as a Task's first child follows its ref line without a blank line (§6)", () => {
    const md = note(["- [ ] Prepare contract", `  ${REF(TASK)}`]);
    const P = id(3);
    const m = model(
      stateOf(md),
      { [P]: { kind: "paragraph", parent: TASK, text: "First\nsecond line" } },
      { [TASK]: [P] },
    );
    const out = apply(md, plan(md, m).changes);
    expect(out).toBe(
      note([
        "- [ ] Prepare contract",
        `  ${REF(TASK)}`,
        `  <!-- lfcp-node: paragraph:${P} -->`,
        "  First",
        "  second line",
      ]),
    );
    expectModel(out, m);
  });

  it("a new parent and its new children in one pass; an ordered run numbered from 1", () => {
    const md = note(NESTED);
    const [A, B, C] = [id(4), id(5), id(6)];
    const m = model(
      stateOf(md),
      {
        [A]: { kind: "item", parent: null, text: "Steps", listStyle: "bullet" },
        [B]: { kind: "item", parent: A, text: "One", listStyle: "ordered" },
        [C]: { kind: "item", parent: A, text: "Two", listStyle: "ordered" },
      },
      { [ROOT]: [TASK, A], [A]: [B, C] },
    );
    const out = apply(md, plan(md, m).changes);
    expect(out).toBe(
      note([
        ...NESTED,
        "- Steps",
        `  <!-- lfcp-node: item:${A} -->`,
        "  1. One",
        `     <!-- lfcp-node: item:${B} -->`,
        "  2. Two",
        `     <!-- lfcp-node: item:${C} -->`,
      ]),
    );
    expectModel(out, m);
  });

  it("children of a tab-indented parent get one more tab (M2)", () => {
    const md = note([
      "- [ ] Parent",
      `  ${REF(TASK)}`,
      "\t- Child",
      `\t  <!-- lfcp-node: item:${ITEM} -->`,
    ]);
    const N = id(7);
    const base = stateOf(md);
    const m = model(
      base,
      { [N]: { kind: "item", parent: ITEM, text: "Grandchild" } },
      { [ITEM]: [N] },
    );
    const out = apply(md, plan(md, m).changes);
    expect(out).toContain(`\t\t- Grandchild\n`);
    expectModel(out, m);
  });

  it("waits when the predecessor is not in the note", () => {
    const md = note(NESTED);
    const [GONE, N] = [id(8), id(9)];
    const m = model(
      stateOf(md),
      {
        [GONE]: { kind: "paragraph", parent: null, text: "Not here" },
        [N]: { kind: "paragraph", parent: null, text: "After it" },
      },
      { [ROOT]: [TASK, GONE, N] },
    );
    // GONE is unprojected too and goes first; with it placed, N follows it.
    const out = apply(md, plan(md, m).changes);
    expectModel(out, m);
  });
});

describe("moved nodes", () => {
  it("a subtree moved to the root keeps its lines, re-indented", () => {
    const md = note(NESTED);
    const base = stateOf(md);
    const m = model(base, { [ITEM]: { parent: null } }, { [ROOT]: [TASK, ITEM], [TASK]: [PARA] });
    const out = apply(md, plan(md, m).changes);
    expect(out).toBe(
      note([
        "- [ ] Prepare contract",
        `  ${REF(TASK)}`,
        `  <!-- lfcp-node: paragraph:${PARA} -->`,
        "  Draft contract",
        "",
        "- Check details",
        `  <!-- lfcp-node: item:${ITEM} -->`,
      ]),
    );
    expectModel(out, m);
  });

  it("a moved node edited here waits; nothing structural under a model problem (MS14)", () => {
    const md = note(NESTED);
    const base = stateOf(md);
    const m = model(base, { [ITEM]: { parent: null } }, { [ROOT]: [TASK, ITEM], [TASK]: [PARA] });
    const edited = md.replace("Check details", "Check all details");
    const p = planStructure(edited, sectionOf(edited), base, m, {
      resourceId: fromBase64url(R),
      task: () => undefined,
    });
    expect(p.changes).toEqual([]);
    expect(p.deferred).toEqual([{ nodeId: ITEM, reason: "local-edit" }]);
    const frozen = plan(md, { ...m, problems: [{ code: "PARENT_CYCLE", nodeIds: [] }] });
    expect(frozen.changes).toEqual([]);
    expect(frozen.deferred).toEqual([{ nodeId: ITEM, reason: "frozen" }]);
  });

  it("two siblings swapped: only one moves", () => {
    const P1 = id(10);
    const P2 = id(11);
    const bound = note([
      `<!-- lfcp-node: paragraph:${P1} -->`,
      "Para one",
      "",
      `<!-- lfcp-node: paragraph:${P2} -->`,
      "Para two",
    ]);
    const m = model(stateOf(bound), {}, { [ROOT]: [P2, P1] });
    const p = plan(bound, m);
    expect(p.placed).toHaveLength(1);
    const out = apply(bound, p.changes);
    expect(out).toBe(
      note([
        `<!-- lfcp-node: paragraph:${P2} -->`,
        "Para two",
        "",
        `<!-- lfcp-node: paragraph:${P1} -->`,
        "Para one",
      ]),
    );
    expectModel(out, m);
  });
});
