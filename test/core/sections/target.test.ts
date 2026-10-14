// LFCP-03-009 (F-06, F-07; U03-04, U03-26): the captured target and the
// exact selection of "Share section…" (UX contract 0.3 §4), pure. Every
// rule of §4.2 and every reason of its table, the sentences against the
// contract's table, the selection and content fixtures of
// test/fixtures/ux-0.3/states.json run through the real preflight, and a
// selection in a damaged boundary's region (S4) refused (the cursor path:
// share.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { preflight, proposeRange, shareMessages } from "../../../src/core/sections/share";
import {
  captured,
  captureRefusal,
  invalidation,
  type SelectionReason,
  selectionReasonText,
  shareScope,
  type TargetCapture,
  type TextSelection,
} from "../../../src/core/sections/target";

const S = parseSectionRef(
  "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#section:019a2f85-7b31-7c42-b85a-fc843e2f4001",
) as SectionRef;
const TAIL = "PRIVATE_TAIL_c0ffee: stays on this device.";
const NOTE = [
  "Intro", //            0
  "## Launch", //        1
  "- [ ] Alpha", //      2
  "- [ ] Beta", //       3
  "", //                 4
  "Para one", //         5
  "continues here", //   6
  "", //                 7
  TAIL, //               8
  "", //                 9
  "## Next", //          10
  "- [ ] Other", //      11
  "",
].join("\n");

const sel = (fl: number, fc: number, tl: number, tc: number): TextSelection[] => [
  { anchor: { line: fl, ch: fc }, head: { line: tl, ch: tc } },
];
const scope = (md: string, s: TextSelection[], cursor = 0) => shareScope(md, cursor, s);
const refusedAs = (md: string, s: TextSelection[]) => {
  const r = scope(md, s);
  if (r.kind !== "ineligible") throw new Error(`not refused: ${r.kind}`);
  return r;
};

describe("shareScope without a selection (0.4.0 behaviour)", () => {
  it("the heading at or above the cursor proposes its section; none above refuses", () => {
    expect(shareScope(NOTE, 3, [])).toEqual({ kind: "heading", range: proposeRange(NOTE, 1) });
    expect(shareScope(NOTE, 0, [])).toEqual({ kind: "no-heading" });
    // An empty selection (a caret) is no selection.
    expect(scope(NOTE, sel(3, 2, 3, 2), 3).kind).toBe("heading");
  });
});

describe("an exact eligible selection (§4.2 rules 1-4)", () => {
  it("heading through a block end, at its last non-blank character", () => {
    expect(scope(NOTE, sel(1, 0, 3, 10))).toEqual({
      kind: "exact",
      range: { headingLine: 1, lastLine: 3 },
    });
  });

  it("ending at column 0 ends on the line before; trailing blank lines are trimmed; trailing spaces need not be selected", () => {
    expect(scope(NOTE, sel(1, 0, 4, 0))).toEqual({
      kind: "exact",
      range: { headingLine: 1, lastLine: 3 },
    });
    expect(scope(NOTE, sel(1, 0, 5, 0))).toEqual({
      kind: "exact",
      range: { headingLine: 1, lastLine: 3 },
    });
    const spaced = NOTE.replace("- [ ] Beta", "- [ ] Beta   ");
    expect(scope(spaced, sel(1, 0, 3, 10)).kind).toBe("exact");
  });

  it("the heading may be selected in part, and backwards; the preview keeps the whole heading line", () => {
    const r = scope(NOTE, [{ anchor: { line: 6, ch: 14 }, head: { line: 1, ch: 5 } }]);
    expect(r).toEqual({ kind: "exact", range: { headingLine: 1, lastLine: 6 } });
    if (r.kind !== "exact") return;
    const p = preflight(NOTE, r.range);
    expect(p.title).toBe("Launch");
    expect(p.content).toBe("- [ ] Alpha\n- [ ] Beta\n\nPara one\ncontinues here");
    expect(p.content).not.toContain("PRIVATE_TAIL");
    expect(p.privateTail).toBe(TAIL);
    expect(shareMessages(p).heading).toBe('Share section "Launch"');
  });

  it("CRLF notes select the same lines", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(scope(crlf, sel(1, 0, 4, 0))).toEqual({
      kind: "exact",
      range: { headingLine: 1, lastLine: 3 },
    });
  });
});

