// LFCP-03-005 (F-C05, F-C06; U03-17, U03-28): access and connection facts
// reach the view, the card, the badge and the vault summary without losing
// what the SDK knows. Access keeps verifiedAt/current and each denial apart
// (read-only, revoked, not-member, server-refused, key-unavailable,
// unknown). The connection says "connecting" and "failed" only from the
// session's own transitions; without evidence it is offline, qualified so.
// Pure: facts in, surfaces out.

import { describe, expect, it } from "vitest";
import type { TransportFact } from "../../../src/core/lfcp/transport";
import type { WriteAccess } from "../../../src/core/sections/port";
import { headingBadge } from "../../../src/core/status/badge";
import { sectionCard } from "../../../src/core/status/card";
import {
  connectionFact,
  type ObservedSection,
  observedFacts,
} from "../../../src/core/status/facts";
import {
  type BatchFacts,
  type ConnectionQualifier,
  type StatusFacts,
  statusView,
} from "../../../src/core/status/reducer";
import type { SdkStatus } from "../../../src/core/status/sdk-status";
import { vaultSyncSummary } from "../../../src/core/status/summary";

const VERIFIED = Date.UTC(2026, 9, 15, 9, 0);

const sdk = (access: WriteAccess | null, accessCurrent: boolean | null): SdkStatus => ({
  revision: 1,
  batches: [],
  unconfirmed: new Set(),
  access,
  accessCurrent,
  pendingControl: [],
  section: "ready",
  catchUp: "current-at-checkpoint",
  needsSnapshot: false,
});

const observed = (o: Partial<ObservedSection> = {}): ObservedSection => ({
  session: "s",
  load: { ready: true, loaded: true },
  phase: "LIVE",
  wasLive: true,
  problems: [],
  projections: [],
  sdk: sdk({ allowed: true, verifiedAt: VERIFIED }, true),
  ...o,
});

/** Queue empty, caught up, connected, a writer verified current. */
const quiet: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  accessVerifiedAt: VERIFIED,
  accessCurrent: true,
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [],
};

const waiting: BatchFacts = {
  id: "b1",
  nodeIds: ["n1"],
  durable: true,
  unitIds: ["u1"],
  acceptedUnitIds: [],
};

function surfaces(facts: StatusFacts) {
  const view = statusView(facts);
  const card = sectionCard({ title: "Plan", view, resource: "BwcH", sectionId: "s1" });
  const badge = headingBadge("Plan", view);
  const text = [card.status, ...card.facts, ...card.problems].join(" ");
  return { view, card, badge, text };
}

const t = (state: TransportFact["state"], cause: TransportFact["cause"] = null): TransportFact => ({
  state,
  cause,
});

