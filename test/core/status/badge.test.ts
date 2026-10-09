// LFCP-02-058: the heading badge, quiet rows with their aggregate cues
// (SI12, SI13), and the provisional facts from what the plugin observes:
// never an invented acceptance. Unit evidence on mock facts.

import { describe, expect, it } from "vitest";
import { headingBadge, rowCues, SYNC_ICON } from "../../../src/core/status/badge";
import { type ObservedSection, observedFacts } from "../../../src/core/status/facts";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";
import type { SdkStatus } from "../../../src/core/status/sdk-status";

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

describe("facts from the SDK's status and local observations", () => {
  const sdk = (b: Partial<SdkStatus> = {}): SdkStatus => ({
    revision: 3,
    batches: [],
    unconfirmed: new Set(),
    access: { allowed: true },
    accessCurrent: true,
    pendingControl: [],
    section: "ready",
    catchUp: "current-at-checkpoint",
    needsSnapshot: false,
    ...b,
  });
  const observed: ObservedSection = {
    session: "s",
    load: { ready: true, loaded: true },
    phase: "LIVE",
    wasLive: true,
    problems: [],
    projections: [{ id: "p", source: "clean", application: "current" }],
    sdk: sdk(),
  };
  const batch = (id: string, accepted: string[] = []) => ({
    id,
    nodeIds: ["n1"],
    durable: true,
    unitIds: ["a", "b"],
    acceptedUnitIds: accepted,
  });

  it("accepted only by the SDK's evidence; acknowledged without it is EVIDENCE_UNKNOWN", () => {
    expect(
      statusView(observedFacts({ ...observed, sdk: sdk({ batches: [batch("x")] }) })).state,
    ).toBe("SENDING");
    const unconfirmed = observedFacts({
      ...observed,
      sdk: sdk({ batches: [batch("x")], unconfirmed: new Set(["x"]) }),
    });
    expect(statusView(unconfirmed).state).toBe("EVIDENCE_UNKNOWN");
    const done = statusView(
      observedFacts({ ...observed, sdk: sdk({ batches: [batch("x", ["a", "b"])] }) }),
    );
    expect(done).toMatchObject({ state: "CURRENT", acceptedBatches: 1 });
  });

  it("after a restart, queued units the SDK's batches do not know stay pending, never accepted (LFCP-02-066)", () => {
    for (const phase of ["CLOSED", "OPENING", "LIVE"]) {
      const v = statusView(
        observedFacts({
          ...observed,
          phase,
          wasLive: false,
          sdk: sdk({ batches: [] }),
          queuedUnits: 1,
        }),
      );
      expect(v.state).not.toMatch(/ACCEPTED_CATCHING_UP|CURRENT/);
      expect(v.pendingBatches).toBe(1);
      // No stable identity: "pending changes", not a count (§4).
      expect(v.pendingCounted).toBe(false);
    }
    // Units the SDK's batches account for are not counted twice.
    const known = statusView(
      observedFacts({ ...observed, sdk: sdk({ batches: [batch("x")] }), queuedUnits: 2 }),
    );
    expect(known.pendingBatches).toBe(1);
  });

  it("after a restart without a session: offline with the saved work, not catching up (SI03; §5 decision)", () => {
    const restarted = {
      ...observed,
      wasLive: false,
      queuedUnits: 1,
      sdk: sdk({ batches: [], catchUp: "not-started" }),
    };
    // Not connected: offline speaks, the saved update stays pending, never accepted.
    const off = statusView(observedFacts({ ...restarted, phase: "CLOSED" }));
    expect(off.state).toBe("OFFLINE");
    expect(off.pendingBatches).toBe(1);
    expect(off.conditions.map((c) => c.kind)).toContain("pending");
    // Connected again: catching up until verified, never current before.
    const on = statusView(observedFacts({ ...restarted, phase: "OPENING" }));
    expect(on.state).not.toMatch(/CURRENT|OFFLINE/);
    expect(on.conditions.map((c) => c.kind)).toContain("catching-up");
    // A replica not loaded is still loading, connected or not.
    expect(
      statusView(observedFacts({ ...restarted, phase: "CLOSED", load: undefined })).state,
    ).toBe("LOADING");
  });

  it("before the first snapshot, importing, a skipped revision: never current", () => {
    expect(statusView(observedFacts({ ...observed, sdk: undefined })).state).toBe("LOADING");
    expect(
      statusView(observedFacts({ ...observed, sdk: sdk({ section: "importing" }) })).state,
    ).toBe("LOADING");
    expect(
      statusView(observedFacts({ ...observed, sdk: sdk({ needsSnapshot: true }) })).state,
    ).toBe("LOADING");
  });

  it("maps the session phase: offline keeps the checkpoint; syncing is receiving; a blocked key is attention", () => {
    expect(statusView(observedFacts({ ...observed, phase: "CLOSED" })).state).toBe("OFFLINE");
    expect(
      statusView(
        observedFacts({
          ...observed,
          phase: "CLOSED",
          wasLive: false,
          sdk: sdk({ catchUp: "not-started" }),
        }),
      ).state,
      // Not connected, the replica loaded: offline, not catching up (§5 decision, SI03).
    ).toBe("OFFLINE");
    expect(
      statusView(
        observedFacts({ ...observed, phase: "DATA_SYNC", sdk: sdk({ catchUp: "receiving" }) }),
      ).state,
    ).toBe("LOADING");
    expect(statusView(observedFacts({ ...observed, phase: "KEY_BLOCKED" })).state).toBe(
      "ATTENTION",
    );
    expect(statusView(observedFacts({ ...observed, load: undefined })).state).toBe("LOADING");
  });

  it("access from the SDK's answer (§6)", () => {
    const state = (access: SdkStatus["access"]) =>
      statusView(observedFacts({ ...observed, sdk: sdk({ access }) })).state;
    expect(state({ allowed: false, reason: "read-only" })).toBe("READ_ONLY_CURRENT");
    expect(state({ allowed: false, reason: "revoked" })).toBe("ATTENTION");
    expect(state({ allowed: false, reason: "not-member" })).toBe("ATTENTION");
    expect(state({ allowed: false, reason: "key-unavailable" })).toBe("ATTENTION");
    expect(state(null)).toBe("LOADING");
  });

  it("027: a Control view behind the server's is 'being checked'; our pending Control is pending (SI14)", () => {
    const checking = statusView(observedFacts({ ...observed, sdk: sdk({ accessCurrent: false }) }));
    expect(checking).toMatchObject({
      state: "LOADING",
      label: "Access being checked with the server",
    });
    const revoking = statusView(
      observedFacts({ ...observed, sdk: sdk({ pendingControl: ["GRANT_REVOKE"] }) }),
    );
    expect(revoking.state).toBe("SENDING");
    expect(revoking.conditions).toContainEqual({
      kind: "control-pending",
      actions: ["GRANT_REVOKE"],
    });
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
