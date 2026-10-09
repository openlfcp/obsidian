// LFCP-02-057: the pure status reducer, on mock facts (unit evidence, not
// a host or server run). OBSIDIAN-SYNC-INDICATORS-01 §10 SI01–SI19, and the
// event races of §10: a delayed ACK after a new edit, another Resource's
// status, a resolved conflict followed by a new one, a disconnect during
// catch-up, a revision gap, duplicate and partial acceptance. Inputs are
// frozen: the reducer mutates nothing.

import { describe, expect, it } from "vitest";
import {
  applyEvent,
  type BatchFacts,
  pendingUnder,
  type StatusFacts,
  type StatusStore,
  statusView,
  storeView,
} from "../../../src/core/status/reducer";

function freeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

/** Healthy and current unless a case says otherwise. */
const healthy: StatusFacts = freeze({
  session: "s1",
  revision: 1,
  replica: "loaded",
  access: "writer",
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [{ id: "p1", source: "clean", application: "current" }],
});
const facts = (change: Partial<StatusFacts>): StatusFacts => freeze({ ...healthy, ...change });
const batch = (id: string, b: Partial<BatchFacts> = {}): BatchFacts => ({
  id,
  nodeIds: ["n1"],
  durable: true,
  unitIds: [`${id}-u1`],
  acceptedUnitIds: [],
  ...b,
});
const acceptedBatch = (id: string) => batch(id, { acceptedUnitIds: [`${id}-u1`] });
const kinds = (f: StatusFacts) => statusView(f).conditions.map((c) => c.kind);

