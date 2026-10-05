// Security review H3/M9 follow-up: every function that runs patterns over
// note or remote text stays fast on adversarial input. Each case is ~100k
// characters and must finish within the budget (super-linear behaviour
// shows up as seconds at this size).

import { describe, expect, it } from "vitest";
import { taskAt } from "../../../src/core/collab/markdown";
import { renderNote } from "../../../src/core/projection/render";
import { codeSpans, findRefComments, obsidianComments } from "../../../src/core/refs/comments";
import { isBlank, splitLines } from "../../../src/core/refs/lines";
import { parseObjectRef } from "../../../src/core/refs/object-ref";
import { parseTaskLine, scanRefs } from "../../../src/core/refs/scanner";
import { isObjectType } from "../../../src/core/refs/tokens";

const N = 100_000;
const BUDGET_MS = 200;
const REF =
  "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f40ad";

const cases: [string, () => unknown][] = [
  ["code spans: alternating backtick runs", () => codeSpans("` `` ".repeat(N / 5))],
  [
    "code spans: growing backtick runs",
    () => {
      let s = "";
      for (let k = 1; s.length < N; k++) s += `${"`".repeat(k)} x `;
      return codeSpans(s);
    },
  ],
  ["code spans: one unmatched run then many", () => codeSpans(`\`${" ``".repeat(N / 3)}`)],
  [
    "comments: many refs among many code spans on one line",
    () => findRefComments(`\`a\` <!-- lfcp-ref: ${REF} --> `.repeat(N / 120)),
  ],
  ["comments: many openers without a close", () => findRefComments("<!-- ".repeat(N / 5))],
  [
    "comments: many %% among code spans",
    () => obsidianComments("%% `a` ".repeat(N / 7), codeSpans("%% `a` ".repeat(N / 7))),
  ],
  [
    "comment shape: long spacing inside a ref comment",
    () => findRefComments(`<!-- lfcp-ref: x${" ".repeat(N)}y -->`),
  ],
  ["object ref: long garbage", () => parseObjectRef(`lfcp1:${"a".repeat(N)}#task:x`)],
  ["object type: long label run", () => isObjectType(`${"a".repeat(N)}!`)],
  ["object type: many labels", () => isObjectType(`${"a-".repeat(N / 2)}.b!`)],
  ["object type: hyphen runs", () => isObjectType(`a${"-".repeat(N)}`)],
  ["task line: long indentation", () => parseTaskLine(`${" ".repeat(N)}- [ ] x`, 0)],
  ["task line: long marker digits", () => parseTaskLine(`${"1".repeat(N)}. [ ] x`, 0)],
  ["blank check", () => isBlank(`${" \t".repeat(N / 2)}x`)],
  ["lines: many CRs", () => splitLines("\r".repeat(N))],
  [
    "scan: many task lines with refs",
    () => scanRefs(`- [ ] t <!-- lfcp-ref: ${REF} -->\n`.repeat(N / 90)),
  ],
  [
    "scan: many child ref lines under one task",
    () => scanRefs(`- [ ] t\n${`  <!-- lfcp-ref: ${REF} -->\n`.repeat(N / 90)}`),
  ],
  ["scan: many fences", () => scanRefs("```\n".repeat(N / 4))],
  [
    "scan: one huge line of backticks and comments",
    () => scanRefs(`- [ ] t ${"` <!-- ".repeat(N / 7)}`),
  ],
  ["collab taskAt on a huge note", () => taskAt(`- [ ] t\n`.repeat(N / 8), N / 16)],
  [
    "render: a huge title on a bound line",
    () =>
      renderNote(
        `- [ ] ${"a ".repeat(N / 2)}🔁 ${" ".repeat(N / 2)} <!-- lfcp-ref: ${REF} -->\n`,
        () => undefined,
      ),
  ],
];

describe("no super-linear pattern over note or remote text", () => {
  for (const [name, run] of cases)
    it(`${name} within ${BUDGET_MS} ms`, () => {
      const t0 = performance.now();
      run();
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    });
});

// The replaced code-span and %%-comment scans (reference only).
function oldCodeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const runs: Array<[number, number]> = [];
  for (const m of text.matchAll(/`+/g)) runs.push([m.index, m[0].length]);
  for (let i = 0; i < runs.length; i++) {
    const [open, length] = runs[i] as [number, number];
    const close = runs.findIndex((r, j) => j > i && r[1] === length);
    if (close < 0) continue;
    const [closeAt] = runs[close] as [number, number];
    spans.push([open, closeAt + length]);
    i = close;
  }
  return spans;
}
function oldObsidianComments(text: string, spans: Array<[number, number]>) {
  const marks: number[] = [];
  for (let at = text.indexOf("%%"); at >= 0; at = text.indexOf("%%", at + 2))
    if (!spans.some(([s, e]) => at >= s && at < e)) marks.push(at);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i + 1 < marks.length; i += 2)
    ranges.push([marks[i] as number, (marks[i + 1] as number) + 2]);
  if (marks.length % 2 === 1) ranges.push([marks[marks.length - 1] as number, text.length]);
  return { ranges, opens: marks.length % 2 === 1 };
}

describe("the linear code-span and comment scans agree with the ones they replaced", () => {
  it("on 20 000 random lines of backticks, %%, comments and text", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = [
      "`",
      "``",
      "```",
      "%%",
      "<!-- ",
      " -->",
      `<!-- lfcp-ref: ${REF} -->`,
      "x",
      " ",
      "a b",
    ];
    for (let i = 0; i < 20_000; i++) {
      let line = "";
      const n = Math.floor(next() * 14);
      for (let k = 0; k < n; k++) line += pieces[Math.floor(next() * pieces.length)];
      const spans = codeSpans(line);
      expect(spans, JSON.stringify(line)).toEqual(oldCodeSpans(line));
      expect(obsidianComments(line, spans), JSON.stringify(line)).toEqual(
        oldObsidianComments(line, spans),
      );
    }
  });
});