describe("access facts (F-C05, U03-17)", () => {
  it("each SDK reason stays its own access value, with verifiedAt and current", () => {
    const cases: [WriteAccess, StatusFacts["access"]][] = [
      [{ allowed: true }, "writer"],
      [{ allowed: false, reason: "read-only" }, "reader"],
      [{ allowed: false, reason: "revoked" }, "revoked"],
      [{ allowed: false, reason: "not-member" }, "not-member"],
      [{ allowed: false, reason: "server-refused" }, "refused"],
      [{ allowed: false, reason: "key-unavailable" }, "unavailable-key"],
      [{ allowed: false, reason: "unknown" }, "unknown"],
    ];
    const seen = new Set<string>();
    for (const [answer, access] of cases) {
      const view = statusView(
        observedFacts(observed({ sdk: sdk({ ...answer, verifiedAt: VERIFIED }, false) })),
      );
      expect(view.access).toMatchObject({ access, verifiedAt: VERIFIED, current: false });
      seen.add(view.access.access);
    }
    // Seven reasons, seven values: none collapsed into another.
    expect(seen.size).toBe(cases.length);
  });

  it("no SDK answer yet: unknown, with no as-of (never a default)", () => {
    const view = statusView(observedFacts(observed({ sdk: undefined })));
    expect(view.access).toEqual({
      access: "unknown",
      verifiedAt: null,
      current: null,
      checking: false,
    });
    // Never verified: verifiedAt null, current unknown.
    const never = statusView(
      observedFacts(observed({ sdk: sdk({ allowed: false, reason: "unknown" }, null) })),
    );
    expect(never.access).toMatchObject({ verifiedAt: null, current: null });
  });

  it("a stale Control view is being checked; a removal is not, and says it may have changed", () => {
    const stale = surfaces({ ...quiet, accessCurrent: false, accessChecking: true });
    expect(stale.view.access).toEqual({
      access: "writer",
      verifiedAt: VERIFIED,
      current: false,
      checking: true,
    });
    expect(stale.view.sync.current).toBe(false);
    const removed = surfaces({
      ...quiet,
      access: "revoked",
      accessCurrent: false,
      accessChecking: true,
    });
    expect(removed.view.access.checking).toBe(false);
    expect(removed.card.problems[0]).toBe(
      "Your access to this section was removed. Your local copy stays; new edits are kept on this device only. This is as this device last verified it; it may have changed.",
    );
    const confirmed = surfaces({ ...quiet, access: "revoked" });
    expect(confirmed.card.problems[0]).not.toMatch(/may have changed/);
  });

  it("read-only, revoked, not-member and refused are four different sentences", () => {
    const text = (access: StatusFacts["access"]) => surfaces({ ...quiet, access }).text;
    const reader = text("reader");
    const revoked = text("revoked");
    const notMember = text("not-member");
    const refused = text("refused");
    expect(reader).toMatch(/You can read this section, not edit it/);
    expect(revoked).toMatch(/Your access to this section was removed/);
    expect(revoked).not.toMatch(/not a member/);
    expect(notMember).toMatch(/This vault is not a member of this section/);
    expect(notMember).not.toMatch(/access to this section was removed/);
    expect(refused).toMatch(/The sync server no longer accepts changes from this vault/);
    expect(refused).not.toMatch(/Offline|access to this section was removed/);
    expect(new Set([reader, revoked, notMember, refused]).size).toBe(4);
  });

  it("a server refusal of the Resource is neither offline nor connecting", () => {
    for (const connection of ["offline", "connecting", "failed"] as const) {
      const s = surfaces({ ...quiet, connection, refusal: "RESOURCE_NOT_HOSTED" });
      expect(s.view.state).toBe("ATTENTION");
      expect(s.view.refusal).toBe("RESOURCE_NOT_HOSTED");
      expect(s.view.conditions.map((c) => c.kind)).not.toContain("offline");
      expect(s.view.conditions.map((c) => c.kind)).not.toContain("connecting");
    }
    expect(surfaces(quiet).view.refusal).toBeNull();
  });
});

