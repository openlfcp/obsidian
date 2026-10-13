// composeChanges (engine.ts): two change lists into one against the
// original text, checked against applying them one after the other.

import { describe, expect, it } from "vitest";
import { applyChanges, composeChanges } from "../../../src/core/sections/engine";
import type { DocChange } from "../../../src/core/sections/source-map";

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random non-overlapping ascending changes on a text of length `n`. */
function changes(r: () => number, n: number): DocChange[] {
  const out: DocChange[] = [];
  let p = 0;
  while (p <= n && out.length < 4) {
    const from = p + Math.floor(r() * 4);
    if (from > n) break;
    const to = Math.min(n, from + (r() < 0.5 ? 0 : Math.floor(r() * 3)));
    const insert = r() < 0.3 ? "" : "XYZ".slice(0, 1 + Math.floor(r() * 3));
    if (to === from && insert === "") {
      p = from + 1;
      continue;
    }
    out.push({ from, to, insert });
    // Sometimes the next change starts right where this one ends (an
    // insertion, then a deletion at the same place, as the engine's layers
    // write them).
    p = to === from || r() < 0.7 ? to + 1 : to;
  }
  return out;
}

describe("composeChanges", () => {
  it("equals applying both lists in turn, never overlapping, or refuses (property, 10000 cases)", () => {
    const r = rng(42);
    let composed = 0;
    for (let k = 0; k < 10000; k++) {
      const text = "abcdefghij".slice(0, 3 + Math.floor(r() * 8));
      const first = changes(r, text.length);
      const mid = applyChanges(text, first);
      const second = changes(r, mid.length);
      const c = composeChanges(first, second);
      if (c === null) continue;
      composed++;
      const what = JSON.stringify({ text, first, second, c });
      for (let i = 1; i < c.length; i++)
        expect((c[i] as DocChange).from, what).toBeGreaterThanOrEqual((c[i - 1] as DocChange).to);
      expect(applyChanges(text, c), what).toBe(applyChanges(mid, second));
    }
    // Short texts make cuts into fresh inserts common; those are refused by design.
    expect(composed).toBeGreaterThan(5000);
  });

  it("a deletion of `first` at the edge of a deletion of `second` stays apart from an insertion there (sweep seed 2974)", () => {
    // first: x removed (a remote deletion); second: Alpha inserted where x
    // was, and the line after it (draft, moved away) removed.
    const text = "G\nx\nd\nP\n";
    const first = [{ from: 2, to: 4, insert: "" }];
    const mid = applyChanges(text, first); // "G\nd\nP\n"
    const second = [
      { from: 2, to: 2, insert: "A\n" },
      { from: 2, to: 4, insert: "" },
      { from: 6, to: 6, insert: "d\n" },
    ];
    const c = composeChanges(first, second);
    expect(c).not.toBeNull();
    for (let i = 1; i < (c ?? []).length; i++)
      expect((c ?? [])[i]?.from).toBeGreaterThanOrEqual((c ?? [])[i - 1]?.to ?? 0);
    expect(applyChanges(text, c ?? [])).toBe(applyChanges(mid, second));
    expect(applyChanges(text, c ?? [])).toBe("G\nA\nP\nd\n");
  });

  it("keeps an insertion at a span's edge on its side", () => {
    const first = [{ from: 2, to: 2, insert: "AB" }];
    // "xxAByy": insert before AB (at 2) and after it (at 4).
    expect(
      applyChanges("xxyy", composeChanges(first, [{ from: 2, to: 2, insert: "<" }]) ?? []),
    ).toBe("xx<AByy");
    expect(
      applyChanges("xxyy", composeChanges(first, [{ from: 4, to: 4, insert: ">" }]) ?? []),
    ).toBe("xxAB>yy");
  });

  it("composes the engine's layers: bindings, a Text patch elsewhere, a node moved away", () => {
    const text = "A\nB\nC\nD\n";
    // Bindings inserted before B and after C; then B patched and D moved before A.
    const first = [
      { from: 2, to: 2, insert: "<b>\n" },
      { from: 6, to: 6, insert: "<c>\n" },
    ];
    const mid = applyChanges(text, first); // "A\n<b>\nB\nC\n<c>\nD\n"
    const second = [
      { from: 0, to: 0, insert: "D\n" },
      { from: 6, to: 7, insert: "B2" },
      { from: mid.length - 2, to: mid.length, insert: "" },
    ];
    const c = composeChanges(first, second);
    expect(c).not.toBeNull();
    expect(applyChanges(text, c ?? [])).toBe(applyChanges(mid, second));
  });
});