describe("an ineligible selection: one reason, a fallback only where the contract gives one", () => {
  const whole = proposeRange(NOTE, 1);

  it("no-heading-start: the whole section when its scope holds the selection; none without a heading (S3)", () => {
    expect(refusedAs(NOTE, sel(2, 0, 3, 10))).toMatchObject({
      reason: "no-heading-start",
      fallback: whole,
    });
    // No heading above at all: nothing to fall back to (S3, no heading is inserted).
    expect(refusedAs(NOTE, sel(0, 0, 0, 5))).toMatchObject({
      reason: "no-heading-start",
      fallback: null,
    });
    const bare = "Intro\nmore\n";
    expect(refusedAs(bare, sel(0, 0, 1, 4))).toMatchObject({
      reason: "no-heading-start",
      fallback: null,
    });
    // Starting under one heading and running into the next: no single section holds it.
    expect(refusedAs(NOTE, sel(2, 0, 11, 11))).toMatchObject({
      reason: "no-heading-start",
      fallback: null,
    });
  });

  it("partial-line: ends inside a line's text", () => {
    expect(refusedAs(NOTE, sel(1, 0, 3, 4))).toMatchObject({
      reason: "partial-line",
      line: 3,
      fallback: whole,
    });
  });

  it("crossing: past the end of the heading's section, no fallback", () => {
    expect(refusedAs(NOTE, sel(1, 0, 11, 11))).toMatchObject({
      reason: "crossing",
      line: 10,
      fallback: null,
    });
  });

  it("partial-block: ends in the middle of a paragraph, the whole section offered", () => {
    expect(refusedAs(NOTE, sel(1, 0, 5, 8))).toMatchObject({
      reason: "partial-block",
      line: 6,
      fallback: whole,
    });
  });

  it("nested-heading, unclosed-fence, already-bound, broken-ref: no fallback", () => {
    const nested = "## A\n- [ ] One\n### B\n- [ ] Two\n## C\n";
    expect(refusedAs(nested, sel(0, 0, 3, 9))).toMatchObject({
      reason: "nested-heading",
      line: 2,
      fallback: null,
    });
    const fence = "## A\n```\ncode\n";
    expect(refusedAs(fence, sel(0, 0, 2, 4))).toMatchObject({
      reason: "unclosed-fence",
      fallback: null,
    });
    const bound = [
      "## A",
      formatBoundary("start", S),
      "- [ ] One",
      formatBoundary("end", S),
      "",
    ].join("\n");
    expect(refusedAs(bound, sel(0, 0, 3, 999))).toMatchObject({
      reason: "already-bound",
      line: 1,
      fallback: null,
    });
    const broken = "## A\n- [ ] One\n  <!-- lfcp-ref: broken -->\n";
    const r = refusedAs(broken, sel(0, 0, 2, 99));
    expect(r).toMatchObject({ reason: "broken-ref", line: 2, fallback: null });
  });

  it("legacy-tasks: the explicit import of exactly the selected range", () => {
    const legacy = [
      "## A",
      "- [ ] One",
      "  <!-- lfcp-ref: lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f4002 -->",
      "",
      "Private.",
      "",
    ].join("\n");
    const r = refusedAs(legacy, sel(0, 0, 2, 200));
    expect(r).toMatchObject({
      reason: "legacy-tasks",
      fallback: null,
      range: { headingLine: 0, lastLine: 2 },
    });
  });

  it("S7 (D13): the heading line alone over a body asks for the whole section; an empty section is shared as it is", () => {
    // The whole heading line, or part of it down to column 0 of the next line.
    for (const s of [sel(1, 0, 1, 9), sel(1, 3, 2, 0)])
      expect(refusedAs(NOTE, s)).toMatchObject({
        reason: "heading-only",
        line: 1,
        fallback: whole,
      });
    // Ending inside the heading's text is a partial line first.
    expect(refusedAs(NOTE, sel(1, 0, 1, 4))).toMatchObject({ reason: "partial-line" });
    const empty = "## Empty\n\n## Next\n- [ ] Other\n";
    expect(scope(empty, sel(0, 0, 1, 0))).toEqual({
      kind: "exact",
      range: { headingLine: 0, lastLine: 0 },
    });
  });

  it("multiple-selections: several ranges are not one scope", () => {
    expect(refusedAs(NOTE, [...sel(1, 0, 3, 10), ...sel(5, 0, 6, 14)])).toMatchObject({
      reason: "multiple-selections",
      fallback: null,
    });
  });
});

