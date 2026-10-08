// LFCP-02-037: three-way bases for shared sections, and their store by
// projection ID (OP-24).

import { describe, expect, it } from "vitest";
import {
  MemorySectionBaseStore,
  markdownState,
  newProjectionId,
  planSection,
  type SectionState,
  sectionBaseKey,
} from "../../../src/core/sections/base";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;

/** A state from a compact description: [id, kind, parent, text?] in order. */
function state(
  title: string,
  rows: readonly [string, "paragraph" | "item" | "task", string | null, string?][],
): SectionState {
  const nodes: Record<
    string,
    { kind: "paragraph" | "item" | "task"; parent: string | null; text?: string }
  > = {};
  const order: Record<string, string[]> = {};
  for (const [nid, kind, parent, text] of rows) {
    nodes[nid] = { kind, parent, ...(text === undefined ? {} : { text }) };
    order[parent ?? ""] = [...(order[parent ?? ""] ?? []), nid];
  }
  return { title, nodes, order };
}

describe("markdownState", () => {
  it("bound nodes with parents, Text and order; unbound candidates after their bound sibling", () => {
    const md = `${[
      "## Launch",
      formatBoundary("start", S),
      "- [ ] Contract",
      `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`,
      `  ${formatNodeMarker("paragraph", id(3))}`,
      "  Draft 🦔",
      "",
      "  - New item without a marker",
      formatNodeMarker("paragraph", id(4)),
      "Root text",
      formatBoundary("end", S),
    ].join("\n")}\n`;
    const [section] = parseSections(md).sections;
    const { state: st, unbound } = markdownState(md, section as NonNullable<typeof section>);
    expect(st).toEqual({
      title: "Launch",
      nodes: {
        [id(2)]: { kind: "task", parent: null, line: "- [ ] Contract" },
        [id(3)]: { kind: "paragraph", parent: id(2), text: "Draft 🦔" },
        [id(4)]: { kind: "paragraph", parent: null, text: "Root text" },
      },
      order: { "": [id(2), id(4)], [id(2)]: [id(3)] },
    });
    expect(unbound).toEqual([
      { kind: "item", parent: id(2), after: id(3), text: "New item without a marker", line: 7 },
    ]);
  });
});

describe("planSection (three-way)", () => {
  const base = state("T", [
    ["a", "paragraph", null, "alpha"],
    ["b", "paragraph", null, "beta"],
    ["c", "item", null, "gamma"],
  ]);

  it("a user edit: the note differs from the base, sent as a Text edit against the base", () => {
    const note = state("T", [
      ["a", "paragraph", null, "alpha!"],
      ["b", "paragraph", null, "beta"],
      ["c", "item", null, "gamma"],
    ]);
    const plan = planSection(base, note, base);
    expect(plan.textEdits).toEqual([
      { nodeId: "a", edit: { index: 5, deleteCount: 0, insert: "!" } },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("a remote change only: the note equals the base, nothing is sent (the render shows it)", () => {
    const shared = state("T2", [
      ["a", "paragraph", null, "ALPHA"],
      ["b", "paragraph", null, "beta"],
      ["c", "item", null, "gamma"],
    ]);
    expect(planSection(base, base, shared)).toEqual({
      textEdits: [],
      moves: [],
      missing: [],
      kindMismatch: [],
    });
  });

  it("first sight: compared with the shared state taken with the read", () => {
    expect(planSection(undefined, base, base).textEdits).toEqual([]);
    const note = state("T", [
      ["a", "paragraph", null, "alpha"],
      ["b", "paragraph", null, "BETA"],
      ["c", "item", null, "gamma"],
    ]);
    expect(planSection(undefined, note, base).textEdits).toEqual([
      { nodeId: "b", edit: { index: 0, deleteCount: 4, insert: "BETA" } },
    ]);
    // Nothing can be missing without a base.
    expect(planSection(undefined, state("T", []), base).missing).toEqual([]);
  });

  it("a reorder moves only what the user moved; a reparent moves the node", () => {
    const swapped = state("T", [
      ["b", "paragraph", null, "beta"],
      ["a", "paragraph", null, "alpha"],
      ["c", "item", null, "gamma"],
    ]);
    expect(planSection(base, swapped, base).moves).toHaveLength(1);
    const lastFirst = state("T", [
      ["c", "item", null, "gamma"],
      ["a", "paragraph", null, "alpha"],
      ["b", "paragraph", null, "beta"],
    ]);
    expect(planSection(base, lastFirst, base).moves).toEqual([
      { nodeId: "c", parent: null, after: null },
    ]);
    const tree = state("T", [
      ["c", "item", null, "gamma"],
      ["a", "paragraph", "c", "alpha"],
      ["b", "paragraph", null, "beta"],
    ]);
    // "a" goes under "c"; at the root, one of the two equally minimal reorders ("b" or "c").
    const moves = planSection(base, tree, base).moves;
    expect(moves).toContainEqual({ nodeId: "a", parent: "c", after: null });
    expect(moves.filter((m) => m.parent === null)).toHaveLength(1);
  });

  it("missing nodes are reported, never deleted; a title edit; a kind change is refused", () => {
    const note = state("New title", [
      ["a", "item", null, "alpha"],
      ["c", "item", null, "gamma"],
    ]);
    const plan = planSection(base, note, base);
    expect(plan.title).toBe("New title");
    expect(plan.missing).toEqual(["b"]);
    expect(plan.kindMismatch).toEqual(["a"]);
    expect(plan.textEdits).toEqual([]);
  });
});

describe("the base store, by projection ID (OP-24)", () => {
  it("keeps several projections of one note apart, and follows a rename", async () => {
    const store = new MemorySectionBaseStore();
    const [p, q] = [newProjectionId(), newProjectionId()];
    expect(p).not.toBe(q);
    expect(sectionBaseKey(p)).toBe(`section-base:${p}`);
    const st = state("T", []);
    await store.save(p, { locator: { path: "a.md", section: S }, state: st });
    await store.save(q, { locator: { path: "a.md", section: S }, state: st });
    expect(await store.projectionsOf("a.md")).toEqual([p, q].sort());
    await store.rename("a.md", "b.md");
    expect(await store.projectionsOf("a.md")).toEqual([]);
    expect((await store.load(p))?.locator.path).toBe("b.md");
    await store.save(p, null);
    expect(await store.load(p)).toBeUndefined();
  });
});
