// UX-05 / UX-06: a section marker with a typed letter is restored in one
// step, and one cause is one problem with one button (analysis R4, R5, the
// 2026-10-25 note: an "h" typed into the start marker).

import { describe, expect, it } from "vitest";
import { hostPane } from "../../../src/core/pane/host-facts";
import { paneModel } from "../../../src/core/pane/model";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import type { RegistrySnapshot } from "../../../src/core/sections/registry-view";
import {
  editDistance,
  keyedRepairs,
  repairItems,
  restoreChange,
  restoreText,
} from "../../../src/core/sections/repair";
import type { TargetCapture } from "../../../src/core/sections/target";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const SID2 = "019a2f85-7b31-7c42-b85a-fc843e2f4002";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;
const KEY2 = `${R0}#${SID2}`;

const START = formatBoundary("start", S);
const END = formatBoundary("end", S);
const doc = (start: string, end: string = END) =>
  ["# Plan", "## Tasks 1", start, "- [ ] Alpha", end, ""].join("\n");

describe("restoring a damaged marker (UX-05)", () => {
  it("a letter typed into the start marker is one restore of that line", () => {
    const typed = START.replace("lfcp1:", "hlfcp1:");
    const md = doc(typed);
    // The parser does not read the section any more.
    expect(parseSections(md).sections).toEqual([]);
    const items = repairItems(md, [KEY]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "restore",
      line: 2,
      boundary: "start",
      original: typed,
      text: START,
      title: "Tasks 1",
    });
    const item = items[0];
    if (item?.kind !== "restore") throw new Error("not a restore");
    expect(restoreText(item)).toBe(
      'The start line of "Tasks 1" was changed. Edits to "Tasks 1" are not being sent until this is fixed.',
    );
    // Only that line is rewritten, and the section is read again.
    const fixed = applyChanges(md, [restoreChange(md, item)]);
    expect(fixed).toBe(doc(START));
    expect(parseSections(fixed).sections).toHaveLength(1);
    expect(repairItems(fixed, [KEY])).toEqual([]);
  });

  it("an end marker is restored as an end marker", () => {
    const md = doc(START, END.replace("lfcp1:", "hlfcp1:"));
    const [item, ...rest] = repairItems(md, [KEY]);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ kind: "restore", boundary: "end", text: END });
  });

  it("two letters are still a restore, three are not", () => {
    expect(repairItems(doc(`${START.slice(0, -4)}xy -->`), [KEY])[0]?.kind).toBe("restore");
    const three = repairItems(doc(START.replace("lfcp1:", "xyzlfcp1:")), [KEY]);
    expect(three.map((i) => i.kind)).not.toContain("restore");
    expect(editDistance("abcdef", "abxdef", 2)).toBe(1);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });

  it("a section this device does not hold is not restored: the existing repair stays", () => {
    const md = doc(START.replace("lfcp1:", "hlfcp1:"));
    expect(repairItems(md, []).map((i) => i.kind)).not.toContain("restore");
    expect(repairItems(md, [`${"A".repeat(43)}#${SID2}`]).map((i) => i.kind)).not.toContain(
      "restore",
    );
  });

  it("two candidates are no restore", () => {
    // Two held sections one character apart: a marker near both is ambiguous.
    const other = parseSectionRef(`lfcp1:${R0}#section:${SID2}`) as SectionRef;
    const typed = START.replace(SID, "019a2f85-7b31-7c42-b85a-fc843e2f4009");
    const items = repairItems(doc(typed), [KEY, KEY2]);
    expect(items.map((i) => i.kind)).not.toContain("restore");
    expect(formatBoundary("start", other)).not.toBe(START);
  });

  it("restore refuses a line that changed", () => {
    const md = doc(START.replace("lfcp1:", "hlfcp1:"));
    const item = repairItems(md, [KEY])[0];
    if (item?.kind !== "restore") throw new Error("not a restore");
    expect(() => restoreChange(md.replace("hlfcp1", "hhlfcp1"), item)).toThrow();
  });

  it("the key is stable for the same damage, so a click finds it after an edit above", () => {
    const md = doc(START.replace("lfcp1:", "hlfcp1:"));
    const a = keyedRepairs(md, [KEY]);
    const b = keyedRepairs(`Intro\n${md}`, [KEY]);
    expect(a[0]?.key).toBe(b[0]?.key);
    expect(b[0]?.item.line).toBe((a[0]?.item.line ?? 0) + 1);
  });
});

describe("one cause, one problem (UX-06)", () => {
  const damaged = doc(START.replace("lfcp1:", "hlfcp1:"));

  it("the damaged start and the end it leaves orphaned are one item, not two", () => {
    // Without the held section the parser still names two problems: the end has no start.
    const codes = parseSections(damaged).diagnostics.map((d) => d.code);
    expect(codes).toContain("SECTION_MARKER_MALFORMED");
    expect(codes).toContain("SECTION_BOUNDARY_MISSING");
    expect(repairItems(damaged, [KEY]).map((i) => i.kind)).toEqual(["restore"]);
  });

  it("without a held match the orphan is still not listed beside its damaged mate", () => {
    const kinds = repairItems(damaged, []).map((i) => i.kind);
    expect(kinds).toEqual(["locate"]);
  });

  it("an end without a start that has nothing damaged near it stays listed", () => {
    const md = ["# Plan", "## Tasks 1", "- [ ] Alpha", END, ""].join("\n");
    expect(repairItems(md, [KEY]).map((i) => i.kind)).toEqual(["missing-start"]);
  });
});

