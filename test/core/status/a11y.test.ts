// LFCP-02-064: a new blocking condition is announced once, not per retry or
// received unit; problems are reached one at a time by command, folded ones
// included (UX09/UX16). Unit evidence on mock facts; the native spec drives
// the real editor.

import { describe, expect, it } from "vitest";
import { Announcer, blockingSignature, nextProblem } from "../../../src/core/status/a11y";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const healthy: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [{ id: "p", source: "clean", application: "current" }],
};
const view = (f: Partial<StatusFacts> = {}) => statusView({ ...healthy, ...f });
const conflict = (nodeIds: string[]) =>
  view({ problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds }] });
const failed = (id: string) =>
  view({
    batches: [
      { id, nodeIds: ["n1"], durable: false, failed: true, unitIds: [], acceptedUnitIds: [] },
    ],
  });

describe("announcements (064)", () => {
  it("healthy, pending and offline states block nothing", () => {
    expect(blockingSignature(view())).toBeNull();
    expect(blockingSignature(view({ connection: "offline" }))).toBeNull();
    expect(blockingSignature(conflict(["n1"]))).not.toBeNull();
  });

  it("a new blocking condition once; its retries and new units say nothing", () => {
    const a = new Announcer();
    const title = () => "Launch";
    expect(a.next(new Map([["k", view()]]), title)).toEqual([]);
    const said = a.next(new Map([["k", failed("b1")]]), title);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Shared section Launch needs attention: /);
    // A retry: a new batch ID, the same condition.
    expect(a.next(new Map([["k", failed("b2")]]), title)).toEqual([]);
    expect(a.next(new Map([["k", failed("b2")]]), title)).toEqual([]);
    // A different condition is new; after clearing, the old one is new again.
    expect(a.next(new Map([["k", conflict(["n1"])]]), title)).toHaveLength(1);
    expect(a.next(new Map([["k", view()]]), title)).toEqual([]);
    expect(a.next(new Map([["k", conflict(["n2"])]]), title)).toHaveLength(1);
  });

  it("each section on its own", () => {
    const a = new Announcer();
    const said = a.next(
      new Map([
        ["a", conflict(["n1"])],
        ["b", conflict(["n1"])],
      ]),
      (k) => k.toUpperCase(),
    );
    expect(said.map((s) => s.slice(0, 18))).toEqual(["Shared section A n", "Shared section B n"]);
  });
});

describe("the next problem (064)", () => {
  const problems = [
    { line: 40, title: "B" },
    { line: 3, title: "A" },
    { line: 12, title: "A" },
  ];

  it("the first after the cursor, with its place among all", () => {
    expect(nextProblem(problems, 0)).toEqual({ at: { line: 3, title: "A" }, index: 1, total: 3 });
    expect(nextProblem(problems, 3)).toEqual({ at: { line: 12, title: "A" }, index: 2, total: 3 });
  });

  it("wraps to the first; none says null", () => {
    expect(nextProblem(problems, 40)?.index).toBe(1);
    expect(nextProblem([], 0)).toBeNull();
  });
});
