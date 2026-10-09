// LFCP-02-058 (SI12, SI16): engine pass results as projection facts for the
// badge, and a failed local save as LOCAL_SAVE_FAILED until a later pass
// saves. Unit evidence on synthetic pass results, through the real reducer.

import { describe, expect, it } from "vitest";
import type { SectionResult } from "../../../src/core/sections/engine";
import { ProjectionFactsStore, projectionFact } from "../../../src/core/status/projections";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const section = { resourceId: new Uint8Array(32), sectionId: "s" };
const result = (o: Partial<SectionResult>): SectionResult => ({
  projectionId: "p1",
  section,
  lost: [],
  held: [],
  entries: [],
  ...o,
});
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
  projections: [],
};

describe("projection facts from passes", () => {
  it("each kind of pass result as its projection's source and application", () => {
    expect(projectionFact(result({ skipped: "base-unknown" })).facts).toMatchObject({
      source: "base-unknown",
      application: "blocked",
    });
    expect(projectionFact(result({ skipped: "blocked" })).facts.source).toBe("unsupported");
    expect(projectionFact(result({ lost: ["n1"] })).facts.source).toBe("binding-error");
    expect(projectionFact(result({ held: ["n1"] })).facts.application).toBe("patch-pending");
    expect(projectionFact(result({})).facts).toMatchObject({
      source: "clean",
      application: "current",
    });
  });

  it("a broken projection needs attention; a healthy one in another note stays its own (SI12)", () => {
    const store = new ProjectionFactsStore();
    store.note("k", result({ projectionId: "a", lost: ["n1"] }));
    store.note("k", result({ projectionId: "b" }));
    const v = statusView({ ...healthy, projections: store.projections("k") });
    expect(v.state).toBe("ATTENTION");
    expect(v.projections).toMatchObject({ b: expect.not.stringMatching(/ATTENTION/) });
    expect(v.conditions.some((c) => c.kind === "source")).toBe(true);
  });

  it("a failed local save is LOCAL_SAVE_FAILED until a later pass of that projection saves", () => {
    const store = new ProjectionFactsStore();
    const failed = result({
      local: {
        kind: "save-failed",
        entry: { operationId: "op-1" } as never,
        error: new Error("disk full"),
      },
    });
    expect(store.note("k", failed)).toBe(true);
    expect(store.failedOperations("k")).toEqual(["op-1"]);
    const facts = { ...healthy, projections: store.projections("k") };
    expect(
      statusView({
        ...facts,
        batches: store.failedOperations("k").map((id) => ({
          id,
          nodeIds: [],
          durable: false,
          failed: true,
          unitIds: [],
          acceptedUnitIds: [],
        })),
      }).state,
    ).toBe("LOCAL_SAVE_FAILED");
    store.note("k", result({ local: { kind: "nothing" } }));
    expect(store.failedOperations("k")).toEqual([]);
  });

  it("a commit the profile refused is a failed operation too; a read-only one is not", () => {
    const kept = (reason: "rejected" | "read-only") =>
      result({
        local: {
          kind: "kept",
          candidate: { candidateId: "op-3", projectionId: "p1", reason, sourceText: "x" },
        },
      });
    expect(projectionFact(kept("rejected")).failed).toBe("op-3");
    expect(projectionFact(kept("read-only")).failed).toBeNull();
    expect(projectionFact(kept("read-only")).facts.source).toBe("diverged");
  });

  it("a refused coalesced flush fails its projection; forgetting a projection clears it", () => {
    const store = new ProjectionFactsStore();
    store.fail("k", "p1", "op-2");
    expect(store.failedOperations("k")).toEqual(["op-2"]);
    store.forget("k", "p1");
    expect(store.failedOperations("k")).toEqual([]);
  });
});
