// LFCP-04-406 (V_notice): what a section past its identity barrier says
// (WIRE §100.1). One condition, "newer-version", first among the problems:
// the card, the pane's word and the problem row say "update the plugin",
// never offline, connecting, loading or a chain error.

import { describe, expect, it } from "vitest";
import { BARRIER_ENTRY_TEXT, IDENTITY_BLOCKED } from "../../../src/core/lfcp/identity-barrier";
import { sectionFace } from "../../../src/core/pane/state-card";
import { sectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

describe("what the section says past its barrier", () => {
  const base: StatusFacts = {
    session: "s",
    revision: 1,
    replica: "loaded",
    access: "writer",
    pendingControl: [],
    connection: "connected",
    catchUp: "receiving",
    problems: [],
    batches: [],
    acceptanceEvidence: "unavailable",
    projections: [],
  };

  it("attention with the update message, not loading, offline or a chain error", () => {
    for (const connection of ["connected", "offline", "connecting"] as const) {
      const v = statusView({ ...base, connection, newerVersion: true });
      expect(v.state).toBe("ATTENTION");
      expect(v.conditions[0]).toEqual({ kind: "newer-version" });
      expect(v.conditions.some((c) => c.kind === "offline" || c.kind === "connecting")).toBe(false);
    }
    const card = sectionCard({
      title: "Launch",
      view: statusView({ ...base, newerVersion: true }),
      resource: "r",
      sectionId: "s",
    });
    expect(card.problems[0]).toContain(IDENTITY_BLOCKED);
    expect(card.facts).toContain("Not synced: this section needs a newer version of Shared Tasks.");
    const face = sectionFace(statusView({ ...base, newerVersion: true }), {
      shared: null,
      local: false,
      unplaced: false,
    });
    expect(face).toMatchObject({ word: "Update needed", problem: true });
    expect(face.fact).toContain("linked devices");
  });

  it("every entry has words for Resource status", () => {
    expect(Object.keys(BARRIER_ENTRY_TEXT).sort()).toEqual([
      "device-grant",
      "device-revoke",
      "genesis-device",
      "transfer-device",
    ]);
  });
});
