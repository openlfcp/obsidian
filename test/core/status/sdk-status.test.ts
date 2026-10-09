// LFCP-02-026 in the plugin: the SDK's status stream of a section Resource
// as the reducer's facts. Snapshot, ordered events, a skipped revision, a
// batch the server lost (pending again, ADR 0008), access and readiness.

import type { BatchStatus, StatusSnapshot } from "@openlfcp/client";
import { describe, expect, it } from "vitest";
import { applySdkEvent, fromSnapshot } from "../../../src/core/status/sdk-status";

const u = (n: number) => new Uint8Array(32).fill(n) as never;
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const batch = (status: BatchStatus["status"], accepted: number[]): BatchStatus => ({
  operationId: "op-1",
  status,
  unitIds: [u(1), u(2)],
  acceptedUnitIds: accepted.map(u),
  affectedNodeIds: ["n1"],
});
const snapshot = {
  revision: 4,
  batches: [batch("pending", [])],
  received: { held: [], waiting: [], refused: [] },
  section: "ready",
  // The access as 027 reports it (AccessState): only the fields the plugin reads.
  access: {
    allowed: true,
    reason: null,
    controlHead: null,
    verifiedAt: null,
    current: true,
    pendingControl: [],
  } as never,
} as unknown as StatusSnapshot;

describe("the SDK's status stream", () => {
  it("a snapshot: batches in hex, access in the port's terms", () => {
    const s = fromSnapshot(snapshot);
    expect(s.batches).toEqual([
      {
        id: "op-1",
        nodeIds: ["n1"],
        durable: true,
        unitIds: [hex(1), hex(2)],
        acceptedUnitIds: [],
      },
    ]);
    expect(s.access).toEqual({ allowed: true });
    expect(s).toMatchObject({ revision: 4, section: "ready", needsSnapshot: false });
  });

  it("events in order; an old one is ignored; a skipped revision asks for a snapshot", () => {
    let s = fromSnapshot(snapshot);
    s = applySdkEvent(s, { revision: 5, kind: "batch", ...batch("accepted", [1, 2]) });
    expect(s.batches[0]?.acceptedUnitIds).toEqual([hex(1), hex(2)]);
    expect(applySdkEvent(s, { revision: 5, kind: "section-state", state: "importing" })).toBe(s);
    const gap = applySdkEvent(s, { revision: 7, kind: "section-state", state: "importing" });
    expect(gap).toMatchObject({ needsSnapshot: true, revision: 7, section: "ready" });
  });

  it("the server lost accepted units: the batch is pending again (ADR 0008)", () => {
    let s = fromSnapshot({ ...snapshot, batches: [batch("accepted", [1, 2])] });
    s = applySdkEvent(s, { revision: 5, kind: "reoffered", unitIds: [u(2)], reason: "have-gap" });
    expect(s.batches[0]?.acceptedUnitIds).toEqual([hex(1)]);
    // And the batch event that follows replaces it, never unions.
    s = applySdkEvent(s, { revision: 6, kind: "batch", ...batch("pending", []) });
    expect(s.batches[0]?.acceptedUnitIds).toEqual([]);
  });

  it("acknowledged without evidence; rejection; access; readiness", () => {
    let s = fromSnapshot(snapshot);
    s = applySdkEvent(s, { revision: 5, kind: "batch", ...batch("evidence-unavailable", []) });
    expect(s.unconfirmed.has("op-1")).toBe(true);
    s = applySdkEvent(s, {
      revision: 6,
      kind: "batch",
      ...batch("rejected", []),
      rejection: { code: "AUTHORIZATION_FAILED", unitIds: [u(1)] },
    });
    expect(s.unconfirmed.has("op-1")).toBe(false);
    expect(s.batches[0]?.rejection).toEqual({ code: "AUTHORIZATION_FAILED", unitIds: [hex(1)] });
    s = applySdkEvent(s, {
      revision: 7,
      kind: "access",
      access: {
        allowed: false,
        reason: "revoked",
        controlHead: null,
        verifiedAt: 5,
        current: false,
        pendingControl: [{ recordId: new Uint8Array(32), type: "GRANT_REVOKE" }],
      } as never,
    });
    expect(s.access).toEqual({ allowed: false, reason: "revoked", verifiedAt: 5 });
    expect(s).toMatchObject({ accessCurrent: false, pendingControl: ["GRANT_REVOKE"] });
    s = applySdkEvent(s, { revision: 8, kind: "received", fact: "held", unitIds: [u(9)] });
    expect(s.revision).toBe(8);
  });
});