describe("S4: a damaged boundary's region is never a share boundary", () => {
  // A start marker without its end claims down to the end of the note.
  const DAMAGED = [
    "## Shared",
    formatBoundary("start", S),
    "- [ ] In",
    "",
    "## Private later",
    "- [ ] Mine",
    "",
  ].join("\n");

  it("an otherwise exact selection there is refused as damaged-boundary, no fallback", () => {
    expect(refusedAs(DAMAGED, sel(4, 0, 5, 10))).toMatchObject({
      reason: "damaged-boundary",
      line: 1,
      fallback: null,
    });
  });

  it("a section above the damaged region is not affected", () => {
    const above = `## Before\n- [ ] Free\n\n${DAMAGED}`;
    expect(scope(above, sel(0, 0, 1, 10)).kind).toBe("exact");
  });
});

describe("the captured target", () => {
  const at: TargetCapture = {
    path: "Plan.md",
    text: NOTE,
    mode: "live-preview",
    cursorLine: 2,
    selections: [],
    composing: false,
  };
  const now = (text: string, composing = false) => ({ text, open: true, composing });

  it("holds while the note is unchanged; deleted, changed or composing invalidates it", () => {
    const t = captured(at);
    expect(invalidation(t, "Plan.md", now(NOTE))).toBeNull();
    expect(invalidation(t, "Renamed.md", now(NOTE))).toBeNull();
    expect(invalidation(t, null, now(NOTE))).toBe("deleted");
    expect(invalidation(t, "Plan.md", null)).toBe("deleted");
    expect(invalidation(t, "Plan.md", now(`${NOTE}x`))).toBe("changed");
    expect(invalidation(t, "Plan.md", now(`${NOTE}x`), false)).toBeNull();
    expect(invalidation(t, "Plan.md", now(NOTE, true))).toBe("composing");
  });

  it("Reading view and a composition refuse a source-changing action at once", () => {
    expect(captureRefusal(at)).toBeNull();
    expect(captureRefusal({ ...at, mode: "source" })).toBeNull();
    expect(captureRefusal({ ...at, mode: "reading" })).toBe("reading");
    expect(captureRefusal({ ...at, composing: true })).toBe("composing");
  });
});