describe("OBSIDIAN-SYNC-INDICATORS-01 §10", () => {
  it("SI01: a marker without a loaded replica is LOADING, never CURRENT", () => {
    expect(statusView(facts({ replica: "not-loaded" })).state).toBe("LOADING");
    expect(statusView(facts({ replica: "importing" })).state).toBe("LOADING");
  });

  it("SI02: a source edit without a durable commit is LOCAL_EDIT, over prior success", () => {
    const v = statusView(
      facts({
        projections: [{ id: "p1", source: "editing", application: "current" }],
        batches: [acceptedBatch("old")],
      }),
    );
    expect(v.state).toBe("LOCAL_EDIT");
    expect(v.acceptedBatches).toBe(1);
    expect(statusView(facts({ batches: [batch("b", { durable: false })] })).state).toBe(
      "LOCAL_EDIT",
    );
  });

  it("SI03: a durable batch while offline: OFFLINE, with the saved and pending facts", () => {
    const v = statusView(facts({ connection: "offline", batches: [batch("b")] }));
    expect(v.state).toBe("OFFLINE");
    expect(v.pendingBatches).toBe(1);
    expect(kinds(facts({ connection: "offline", batches: [batch("b")] }))).toEqual([
      "offline",
      "pending",
    ]);
  });

  it("SI04: sent without acceptance evidence is SENDING, not accepted", () => {
    const v = statusView(facts({ batches: [batch("b")] }));
    expect(v.state).toBe("SENDING");
    expect(v.acceptedBatches).toBe(0);
    // Before the session is up: saved locally, waiting.
    expect(statusView(facts({ connection: "connecting", batches: [batch("b")] })).state).toBe(
      "LOCAL_DURABLE",
    );
  });

  it("SI05: everything accepted, catch-up still receiving: ACCEPTED_CATCHING_UP", () => {
    expect(statusView(facts({ catchUp: "receiving", batches: [acceptedBatch("b")] })).state).toBe(
      "ACCEPTED_CATCHING_UP",
    );
  });

  it("SI06: accepted, caught up, valid, applied: CURRENT, qualified", () => {
    const v = statusView(facts({ batches: [acceptedBatch("b")] }));
    expect(v.state).toBe("CURRENT");
    expect(v.label).toBe("No pending local changes; current as last checked");
  });

  it("SI07: accepted units with a scalar conflict: ATTENTION, the acceptance kept", () => {
    const v = statusView(
      facts({
        batches: [acceptedBatch("b")],
        problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds: ["n1"] }],
      }),
    );
    expect(v.state).toBe("ATTENTION");
    expect(v.acceptedBatches).toBe(1);
    expect(v.projectionPaused).toBe(false);
  });

  it("SI08: accepted units with a cycle: ATTENTION, structural projection paused", () => {
    const v = statusView(
      facts({
        batches: [acceptedBatch("b")],
        problems: [{ kind: "structural", code: "PARENT_CYCLE", nodeIds: ["n1", "n2"] }],
      }),
    );
    expect(v.state).toBe("ATTENTION");
    expect(v.projectionPaused).toBe(true);
  });

  it("SI09: current, then the network is lost: OFFLINE, past acceptance kept", () => {
    const v = statusView(facts({ connection: "offline", batches: [acceptedBatch("b")] }));
    expect(v.state).toBe("OFFLINE");
    expect(v.acceptedBatches).toBe(1);
  });

  it("SI10: one unit sent five times is one pending batch", () => {
    let store: StatusStore = { facts: healthy, needsSnapshot: false };
    for (let i = 0; i < 5; i++)
      store = applyEvent(store, { kind: "batch", session: "s1", batch: batch("b") });
    expect(storeView(store).pendingBatches).toBe(1);
  });

  it("SI11: a batch of two units with one accepted stays pending", () => {
    let store: StatusStore = {
      facts: facts({ batches: [batch("b", { unitIds: ["u1", "u2"] })] }),
      needsSnapshot: false,
    };
    store = applyEvent(store, { kind: "accepted", session: "s1", unitIds: ["u1"] });
    expect(storeView(store).pendingBatches).toBe(1);
    store = applyEvent(store, { kind: "accepted", session: "s1", unitIds: ["u2"] });
    expect(storeView(store)).toMatchObject({ pendingBatches: 0, state: "CURRENT" });
  });

  it("SI12: two projections, one broken: it alone is ATTENTION; the Resource says so", () => {
    const v = statusView(
      facts({
        projections: [
          { id: "broken", source: "binding-error", application: "blocked" },
          { id: "healthy", source: "clean", application: "current" },
        ],
      }),
    );
    expect(v.projections).toEqual({ broken: "ATTENTION", healthy: "CURRENT" });
    expect(v.state).toBe("ATTENTION");
  });

  it("SI13: a pending child under a folded parent shows on the parent, located on the child", () => {
    const v = statusView(facts({ batches: [batch("b", { nodeIds: ["child"] })] }));
    expect(pendingUnder(v, ["child", "sibling"])).toEqual({ any: true, nodeIds: ["child"] });
    expect(v.pendingNodeIds.has("parent")).toBe(false);
    // Without node attribution: section-level progress only.
    expect(statusView(facts({ batches: [batch("b", { nodeIds: [] })] })).unattributed).toBe(true);
  });

  it("SI14: a removal requested and not committed is pending, not done", () => {
    const v = statusView(facts({ pendingControl: ["remove-member"] }));
    expect(v.conditions).toContainEqual({ kind: "control-pending", actions: ["remove-member"] });
    expect(v.state).toBe("SENDING");
  });

  it("SI15: access revoked with work queued offline: ATTENTION; the work kept", () => {
    const v = statusView(
      facts({ access: "revoked", connection: "offline", batches: [batch("b")] }),
    );
    expect(v.state).toBe("ATTENTION");
    expect(v.pendingBatches).toBe(1);
    expect(v.conditions[0]).toEqual({ kind: "access", access: "revoked" });
  });

  it("SI16: an empty queue with an unknown base: ATTENTION, not CURRENT", () => {
    expect(
      statusView(
        facts({ projections: [{ id: "p1", source: "base-unknown", application: "blocked" }] }),
      ).state,
    ).toBe("ATTENTION");
  });

  it("SI17: a failed storage commit: LOCAL_SAVE_FAILED, no saved-local claim", () => {
    const v = statusView(
      facts({ batches: [batch("b", { durable: false, failed: true }), acceptedBatch("old")] }),
    );
    expect(v.state).toBe("LOCAL_SAVE_FAILED");
    expect(v.pendingBatches).toBe(0);
    expect(v.acceptedBatches).toBe(1);
  });

  it("SI18: no local writes, read-only, caught up: READ_ONLY_CURRENT, nothing 'sent'", () => {
    const v = statusView(facts({ access: "reader" }));
    expect(v).toMatchObject({ state: "READ_ONLY_CURRENT", acceptedBatches: 0, readOnly: true });
  });

  it("SI19: no acceptance mapping: EVIDENCE_UNKNOWN after local durability", () => {
    const v = statusView(facts({ acceptanceEvidence: "unavailable", batches: [batch("b")] }));
    expect(v.state).toBe("EVIDENCE_UNKNOWN");
    expect(v.acceptedBatches).toBe(0);
    // Nothing local: no question to answer.
    expect(statusView(facts({ acceptanceEvidence: "unavailable" })).state).toBe("CURRENT");
  });
});

