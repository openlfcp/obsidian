// Security review H3/M9: the Task suffix parser is linear. The regex
// implementation it replaced is kept here only, as the reference: both
// agree on random Tasks-like lines, and the new one parses adversarial
// inputs of 100k characters within a small time budget.

import { describe, expect, it } from "vitest";
import {
  hasWikilink,
  parseTaskText,
  type Segment,
  segmentTaskText,
} from "../../../src/core/projection/task-text";

// ---- the replaced implementation (reference only) ------------------------
const PRIORITIES: Record<string, string> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "unowned",
  "🔽": "low",
  "⏬": "lowest",
};
const DATE_EMOJI: Record<string, string> = {
  "📅": "due",
  "⏳": "scheduled",
  "✅": "completion",
  "🛫": "start",
  "➕": "created",
  "❌": "cancelled",
};
const VS16 = "\uFE0F?";
const BLOCK_ID = /(?:^|\s+)\^([A-Za-z0-9-]+)$/;
const DATE = new RegExp(`\\s*(📅|⏳|✅|🛫|➕|❌)${VS16}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u");
const PRIORITY = new RegExp(`\\s*(🔺|⏫|🔼|🔽|⏬)${VS16}$`, "u");
const RECURRENCE = new RegExp(`\\s*🔁${VS16}\\s*([a-zA-Z0-9, !]+?)\\s*$`, "u");
const TAG = /(?:^|\s+)#([\p{L}\p{N}_/-]+)$/u;
const isTag = (t: string) => /^[\p{L}\p{N}_/-]+$/u.test(t) && /[^\p{N}]/u.test(t);

function oldSegment(text: string) {
  const end = text.trimEnd();
  const trailing = text.slice(end.length);
  let rest = end;
  const segments: Segment[] = [];
  let block = false;
  for (;;) {
    const cut = (m: RegExpExecArray, segment: Segment) => {
      segments.unshift(segment);
      rest = rest.slice(0, m.index);
    };
    let m = BLOCK_ID.exec(rest);
    if (m !== null && !block) {
      block = true;
      cut(m, { kind: "block", value: m[1] as string, raw: m[0] });
      continue;
    }
    m = DATE.exec(rest);
    if (m !== null) {
      cut(m, {
        kind: "date",
        field: DATE_EMOJI[m[1] as string] as never,
        value: m[2] as string,
        raw: m[0],
      });
      continue;
    }
    m = PRIORITY.exec(rest);
    if (m !== null) {
      cut(m, {
        kind: "priority",
        value: (PRIORITIES[m[1] as string] ?? "unowned") as never,
        raw: m[0],
      });
      continue;
    }
    m = RECURRENCE.exec(rest);
    if (m !== null && !segments.some((x) => x.kind === "recurrence")) {
      cut(m, { kind: "recurrence", value: (m[1] as string).trim(), raw: m[0] });
      continue;
    }
    m = TAG.exec(rest);
    if (m !== null && m.index > 0 && isTag(m[1] as string)) {
      cut(m, { kind: "tag", value: m[1] as string, raw: m[0] });
      continue;
    }
    break;
  }
  return { description: rest, segments, trailing };
}
const oldWikilink = (t: string) => /\[\[[^\]]+\]\]/.test(t);
// ---------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "Prepare",
  "API",
  "contract",
  "x",
  "#tag",
  "#web/api",
  "#123",
  "#ä_b-c",
  "#𝒜lpha",
  "#",
  "^blk-1",
  "^",
  "^bad^",
  "📅",
  "⏳",
  "✅",
  "🛫",
  "➕",
  "❌",
  "📅\uFE0F",
  "✅\uFE0F",
  "2026-10-10",
  "2026-1-10",
  "20261010",
  "📅2026-10-10",
  "🔺",
  "⏫",
  "🔼",
  "🔽",
  "⏬",
  "⏫\uFE0F",
  "🔁",
  "🔁\uFE0F",
  "every week",
  "every 2 days!",
  "when done,",
  "[[Note]]",
  "[[",
  "]]",
  "]",
  "[",
  "(see notes)",
  "\uFE0F",
  "-",
  "!",
  ",",
];
const SPACES = [" ", "  ", "\t", "\u00a0", "\u3000", "", "", " "];

function randomLine(next: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T;
  let line = "";
  const n = Math.floor(next() * 12);
  for (let i = 0; i < n; i++) line += pick(SPACES) + pick(PIECES);
  return line + pick(["", " ", "  ", "\t"]);
}

describe("linear Task suffix parser (security review H3, M9)", () => {
  it("agrees with the replaced regex parser on 20 000 random Tasks-like lines", () => {
    const next = rng(20261006);
    for (let i = 0; i < 20_000; i++) {
      const line = randomLine(next);
      expect(segmentTaskText(line), JSON.stringify(line)).toEqual(oldSegment(line));
      expect(hasWikilink(line), JSON.stringify(line)).toBe(oldWikilink(line));
    }
  });

  const N = 100_000;
  // Generous for a loaded CI machine (a full run measured up to ~60 ms for
  // 50k emoji); the replaced regexes took seconds on inputs a tenth this size.
  const budgetMs = 250;
  const cases: [string, string][] = [
    ["spaces only", " ".repeat(N)],
    ["text then spaces then a recurrence", `x${" ".repeat(N)}🔁 every week`],
    ["recurrence with a long spaced rule", `x 🔁${" a".repeat(N / 2)}`],
    ["many recurrence marks", "🔁 ".repeat(N / 3)],
    ["spaces before a caret id", `x${" ".repeat(N)}^abc`],
    ["long id-like run without a caret", "a".repeat(N)],
    ["many carets", "^".repeat(N)],
    ["spaces before a hash tag", `x${" ".repeat(N)}#tag`],
    ["long tag-like run", `x #${"a".repeat(N)}`],
    ["many hashes", "#".repeat(N)],
    ["spaces between a date emoji and a date", `x 📅${" ".repeat(N)}2026-10-10`],
    ["spaces before a date emoji", `x${" ".repeat(N)}📅 2026-10-10`],
    ["many date emoji", "📅 ".repeat(N / 3)],
    ["many priority emoji", "⏫".repeat(N / 2)],
    ["many short tags", "x" + " #t".repeat(N / 3)],
    ["many short dates", "x" + " 📅 2026-10-10".repeat(N / 14)],
    ["unbalanced wikilinks", "[[".repeat(N / 2)],
    ["wikilink opens and single closes", "[[a]".repeat(N / 4)],
    ["mixed whitespace kinds", "x" + " \t\u00a0\u3000".repeat(N / 4) + "#t"],
  ];
  for (const [name, input] of cases)
    it(`parses "${name}" (${input.length} chars) within ${budgetMs} ms`, () => {
      parseTaskText(input.slice(0, 1000)); // warm up
      const t0 = performance.now();
      parseTaskText(input);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
    });

  it("the measured H3 input that took 28.8 s now takes milliseconds", () => {
    const input = `a${" ".repeat(4000)}🔁${" ".repeat(4000)}`;
    const t0 = performance.now();
    segmentTaskText(input);
    expect(performance.now() - t0).toBeLessThan(budgetMs);
  });
});
