// LFCP-02-044: native undo/redo as compensating intents, never a rewind of
// shared history.

import { describe, expect, it } from "vitest";
import { planSection, type SectionState } from "../../../src/core/sections/base";
import { compensate, originOf, SessionLedger } from "../../../src/core/sections/undo";

const state = (rows: Record<string, string>): SectionState => ({
  title: "T",
  nodes: Object.fromEntries(
    Object.entries(rows).map(([id, text]) => [id, { kind: "paragraph", parent: null, text }]),
  ),
  order: { "": Object.keys(rows) },
});

describe("undo and redo (ARCHITECTURE-02 §7)", () => {
  it("reads the transaction's userEvent (ADR 0001 S1)", () => {
    expect([originOf("undo"), originOf("redo"), originOf("input.type"), originOf(null)]).toEqual([
      "undo",
      "redo",
      "other",
      "other",
    ]);
  });

  it("a text undo is a new edit back to the old value, planned like any edit", () => {
    const base = state({ a: "alpha, edited" });
    const plan = planSection(base, state({ a: "alpha" }), base);
    expect(plan.textEdits).toEqual([
      { nodeId: "a", edit: { index: 5, deleteCount: 8, insert: "" } },
    ]);
  });

  it("undo of a node this session created is a compensating delete; anything else missing is lost", () => {
    const ledger = new SessionLedger();
    ledger.created("new");
    expect(compensate("undo", ["new", "old"], [], ledger)).toEqual({
      deletes: ["new"],
      restores: [],
      lost: ["old"],
      unexplained: [],
    });
    // Without undo, even a node created here is not deleted by its absence alone.
    expect(compensate("other", ["new"], [], ledger).lost).toEqual(["new"]);
  });

  it("undo of a deletion restores (a fresh lifecycle operation); redo deletes again", () => {
    const ledger = new SessionLedger();
    ledger.deleted("gone");
    expect(compensate("undo", [], ["gone"], ledger).restores).toEqual(["gone"]);
    expect(compensate("redo", ["gone"], [], ledger).deletes).toEqual(["gone"]);
    // A deleted node pasted back by hand is not restored on its own.
    expect(compensate("other", [], ["gone"], ledger).unexplained).toEqual(["gone"]);
  });

  it("redo of a creation restores the node the undo deleted", () => {
    const ledger = new SessionLedger();
    ledger.created("new");
    expect(compensate("undo", ["new"], [], ledger).deletes).toEqual(["new"]);
    expect(compensate("redo", [], ["new"], ledger).restores).toEqual(["new"]);
  });
});
