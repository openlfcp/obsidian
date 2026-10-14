// A note whose tree is not the model's after a pass says so (remote.ts
// misplaced, SectionResult.diverged): the badge is never CURRENT over it.
// The owner's check of 0.4.0-beta.14 step 4 showed two notes with different
// trees and both badges CURRENT.

import { describe, expect, it } from "vitest";
import type { SectionState } from "../../../src/core/sections/base";
import type { SectionSnapshot } from "../../../src/core/sections/port";
import { misplaced } from "../../../src/core/sections/remote";
import { projectionFact } from "../../../src/core/status/projections";
import { block, lines, PLAN, taskId, twoVaults } from "../../support/section-vaults";

const node = (parent: string | null) => ({ kind: "task" as const, parent, line: "" });
function state(order: Record<string, string[]>): SectionState {
  const nodes: Record<string, ReturnType<typeof node>> = {};
  for (const [key, kids] of Object.entries(order))
    for (const id of kids) nodes[id] = node(key === "" ? null : key);
  return { title: "Plan", nodes, order } as unknown as SectionState;
}
function model(order: Record<string, string[]>, hidden: string[] = []): SectionSnapshot {
  const nodes: Record<string, unknown> = {};
  for (const [key, kids] of Object.entries(order))
    for (const id of kids)
      nodes[id] = {
        kind: "task",
        parent: key === "" ? null : key,
        lifecycle: "active",
        ...(hidden.includes(id) ? { hidden: true } : {}),
      };
  return { revision: "r", title: "Plan", nodes, order, problems: [] } as unknown as SectionSnapshot;
}

describe("misplaced: the note's tree against the model's", () => {
  it("a node under another parent, and one out of order", () => {
    const m = model({ "": ["g", "a", "b"], g: ["d"] });
    // The owner's B: Delta under Beta, not Gamma.
    expect(misplaced(state({ "": ["g", "a", "b"], b: ["d"] }), m, new Set())).toEqual(["d"]);
    expect(misplaced(state({ "": ["a", "g", "b"], g: ["d"] }), m, new Set())).toEqual(["a"]);
    expect(misplaced(state({ "": ["g", "a", "b"], g: ["d"] }), m, new Set())).toEqual([]);
  });

  it("leaves out nodes whose placement waits", () => {
    const m = model({ "": ["g", "a", "b"], g: ["d"] }, ["b"]);
    expect(misplaced(state({ "": ["g", "a"], a: ["d"] }), m, new Set(["d"]))).toEqual([]);
  });

  it("reports a node the note shows while the model hides it (soak #10)", () => {
    // Active in the model, under a node it does not show: no remote plan
    // removes or places it, so without this the badge stayed CURRENT.
    const m = model({ "": ["g", "a", "b"], g: ["d"] }, ["b"]);
    expect(misplaced(state({ "": ["b", "g", "a"], g: ["d"] }), m, new Set())).toEqual(["b"]);
    expect(misplaced(state({ "": ["g", "a"], g: ["d"] }), m, new Set())).toEqual([]);
    // Unless its placement waits for the user's edit.
    expect(misplaced(state({ "": ["b", "g", "a"], g: ["d"] }), m, new Set(["b"]))).toEqual([]);
  });
});

describe("a pass that leaves the note's tree unlike the model's", () => {
  it("reports the nodes, its projection diverged, until a pass places them", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] P",
      "  - [ ] c",
      "- [ ] X",
      "",
      "A paragraph.",
    ]);
    // B: c out of P, after Alpha; P after X, in one pass (the seed 666 case:
    // the other note places one move and defers the other, "no-anchor").
    const L = lines(b.note());
    const [cf, ct] = block(b.note(), "c");
    const c = L.splice(cf, ct - cf).map((l) => l.slice(2));
    const M = lines(L.join("\n"));
    const [pf, pt] = block(M.join("\n"), "P");
    const p = M.splice(pf, pt - pf);
    M.splice(block(M.join("\n"), "X")[1], 0, ...p);
    M.splice(block(M.join("\n"), "Alpha")[1], 0, ...c);
    await b.pass(M.join("\n"));
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    const first = await a.pass(a.note());
    expect(first?.structure?.deferred.map((x) => x.reason)).toContain("no-anchor");
    expect(first?.diverged?.length ?? 0).toBeGreaterThan(0);
    if (first === undefined) throw new Error("no result");
    expect(projectionFact(first).facts.source).toBe("diverged");
    // The next pass places it: current again.
    const next = await a.pass(a.note());
    expect(next?.diverged).toBeUndefined();
    if (next === undefined) throw new Error("no result");
    expect(projectionFact(next).facts).toMatchObject({ source: "clean", application: "current" });
  });
});

describe("a node the note shows while the model hides it (soak #10)", () => {
  it("is not current: its projection diverged", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] Beta",
      "- [ ] Gamma",
      "",
      "A paragraph.",
    ]);
    const md = a.note();
    const alpha = taskId(md, "Alpha");
    const beta = taskId(md, "Beta");
    // In the shared state Beta ends up under Alpha, and Alpha is deleted:
    // Beta is active but hidden (under a node the model does not show).
    for (const [res, ra] of a.replicas) b.replicas.get(res)?.receiveChanges(ra.changes());
    const rev = b.model()?.revision as string;
    await b.port.commit(PLAN.R, [{ intent: "node.move", id: beta, parent: alpha, after: null }], {
      operationId: "hide-1",
    });
    await b.port.commit(PLAN.R, [{ intent: "node.delete", id: alpha }], {
      operationId: "hide-2",
    });
    expect(rev).not.toBe(b.model()?.revision);
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    const snap = a.model();
    expect(snap?.nodes[beta]).toMatchObject({ lifecycle: "active", hidden: true });
    // A's note still shows Beta after its passes: never CURRENT over it.
    let last = await a.pass(a.note());
    last = (await a.pass(a.note())) ?? last;
    expect(a.note()).toContain(beta);
    expect(last?.diverged).toContain(beta);
    if (last === undefined) throw new Error("no result");
    expect(projectionFact(last).facts.source).toBe("diverged");
  });
});