describe("the pane for a damaged marker (UX-05, UX-06)", () => {
  const note = (text: string, over: Partial<TargetCapture> = {}): TargetCapture => ({
    path: "Plan.md",
    text,
    mode: "source",
    cursorLine: 3,
    selections: [],
    composing: false,
    ...over,
  });
  const registry = (): RegistrySnapshot =>
    ({
      version: 1,
      status: "ready",
      error: null,
      placementIndex: "complete",
      sections: 1,
      unplaced: 1,
      rows: [
        {
          resource: R0,
          sectionId: SID,
          key: KEY,
          sharedTitle: "Tasks 1",
          localAlias: null,
          registryState: "ready",
          refusal: null,
          status: { watched: true, state: null, label: null },
          placements: [],
          placementCount: 0,
          placed: "unplaced",
        },
      ],
    }) as unknown as RegistrySnapshot;
  const draw = (text: string, over: Partial<TargetCapture> = {}) =>
    paneModel(
      hostPane({ note: note(text, over), registry: registry(), status: () => undefined }).facts,
    );
  const damaged = doc(START.replace("lfcp1:", "hlfcp1:"));

  it("shows one card with the problem and Restore as the one button, never Insert into a note", () => {
    const m = draw(damaged);
    // R5: the problem is the card (its text, its fix); it is not listed a second time.
    expect(m.card.problem).toBe(true);
    expect(m.card.fact).toContain('The start line of "Tasks 1" was changed.');
    expect(m.card.fact).toContain("not being sent");
    expect(m.card.status.word).toBe("Needs repair");
    expect(m.problems).toEqual([]);
    expect(m.primary?.id).toBe("restore-marker");
    expect(m.primary?.label).toBe("Restore");
    expect(m.primary?.label).not.toContain("Insert");
  });

  it("says the section is damaged in this note, not that it is not inserted", () => {
    const m = draw(damaged, { cursorLine: 0 });
    const lines = JSON.stringify(m);
    expect(lines).toContain("Damaged in this note");
    expect(lines).not.toContain("Not inserted yet");
    expect(m.sections.groups.find((g) => g.id === "in-note")?.rows[0]?.places).toBe(
      "Damaged in this note",
    );
  });

  it("without a restore, the primary is still the fix, not Insert into a note", () => {
    const noHeld = hostPane({ note: note(damaged), registry: null, status: () => undefined });
    const m = paneModel(noHeld.facts);
    expect(m.problems).toHaveLength(1);
    expect(m.primary?.id).not.toBe("insert-into-note");
  });

  it("a healthy note keeps its primary", () => {
    const m = draw(doc(START));
    expect(m.problems).toEqual([]);
    expect(m.primary?.id).not.toBe("restore-marker");
  });

  it("in Reading view a restore waits for editing", () => {
    const m = draw(damaged, { mode: "reading" });
    expect(m.primary?.id).toBe("open-for-editing");
  });
});

describe("restore is only for the cause (review of PR 91)", () => {
  it("a damaged start of a section with an intact start does not hide that section's missing end", () => {
    const damagedStart = START.replace("lfcp1:", "hlfcp1:");
    const md = ["## A", START, "- [ ] one", "", "## B", damagedStart, "- [ ] two", ""].join("\n");
    const items = repairItems(md, [KEY]);
    expect(items.map((i) => i.kind)).toContain("missing-end");
    // The section already has an intact start: a second one is not restored.
    expect(items.map((i) => i.kind)).not.toContain("restore");
  });

  it("a damaged end does not hide the missing start of an end marker", () => {
    // Orphan end (missing start); a damaged END earlier is not its mate.
    const md = ["## A", END.replace("lfcp1:", "hlfcp1:"), "- [ ] x", END, ""].join("\n");
    expect(repairItems(md, [KEY]).map((i) => i.kind)).toContain("missing-start");
  });

  it("a damaged start whose section already has an intact start is not restored", () => {
    const md = [
      "## A",
      START,
      "- [ ] one",
      END,
      "## Copy",
      START.replace("lfcp1:", "hlfcp1:"),
      "- [ ] one",
      "",
    ].join("\n");
    expect(repairItems(md, [KEY]).map((i) => i.kind)).not.toContain("restore");
  });

  it("a typo that could be either boundary restores the one that pairs with a lone mate", () => {
    // Orphan end of the section: the damaged line before it is its start.
    const md = doc(START.replace("lfcp1:", "hlfcp1:"));
    const [item] = repairItems(md, [KEY]);
    expect(item).toMatchObject({ kind: "restore", boundary: "start" });
  });
});
