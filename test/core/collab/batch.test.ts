// POST-018: the range logic of "Share selected tasks" and "Insert all
// tasks from collaboration".

import { resourceId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  attachAll,
  headingSection,
  type PendingRef,
  planBatchShare,
  tasksToInsert,
} from "../../../src/core/collab/batch";
import { attachRef, type ObjectRef, scanRefs } from "../../../src/core/refs";
import { splitLines } from "../../../src/core/refs/lines";

const R = resourceId(Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + (i % 16)));
const OTHER = resourceId(Uint8Array.from({ length: 32 }, (_, i) => 0x10 + (i % 16)));
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f40${n.toString(16).padStart(2, "0")}`;
const ref = (n: number, resource = R): ObjectRef => ({
  resourceId: resource,
  objectType: "task",
  objectId: id(n),
});

const NOTE = [
  "# Plan", // 0
  "", // 1
  "## Sprint", // 2
  "- [ ] Prepare API contract", // 3
  "  - [ ] Draft the schema", // 4
  "- [x] Kick-off", // 5
  "### Detail", // 6
  "- [ ] Deep task", // 7
  "## Later", // 8
  "- [ ] Someday", // 9
  "```", // 10
  "# not a heading", // 11
  "- [ ] not a task", // 12
  "```", // 13
  "- [ ] After the fence", // 14
].join("\n");

const lines = (markdown: string, states: readonly { task: { line: number } }[]) =>
  states.map((s) => splitLines(markdown)[s.task.line]?.text);

describe("headingSection", () => {
  it("is the heading at or above the cursor, down to the next of its level or higher", () => {
    expect(headingSection(NOTE, 4)).toEqual({ from: 3, to: 7 }); // ## Sprint holds ### Detail
    expect(headingSection(NOTE, 2)).toEqual({ from: 3, to: 7 }); // the cursor on the heading
    expect(headingSection(NOTE, 7)).toEqual({ from: 7, to: 7 }); // ### Detail
    expect(headingSection(NOTE, 1)).toEqual({ from: 1, to: 14 }); // # Plan: the whole note
    // A # line in a fence is not a heading: ## Later runs to the end.
    expect(headingSection(NOTE, 12)).toEqual({ from: 9, to: 14 });
    expect(headingSection("- [ ] no heading\n# H\n", 0)).toBeNull();
    expect(headingSection("---\n# fm\n---\n- [ ] t\n", 3)).toBeNull(); // front matter
    expect(headingSection("#hashtag\n- [ ] t\n", 1)).toBeNull(); // a tag, not a heading
  });
});

describe("planBatchShare", () => {
  it("shares the local Tasks of a range, nested ones as Tasks of their own", () => {
    const plan = planBatchShare(NOTE, { from: 3, to: 7 });
    expect(lines(NOTE, plan.share)).toEqual([
      "- [ ] Prepare API contract",
      "  - [ ] Draft the schema",
      "- [x] Kick-off",
      "- [ ] Deep task",
    ]);
    expect([plan.skipped, plan.refused]).toEqual([0, 0]);
    // A selection: only its lines; Tasks in a fence are not Tasks.
    expect(lines(NOTE, planBatchShare(NOTE, { from: 4, to: 5 }).share)).toEqual([
      "  - [ ] Draft the schema",
      "- [x] Kick-off",
    ]);
    expect(lines(NOTE, planBatchShare(NOTE, { from: 9, to: 14 }).share)).toEqual([
      "- [ ] Someday",
      "- [ ] After the fence",
    ]);
  });

  it("skips already shared Tasks and refuses blocked or empty ones", () => {
    const bad =
      "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-4c42-b85a-fc843e2f40ad";
    let md = [
      "## S",
      "- [ ] Shared",
      `- [ ] Malformed <!-- lfcp-ref: ${bad} -->`, // a UUIDv4: blocked
      "- [ ] Two refs",
      `  <!-- lfcp-ref: ${bad.replace("4c42", "7c42")} -->`,
      `  <!-- lfcp-ref: ${bad.replace("4c42", "7c43")} -->`, // two child refs: duplicate
      "- [ ] ",
      "- [ ] Local",
      "",
    ].join("\n");
    md = attachRef(md, 1, ref(1), "child-line"); // bound
    const plan = planBatchShare(md, { from: 1, to: splitLines(md).length - 1 });
    expect(lines(md, plan.share)).toEqual(["- [ ] Local"]);
    expect(plan.skipped).toBe(1);
    expect(plan.refused).toBe(3); // a malformed ref, duplicate refs, a Task without a title
  });
});

describe("attachAll", () => {
  const pending = (md: string, n: number[]): PendingRef[] => {
    const plan = planBatchShare(md, { from: 0, to: splitLines(md).length - 1 });
    return plan.share.map((s, i) => ({
      lineText: splitLines(md)[s.task.line]?.text ?? "",
      near: s.task.line,
      ref: ref(n[i] ?? i),
    }));
  };

  for (const placement of ["child-line", "inline"] as const)
    it(`attaches every ref in one pass (${placement})`, () => {
      const md = "## S\n- [ ] A\n  - [ ] B\n- [ ] A\n";
      const out = attachAll(md, pending(md, [1, 2, 3]), placement);
      expect(out.attached).toBe(3);
      const scan = scanRefs(out.markdown);
      expect(scan.tasks.every((t) => t.binding === "bound")).toBe(true);
      // Each Task got its own ref, the duplicate title included, in order.
      const byLine = [...scan.projections].sort((a, b) => a.taskLine - b.taskLine);
      expect(byLine.map((p) => p.objectId)).toEqual([id(1), id(2), id(3)]);
      expect(
        byLine.every((p) => p.placement === (placement === "inline" ? "inline" : "child")),
      ).toBe(true);
    });

  it("keeps CRLF and finds a Task that moved; a vanished one gets no ref", () => {
    const md = "## S\r\n- [ ] One\r\n- [ ] Two\r\n";
    const refs = pending(md, [1, 2]);
    const moved = `intro\r\n${md.replace("- [ ] Two\r\n", "")}`; // a line above, Two deleted
    const out = attachAll(moved, refs, "child-line");
    expect(out.attached).toBe(1);
    expect(out.markdown).not.toMatch(/(^|[^\r])\n/); // still CRLF only
    expect(scanRefs(out.markdown).projections.map((p) => p.objectId)).toEqual([id(1)]);
  });
});

describe("tasksToInsert", () => {
  it("leaves out Tasks the note shows and orders by created_at, then Object ID", () => {
    let md = "- [ ] Shown\n- [ ] Other collaboration\n";
    md = attachRef(md, 0, ref(1), "inline");
    md = attachRef(md, 1, ref(2, OTHER), "inline");
    const order = tasksToInsert(md, R, [
      { objectId: id(1), createdAt: "2026-10-07T10:00:00.000Z" }, // shown: left out
      { objectId: id(2), createdAt: "2026-10-07T10:00:00.002Z" }, // shown only for OTHER
      { objectId: id(5), createdAt: "2026-10-07T10:00:00.001Z" },
      { objectId: id(4) }, // unstamped first
      { objectId: id(3) },
    ]).map((t) => t.objectId);
    expect(order).toEqual([id(3), id(4), id(5), id(2)]);
  });
});