describe("priority and races", () => {
  it("an ACK never clears a conflict, and old success never masks a failure", () => {
    expect(
      kinds(
        facts({
          batches: [acceptedBatch("a"), batch("f", { durable: false, failed: true })],
          problems: [{ kind: "scalar", code: "X", nodeIds: [] }],
          connection: "offline",
        }),
      ),
    ).toEqual(["save-failed", "scalar-conflict", "offline"]);
  });

  it("a delayed ACK after a new edit clears only its own units", () => {
    let store: StatusStore = { facts: facts({ batches: [batch("old")] }), needsSnapshot: false };
    store = applyEvent(store, { kind: "batch", session: "s1", batch: batch("new") });
    store = applyEvent(store, { kind: "accepted", session: "s1", unitIds: ["old-u1"] });
    store = applyEvent(store, { kind: "accepted", session: "s1", unitIds: ["old-u1"] });
    expect(storeView(store)).toMatchObject({
      pendingBatches: 1,
      acceptedBatches: 1,
      state: "SENDING",
    });
  });

  it("another Resource session's status changes nothing", () => {
    const store: StatusStore = { facts: facts({ batches: [batch("b")] }), needsSnapshot: false };
    expect(applyEvent(store, { kind: "accepted", session: "other", unitIds: ["b-u1"] })).toBe(
      store,
    );
    expect(
      applyEvent(store, {
        kind: "patch",
        session: "other",
        revision: 2,
        change: { connection: "offline" },
      }),
    ).toBe(store);
  });

  it("a resolved conflict followed by a new one stays actionable", () => {
    let store: StatusStore = {
      facts: facts({ problems: [{ kind: "scalar", code: "X", nodeIds: ["n1"] }] }),
      needsSnapshot: false,
    };
    store = applyEvent(store, {
      kind: "patch",
      session: "s1",
      revision: 2,
      change: { problems: [] },
    });
    expect(storeView(store).state).toBe("CURRENT");
    store = applyEvent(store, {
      kind: "patch",
      session: "s1",
      revision: 3,
      change: { problems: [{ kind: "structural", code: "PLACEMENT", nodeIds: ["n2"] }] },
    });
    expect(storeView(store).state).toBe("ATTENTION");
  });

  it("a disconnect during catch-up is never CURRENT: offline, the catch-up waits for a session (§5 decision)", () => {
    const v = statusView(facts({ catchUp: "receiving", connection: "offline" }));
    expect(v.state).toBe("OFFLINE");
    expect(v.conditions.map((c) => c.kind)).toEqual(["offline"]);
    // Connected again, still catching up: not current.
    expect(statusView(facts({ catchUp: "receiving" })).state).toBe("LOADING");
  });

  it("a revision gap asks for a snapshot and shows unknown; a stale patch is ignored", () => {
    let store: StatusStore = { facts: healthy, needsSnapshot: false };
    const stale = applyEvent(store, {
      kind: "patch",
      session: "s1",
      revision: 1,
      change: { connection: "offline" },
    });
    expect(stale).toBe(store);
    store = applyEvent(store, {
      kind: "patch",
      session: "s1",
      revision: 3,
      change: { problems: [] },
    });
    expect(store.needsSnapshot).toBe(true);
    expect(storeView(store).state).toBe("LOADING");
    store = applyEvent(store, { kind: "snapshot", facts: facts({ revision: 4 }) });
    expect(store.needsSnapshot).toBe(false);
    expect(storeView(store).state).toBe("CURRENT");
  });

  it("a rejection keeps the batch, listed and no longer pending", () => {
    let store: StatusStore = { facts: facts({ batches: [batch("b")] }), needsSnapshot: false };
    store = applyEvent(store, {
      kind: "rejected",
      session: "s1",
      unitIds: ["b-u1"],
      code: "AUTHORIZATION_FAILED",
    });
    const v = storeView(store);
    expect(v.state).toBe("ATTENTION");
    expect(v.conditions[0]).toEqual({
      kind: "rejected",
      batchIds: ["b"],
      code: "AUTHORIZATION_FAILED",
    });
    expect(store.facts.batches).toHaveLength(1);
  });

  it("is pure: the same facts give the same view, frozen input untouched", () => {
    const f = facts({ batches: [batch("b")], connection: "offline" });
    const a = statusView(f);
    const b = statusView(f);
    expect(a).toEqual(b);
    expect(Object.isFrozen(f)).toBe(true);
  });
});
