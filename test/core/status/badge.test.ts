// LFCP-02-058: the heading badge, quiet rows with their aggregate cues
// (SI12, SI13), and the provisional facts from what the plugin observes:
// never an invented acceptance. Unit evidence on mock facts.

import { describe, expect, it } from "vitest";
import { headingBadge, rowCues, SYNC_ICON } from "../../../src/core/status/badge";
import { type ObservedSection, observedFacts } from "../../../src/core/status/facts";
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

describe("the heading badge (M8)", () => {
  it("quiet when current: the shared mark alone, a qualified tooltip", () => {
    const b = headingBadge("Launch", view());
    expect(b).toEqual({
      state: "CURRENT",
      icon: null,
      tooltip: "No pending local changes; current as last checked",
      accessibleName: "Shared section Launch, open details",
    });
    expect(headingBadge("Launch", view({ access: "reader" }))).toMatchObject({
      state: "READ_ONLY_CURRENT",
      icon: null,
      tooltip: "Shared section · read-only",
      accessibleName: "Shared section Launch, read-only, open details",
    });
  });

  it("every other state has its own icon; pending names its count", () => {
    const icons = Object.values(SYNC_ICON).filter((i) => i !== null);
    expect(new Set(icons).size).toBe(8);
    const b = headingBadge(
      "Launch",
      view({
        batches: [1, 2, 3].map((n) => ({
          id: `b${n}`,
          nodeIds: ["x"],
          durable: true,
          unitIds: [`u${n}`],
          acceptedUnitIds: [],
        })),
      }),
    );
    expect(b).toMatchObject({ state: "SENDING", icon: "pending" });
    expect(b.accessibleName).toBe("Shared section Launch, 3 local updates waiting, open details");
    expect(headingBadge("Launch", view({ connection: "offline" })).icon).toBe("offline");
  });
});

describe("rows", () => {
  const tree = [
    {
      id: "parent",
      line: 3,
      children: [
        { id: "child", line: 4, children: [] },
        { id: "other", line: 6, children: [] },
      ],
    },
    { id: "healthy", line: 8, children: [] },
  ];

  it("healthy rows are quiet; a pending row has a cue on its own line", () => {
    const v = view({
      batches: [
        { id: "b", nodeIds: ["child"], durable: true, unitIds: ["u"], acceptedUnitIds: [] },
      ],
    });
    expect([...rowCues(v, tree)]).toEqual([[4, "pending"]]);
  });

  it("SI13: a folded parent carries what it hides, once; attention outranks pending", () => {
    const v = view({
      batches: [
        {
          id: "b",
          nodeIds: ["child", "other"],
          durable: true,
          unitIds: ["u"],
          acceptedUnitIds: [],
        },
      ],
    });
    const folded = (line: number) => (line > 3 && line < 8 ? 3 : null);
    expect([...rowCues(v, tree, folded)]).toEqual([[3, "pending"]]);
    const conflict = view({
      batches:
        v.conditions.length > 0
          ? [{ id: "b", nodeIds: ["child"], durable: true, unitIds: ["u"], acceptedUnitIds: [] }]
          : [],
      problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds: ["other"] }],
    });
    expect([...rowCues(conflict, tree, folded)]).toEqual([[3, "attention"]]);
  });
});

describe("provisional facts", () => {
  const observed: ObservedSection = {
    session: "s",
    revision: 1,
    load: { ready: true, loaded: true },
    phase: "LIVE",
    wasLive: true,
    writable: true,
    problems: [],
    operations: [
      { id: "sent", unitIds: ["a"], nodeIds: ["n1"] },
      { id: "queued", unitIds: ["b", "c"], nodeIds: ["n2"] },
    ],
    queued: new Set(["c"]),
    projections: [{ id: "p", source: "clean", application: "current" }],
  };

  it("never claims acceptance: a queued batch is pending with evidence unavailable", () => {
    const f = observedFacts(observed);
    expect(f.batches.map((b) => b.id)).toEqual(["queued"]);
    expect(f.batches.every((b) => b.acceptedUnitIds.length === 0)).toBe(true);
    expect(statusView(f).state).toBe("EVIDENCE_UNKNOWN");
    // Nothing queued: no pending local changes, and no accepted batch either.
    const quiet = statusView(observedFacts({ ...observed, queued: new Set() }));
    expect(quiet).toMatchObject({ state: "CURRENT", acceptedBatches: 0 });
  });

  it("maps the session phase: offline keeps the checkpoint; syncing is receiving; a blocked key is attention", () => {
    expect(
      statusView(observedFacts({ ...observed, phase: "CLOSED", queued: new Set() })).state,
    ).toBe("OFFLINE");
    expect(
      statusView(observedFacts({ ...observed, phase: "CLOSED", wasLive: false, queued: new Set() }))
        .state,
    ).toBe("LOADING");
    expect(
      statusView(observedFacts({ ...observed, phase: "DATA_SYNC", queued: new Set() })).state,
    ).toBe("LOADING");
    expect(
      statusView(observedFacts({ ...observed, phase: "KEY_BLOCKED", queued: new Set() })).state,
    ).toBe("ATTENTION");
    expect(statusView(observedFacts({ ...observed, load: undefined })).state).toBe("LOADING");
    expect(
      statusView(observedFacts({ ...observed, writable: false, queued: new Set() })).state,
    ).toBe("READ_ONLY_CURRENT");
  });

  it("classifies model problems and a failed commit", () => {
    const f = observedFacts({
      ...observed,
      problems: [
        { code: "SCALAR_CONFLICT", nodeIds: ["n1"] },
        { code: "PARENT_CYCLE", nodeIds: ["n2"] },
      ],
      failedOperations: ["lost"],
    });
    expect(f.problems.map((p) => p.kind)).toEqual(["scalar", "structural"]);
    expect(statusView(f).state).toBe("LOCAL_SAVE_FAILED");
  });
});