describe("connection facts (F-C06, U03-28)", () => {
  it("the mapping table: phase and transport to connection and qualifier", () => {
    const rows: [boolean, TransportFact, StatusFacts["connection"], string | null][] = [
      [true, t("ready"), "connected", null],
      // A Resource open in a session: its transport's last word does not matter.
      [true, t("none"), "connected", null],
      [false, t("none"), "offline", "no-evidence"],
      [false, t("connecting"), "connecting", null],
      [false, t("ready"), "offline", "not-syncing"],
      [false, t("lost"), "offline", "lost"],
      [false, t("lost", "not-responding"), "offline", "not-responding"],
      [false, t("lost", "network-offline"), "offline", "network-offline"],
      [false, t("failed"), "failed", null],
      [false, t("failed", "not-responding"), "failed", "not-responding"],
      [false, t("failed", "network-offline"), "offline", "network-offline"],
    ];
    for (const [open, transport, connection, qualifier] of rows)
      expect(connectionFact(open, transport)).toEqual({
        connection,
        connectionQualifier: qualifier,
      });
  });

  it("observedFacts: LIVE and catching up are connected; no transport evidence is offline, qualified", () => {
    for (const phase of ["LIVE", "OPENING", "CONTROL_SYNC", "KEY_SYNC", "DATA_SYNC"])
      expect(observedFacts(observed({ phase, transport: t("failed") })).connection).toBe(
        "connected",
      );
    const none = observedFacts(observed({ phase: "CLOSED" }));
    expect([none.connection, none.connectionQualifier]).toEqual(["offline", "no-evidence"]);
    expect(statusView(none).connectionQualifier).toBe("no-evidence");
    const connecting = observedFacts(observed({ phase: "CLOSED", transport: t("connecting") }));
    expect(connecting.connection).toBe("connecting");
    // Facts built without the qualifier (older callers) read as no evidence, never as failed.
    expect(statusView({ ...quiet, connection: "offline" }).connectionQualifier).toBe("no-evidence");
  });

  it("connecting is never current, and the shared model is not claimed while it lasts", () => {
    const s = surfaces({ ...quiet, connection: "connecting" });
    expect(s.view.state).toBe("LOADING");
    expect(s.view.label).toBe("Connecting to the server");
    expect(s.view.sync.current).toBe(false);
    expect(s.view.connection).toBe("connecting");
    expect(s.view.connectionQualifier).toBeNull();
    expect(s.text).not.toMatch(/Current as last checked|Offline|failed|Could not connect/);
    expect(s.card.facts).toContain(
      "Connecting to the server: not checked with it yet. Local updates wait on this device.",
    );
    expect(s.badge.accessibleName).toContain("connecting to the server");
    // Receiving when the connection went: unknown, not "catching up", until it is up again.
    const receiving = statusView({ ...quiet, connection: "connecting", catchUp: "receiving" });
    expect(receiving.sync.sharedModel).toBe("unknown");
    // Pending work while connecting: saved here, waiting (SI04), still not current.
    const pending = statusView({ ...quiet, connection: "connecting", batches: [waiting] });
    expect(pending.state).toBe("LOCAL_DURABLE");
    expect(pending.conditions.map((c) => c.kind)).toEqual(["pending", "connecting"]);
    expect(pending.sync.current).toBe(false);
  });

  it("failed and offline read differently; offline never says failed", () => {
    const failed = surfaces({ ...quiet, connection: "failed", connectionQualifier: null });
    expect(failed.view.state).toBe("OFFLINE");
    expect(failed.view.label).toBe("Could not connect to the server; local updates will wait");
    expect(failed.card.facts).toContain(
      "Could not connect to the server; trying again. Local updates wait on this device.",
    );
    expect(failed.badge.accessibleName).toContain("could not connect to the server");
    expect(failed.view.sync.sharedModel).toBe("accepted");
    expect(failed.view.sync.current).toBe(false);
    for (const q of [
      "no-evidence",
      "lost",
      "not-syncing",
      "network-offline",
      "not-responding",
    ] as const) {
      const offline = surfaces({ ...quiet, connection: "offline", connectionQualifier: q });
      expect(offline.view.state).toBe("OFFLINE");
      // M2: with no evidence the section is not checked yet, never "Offline".
      expect(offline.view.label).toBe(
        q === "no-evidence"
          ? "Not checked with the server yet; local updates will wait"
          : "Offline; local updates will wait",
      );
      expect(offline.view.connectionQualifier).toBe(q);
      expect(offline.text).not.toMatch(/fail/i);
      expect(offline.view.sync.current).toBe(false);
    }
    expect(
      surfaces({ ...quiet, connection: "offline", connectionQualifier: "network-offline" }).card
        .facts,
    ).toContain("Offline (no network): local updates wait on this device.");
  });

  it("the reducer and the card agree: one connection line, matching the view", () => {
    const line =
      /Connecting to the server|Could not connect|stopped responding|Offline|Not checked with the server/;
    const cases: [StatusFacts["connection"], ConnectionQualifier | null, RegExp | null][] = [
      ["connected", null, null],
      ["connecting", null, /^Connecting to the server/],
      ["failed", null, /^Could not connect/],
      ["failed", "not-responding", /^The server stopped responding/],
      ["offline", "lost", /^Offline: local/],
      ["offline", "no-evidence", /^Not checked with the server yet/],
      ["offline", "not-responding", /^Offline: the server stopped responding/],
      ["offline", "network-offline", /^Offline \(no network\)/],
    ];
    for (const [connection, connectionQualifier, expected] of cases) {
      const s = surfaces({ ...quiet, connection, connectionQualifier });
      const lines = s.card.facts.filter((f) => line.test(f));
      if (expected === null) expect(lines).toEqual([]);
      else {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(expected);
      }
      expect(s.view.connection).toBe(connection);
    }
  });

  it("the vault summary counts sections by connection and access not verified current", () => {
    const sum = vaultSyncSummary([
      statusView(quiet),
      statusView({ ...quiet, connection: "connecting" }),
      statusView({ ...quiet, connection: "failed", connectionQualifier: null }),
      statusView({ ...quiet, connection: "offline", accessCurrent: false }),
      statusView({ ...quiet, access: "unknown", accessVerifiedAt: null, accessCurrent: null }),
    ]);
    expect(sum.connection).toEqual({ connected: 2, connecting: 1, failed: 1, offline: 1 });
    expect(sum.accessNotCurrent).toBe(2);
    expect(sum.current).toBe(1);
  });
});
