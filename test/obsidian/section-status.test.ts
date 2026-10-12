// LFCP-02-064 and native C17: keyboard access reaches a copy whose boundary
// is damaged, through "Open shared section details" and "Go to next shared
// section problem", like a valid section.

import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import type { HeldEdits } from "../../src/core/status/held";
import { statusView } from "../../src/core/status/reducer";
import {
  readOnlyRanges,
  sectionAtLine,
  sectionKey,
  sectionProblems,
  sectionStatusExtension,
} from "../../src/obsidian/section-status";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const S = parseSectionRef(`lfcp1:${R}#section:019a2f85-7b31-7c42-b85a-fc843e2f4001`) as SectionRef;
const start = formatBoundary("start", S);
const end = formatBoundary("end", S);
const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("a copy with a damaged boundary", () => {
  const damaged = lines("# Doc", "Private.", "## Launch", start, "- [ ] One", "", "More.");

  it("is the section under the cursor from its heading on", () => {
    expect(sectionAtLine(damaged, 1)).toBeNull();
    for (const line of [2, 4, 6])
      expect(sectionAtLine(damaged, line)).toEqual({ key: sectionKey(S), title: "Launch" });
  });

  it("is a problem to go to, whatever its section's status", () => {
    expect(sectionProblems(damaged, new Map())).toEqual([{ line: 2, title: "Launch" }]);
  });

  it("a valid section is unchanged: found to its end marker, no problem without a status", () => {
    const valid = lines("## Launch", start, "- [ ] One", end, "", "Private.");
    expect(sectionAtLine(valid, 3)).toEqual({ key: sectionKey(S), title: "Launch" });
    expect(sectionAtLine(valid, 5)).toBeNull();
    expect(sectionProblems(valid, new Map())).toEqual([]);
  });
});

describe("held edits and read-only sections in the editor (F-04)", () => {
  const view = (o: { readOnly?: boolean; held?: readonly HeldEdits[] }) =>
    statusView({
      session: "s",
      revision: 1,
      replica: "loaded",
      access: o.readOnly === true ? "reader" : "writer",
      pendingControl: [],
      connection: "connected",
      catchUp: "current-at-checkpoint",
      problems: [],
      batches: [],
      acceptanceEvidence: "available",
      projections: (o.held ?? []).map((h) => ({
        id: h.projectionId,
        source: "unsupported" as const,
        application: "blocked" as const,
        held: h,
      })),
    });

  it("a heading inside the section is a problem line, found in the text as it is now", () => {
    const md = lines("## Launch", start, "- [ ] One", "", "### Inside", "Text.", end);
    const h: HeldEdits = {
      path: "Launch.md",
      projectionId: "p",
      cause: "unsupported",
      count: 1,
      line: 4,
      nodeIds: [],
    };
    const statuses = new Map([[sectionKey(S), view({ held: [h] })]]);
    // The heading (line 4) and the rows not bound yet are the held lines.
    expect(sectionProblems(md, statuses, "Launch.md").map((p) => p.line)).toEqual([2, 4, 5]);
    // Another note's copy holds nothing here.
    expect(sectionProblems(md, statuses, "Other.md").map((p) => p.line)).toEqual([0]);
  });

  it("typing into a read-only section is stopped; outside it, and undo, go through", () => {
    const md = lines("Private.", "## Launch", start, "- [ ] One", end, "After.");
    const ro = new Map([[sectionKey(S), view({ readOnly: true })]]);
    const state = EditorState.create({ doc: md });
    const at = md.indexOf("One");
    const typed = state.update({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
    const out = readOnlyRanges(typed, ro);
    expect(out.titles).toEqual(["Launch"]);
    expect(out.ranges).toEqual([md.indexOf("## Launch"), md.indexOf("After.") - 1]);
    const outside = state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(readOnlyRanges(outside, ro).ranges).toEqual([]);
    const undo = state.update({ changes: { from: at, insert: "x" }, userEvent: "undo" });
    expect(readOnlyRanges(undo, ro).ranges).toEqual([]);
    // A writer's section is never stopped.
    const rw = new Map([[sectionKey(S), view({})]]);
    expect(readOnlyRanges(typed, rw).ranges).toEqual([]);
    // Through the extension's filter, the typed character never lands.
    const ext = sectionStatusExtension(
      () => ro,
      () => undefined,
    );
    const live = EditorState.create({ doc: md, extensions: ext.extension });
    const after = live.update({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
    expect(after.state.doc.toString()).toBe(md);
  });
});
