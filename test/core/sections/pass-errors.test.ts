// D1: a note whose passes keep failing shows its error once, until it passes again.

import { describe, expect, it } from "vitest";
import { PassErrorNotices } from "../../../src/core/sections/pass-errors";

describe("PassErrorNotices (D1)", () => {
  it("the same error of a note once; another error, another note, or after a pass: again", () => {
    const n = new PassErrorNotices();
    expect(n.shouldShow("a.md", "poisoned")).toBe(true);
    for (let i = 0; i < 5; i++) expect(n.shouldShow("a.md", "poisoned")).toBe(false);
    expect(n.shouldShow("b.md", "poisoned")).toBe(true);
    expect(n.shouldShow("a.md", "another error")).toBe(true);
    n.passed("a.md");
    expect(n.shouldShow("a.md", "another error")).toBe(true);
  });
});
