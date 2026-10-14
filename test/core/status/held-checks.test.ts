// LFCP-03-003: the lifecycle of the notes checked for held edits after a
// start, as sections-host drives it: found at the start, then a pass that
// succeeds, fails, or waits for a section's model; a retry after a failure.

import { describe, expect, it } from "vitest";
import { HeldChecks } from "../../../src/core/status/held-checks";

const none = new Set<string>();

describe("held checks after a start", () => {
  it("pending while the start indexes, then until each note's pass", () => {
    const c = new HeldChecks();
    c.begin();
    expect(c.state("r1")).toBe("pending");
    c.found("A.md", ["r1"]);
    c.found("B.md", ["r1", "r2"]);
    c.end();
    expect(c.state("r1")).toBe("pending");
    expect(c.state("r3")).toBe("checked");
    expect(c.passed("A.md", none)).toBe(true);
    expect(c.state("r1")).toBe("pending");
    expect(c.passed("B.md", none)).toBe(true);
    expect([c.state("r1"), c.state("r2")]).toEqual(["checked", "checked"]);
    // A later pass of a checked note changes nothing.
    expect(c.passed("B.md", none)).toBe(false);
  });

  it("a failed pass is unknown, not pending; the next pass that succeeds checks it", () => {
    const c = new HeldChecks();
    c.found("A.md", ["r1"]);
    expect(c.failed("A.md")).toBe(true);
    expect(c.state("r1")).toBe("failed");
    // Failing again says nothing new.
    expect(c.failed("A.md")).toBe(false);
    expect(c.passed("A.md", none)).toBe(true);
    expect(c.state("r1")).toBe("checked");
    // A note already checked is not made unknown by a later failure.
    expect(c.failed("A.md")).toBe(false);
    expect(c.state("r1")).toBe("checked");
  });

  it("a failed note decides over a pending one for the same section", () => {
    const c = new HeldChecks();
    c.found("A.md", ["r1"]);
    c.found("B.md", ["r1"]);
    c.failed("B.md");
    expect(c.state("r1")).toBe("failed");
  });

  it("a section whose model is loading waits for its next pass; the others are checked", () => {
    const c = new HeldChecks();
    c.found("A.md", ["r1", "r2"]);
    c.failed("A.md");
    expect(c.passed("A.md", new Set(["r2"]))).toBe(true);
    expect([c.state("r1"), c.state("r2")]).toEqual(["checked", "pending"]);
    c.passed("A.md", none);
    expect(c.state("r2")).toBe("checked");
  });

  it("rename keeps a note's check, failure included; delete drops it", () => {
    const c = new HeldChecks();
    c.found("A.md", ["r1"]);
    c.failed("A.md");
    c.renamed("A.md", "B.md");
    expect(c.state("r1")).toBe("failed");
    expect(c.passed("A.md", none)).toBe(false);
    c.deleted("B.md");
    expect(c.state("r1")).toBe("checked");
  });

  it("a note without sections is never pending", () => {
    const c = new HeldChecks();
    c.found("A.md", []);
    expect(c.passed("A.md", none)).toBe(false);
  });
});
