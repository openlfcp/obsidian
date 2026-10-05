import { describe, expect, it } from "vitest";
import { MutationGuard } from "../../../src/core/projection/guard";

describe("MutationGuard (item 9)", () => {
  it("matches exact content per path, keeps a bounded list, and follows renames", () => {
    const g = new MutationGuard();
    for (let i = 0; i < 10; i++) g.expect("a.md", `v${i}`);
    expect(g.pending).toBe(8);
    expect(g.consume("a.md", "v0")).toBe(false); // dropped
    expect(g.consume("a.md", "v5")).toBe(true); // consumes v2..v5
    expect(g.pending).toBe(4);
    g.rename("a.md", "b.md");
    expect(g.consume("a.md", "v9")).toBe(false);
    expect(g.consume("b.md", "v9")).toBe(true);
    expect(g.pending).toBe(0);
    expect(g.consume("b.md", "v9")).toBe(false);
  });
});