describe("parity with the UX contract (§4.2 table) and its fixtures", () => {
  const root = join(import.meta.dirname, "../../..");
  const contract = readFileSync(join(root, "docs/architecture/ux-contract-0.3.md"), "utf8");
  const states = JSON.parse(
    readFileSync(join(root, "test/fixtures/ux-0.3/states.json"), "utf8"),
  ) as {
    states: {
      id: string;
      facts: {
        context: { selection: { reason: string | null; fallback: string | null } | null };
        preview?: {
          counts: Record<string, number>;
          warnings: string[];
          problems: unknown[];
        };
      };
      expected: {
        requiredClaims: string[];
        forbiddenClaims: string[];
        disabled: { action: string; reason: string }[];
      };
    }[];
    globalForbiddenClaims: string[];
  };
  const fixture = (id: string) => {
    const s = states.states.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return s;
  };

  /** The contract's reason table: ID, sentence (with N), fallback. */
  const start = contract.indexOf("| Reason ID |");
  const table = [
    ...contract
      .slice(start, contract.indexOf("\n\n", start))
      .matchAll(/^\| `([a-z-]+)` \| (.+) \| (.+) \|$/gm),
  ].map((m) => ({ id: m[1] as string, sentence: m[2] as string, fallback: m[3] as string }));

  it("every reason of the contract has the contract's sentence, with line N", () => {
    const ids = table.map((r) => r.id);
    expect(ids).toEqual([
      "no-heading-start",
      "partial-line",
      "crossing",
      "nested-heading",
      "partial-block",
      "unclosed-fence",
      "already-bound",
      "legacy-tasks",
      "broken-ref",
      "damaged-boundary",
      "multiple-selections",
      "heading-only",
    ]);
    for (const r of table)
      expect(selectionReasonText(r.id as SelectionReason, 41).replace(/\b42\b/g, "N"), r.id).toBe(
        r.sentence,
      );
  });

  it("a fallback exactly where the contract gives one", () => {
    const md = NOTE;
    const cases: Record<string, TextSelection[]> = {
      "no-heading-start": sel(2, 0, 3, 10),
      "partial-line": sel(1, 0, 3, 4),
      crossing: sel(1, 0, 11, 11),
      "partial-block": sel(1, 0, 5, 8),
      "multiple-selections": [...sel(1, 0, 3, 10), ...sel(5, 0, 6, 14)],
    };
    for (const [id, s] of Object.entries(cases)) {
      const r = refusedAs(md, s);
      expect(r.reason).toBe(id);
      const row = table.find((x) => x.id === id);
      expect(r.fallback !== null, id).toBe(row?.fallback.startsWith('"Share the whole section…"'));
    }
  });

  it("selection fixtures: the reason, the fallback and the sentences of each state", () => {
    const md = [
      "# Plan", //                 0
      "", //                       1
      "Intro.", //                 2
      "", //                       3
      "## Launch", //              4
      "", //                       5
      "- [ ] Book the venue", //   6
      "- [ ] Send invites", //     7
      "", //                       8
      "First paragraph.", //       9
      "", //                       10
      TAIL, //                     11
      "", //                       12
      "## Budget", //              13
      ...Array.from({ length: 8 }, (_, i) => `Line ${i}.`), // 14-21
      "",
    ].join("\n");
    // selection-exact: heading (4) through the paragraph (9); the private paragraph follows.
    const exact = scope(md, sel(4, 0, 9, 16));
    expect(exact.kind).toBe("exact");
    if (exact.kind === "exact") {
      const p = preflight(md, exact.range);
      const said = [shareMessages(p).scope, ...shareMessages(p).warnings].join("\n");
      for (const c of fixture("selection-exact").expected.requiredClaims) expect(said).toContain(c);
      expect(p.content).not.toContain("PRIVATE_TAIL");
    }
    // selection-no-heading: the two Task lines (6-7).
    const none = fixture("selection-no-heading");
    const r1 = refusedAs(md, sel(6, 0, 7, 18));
    expect(r1.reason).toBe(none.facts.context.selection?.reason);
    expect(r1.fallback === null ? null : "share-whole-section").toBe(
      none.facts.context.selection?.fallback,
    );
    const text1 = selectionReasonText(r1.reason, r1.line);
    expect(none.expected.requiredClaims).toContain(text1);
    expect(none.expected.disabled.find((d) => d.action === "share-section")?.reason).toBe(text1);
    // selection-heading-only: the heading line (4) alone; Tasks follow under it.
    const only = fixture("selection-heading-only");
    const r3 = refusedAs(md, sel(4, 0, 4, 9));
    expect(r3.reason).toBe(only.facts.context.selection?.reason);
    expect(r3.fallback === null ? null : "share-whole-section").toBe(
      only.facts.context.selection?.fallback,
    );
    const text3 = selectionReasonText(r3.reason, r3.line);
    expect(only.expected.requiredClaims).toContain(text3);
    expect(only.expected.disabled.find((d) => d.action === "share-section")?.reason).toBe(text3);
    // selection-crossing: from the heading (4) past the next one (13) to line 20.
    const crossing = fixture("selection-crossing");
    const r2 = refusedAs(md, sel(4, 0, 20, 8));
    expect(r2.reason).toBe(crossing.facts.context.selection?.reason);
    expect(r2.fallback).toBeNull();
    const text2 = selectionReasonText(r2.reason, r2.line);
    expect(crossing.expected.requiredClaims).toContain(text2);
    expect(crossing.expected.disabled.find((d) => d.action === "share-section")?.reason).toBe(
      text2,
    );
  });

  it("U03-26 content fixture: raw blocks shared and counted, comments local, a paragraph under a Task is content", () => {
    const md = [
      "## Launch",
      "- [ ] Contract",
      "",
      "  Notes on the contract.",
      "- [ ] Venue",
      "",
      "| Item | Cost |",
      "| --- | --- |",
      "| Hall | 100 |",
      "",
      "```js",
      "const total = 100;",
      "```",
      "",
      "%% PRIVATE_COMMENT_7e57: local only %%",
      "",
    ].join("\n");
    const range = proposeRange(md, 0);
    if (range === null) throw new Error("no range");
    const p = preflight(md, range);
    const f = fixture("content-comments-and-table");
    const want = f.facts.preview;
    expect(p.counts).toMatchObject(want?.counts ?? {});
    expect(p.warnings).toEqual(want?.warnings);
    expect(p.problems).toEqual(want?.problems);
    const m = shareMessages(p);
    const said = [m.heading, m.scope, m.counts, ...m.warnings, ...m.problems].join("\n");
    for (const c of f.expected.requiredClaims) expect(said).toContain(c);
    for (const c of [...f.expected.forbiddenClaims, ...states.globalForbiddenClaims])
      expect(said.toLowerCase()).not.toContain(c.toLowerCase());
  });
});
