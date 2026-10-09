// D1: a section whose model throws when read needs attention, and never
// freezes the other sections' statuses at their last state.

import { describe, expect, it } from "vitest";
import { collectStatuses, unreadableView } from "../../../src/core/status/collect";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const facts = (o: Partial<StatusFacts> = {}): StatusFacts => ({
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
  ...o,
});

describe("collectStatuses (D1)", () => {
  it("section X throws: X needs attention, section Y gets its fresh status", async () => {
    const keys = new Map<string, string>();
    let yConnection: StatusFacts["connection"] = "connected";
    let xThrows = false;
    const one = async (s: string) => {
      if (s === "x") {
        if (xThrows) throw new Error("poisoned replica");
        return { key: "X#1", view: statusView(facts()) };
      }
      return { key: "Y#1", view: statusView(facts({ connection: yConnection })) };
    };
    const first = await collectStatuses(["x", "y"], one, keys);
    expect(first.get("X#1")?.state).toBe("CURRENT");
    expect(first.get("Y#1")?.state).toBe("CURRENT");
    // X's model now throws, and Y goes offline: Y's badge must say so, not stay CURRENT.
    xThrows = true;
    yConnection = "offline";
    const next = await collectStatuses(["x", "y"], one, keys);
    expect(next.get("Y#1")?.state).toBe("OFFLINE");
    expect(next.get("X#1")?.state).toBe("ATTENTION");
    expect(next.get("X#1")?.conditions[0]).toEqual({ kind: "invalid-profile" });
  });

  it("a section that throws before it ever had a key is left out (unknown), never CURRENT", async () => {
    const out = await collectStatuses(
      ["x", "y"],
      async (s) => {
        if (s === "x") throw new Error("poisoned");
        return null;
      },
      new Map(),
    );
    expect(out.size).toBe(0);
  });

  it("the unreadable view: ATTENTION, not loading or current", () => {
    const v = unreadableView("x");
    expect(v.state).toBe("ATTENTION");
    expect(v.conditions[0]).toEqual({ kind: "invalid-profile" });
  });
});
