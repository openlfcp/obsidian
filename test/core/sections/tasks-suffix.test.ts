// A Tasks suffix after an inline ref inside a shared section
// (MARKDOWN-SECTIONS-01 §4.1; MS42 and MS44 are copied from
// MARKDOWN-SECTIONS-FIXTURES-01, spec mvp-0.2-baseline.1).

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { createTask, SharedObjectsReplica } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { scanRefs } from "../../../src/core/refs/scanner";
import { isTasksSuffix, suffixAmbiguous } from "../../../src/core/refs/tasks-suffix";
import { markdownState } from "../../../src/core/sections/base";
import { canonicalInline } from "../../../src/core/sections/inline";
import { bindingChanges } from "../../../src/core/sections/markers";
import { parseSections, scanSectionRefs } from "../../../src/core/sections/parser";
import { applyRemote, planRemote } from "../../../src/core/sections/remote";
import { planStructure } from "../../../src/core/sections/structure";
import { planTaskFields, representLine } from "../../../src/core/sections/task-fields";

const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SECTION = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const TASK = "2372cd94-58dc-7fd0-bbc6-6e17c0aebc80";
const REF = `<!-- lfcp-ref: lfcp1:${R}#task:${TASK} -->`;
const note = (line: string) =>
  [
    "PRIVATE_BEFORE_8f3a: budget and personal thoughts.",
    "",
    "## Joint launch",
    `<!-- lfcp-section: ${SECTION} -->`,
    line,
    `<!-- /lfcp-section: ${SECTION} -->`,
    "",
    "PRIVATE_AFTER_71c2: do not transmit.",
    "",
  ].join("\n");

describe("isTasksSuffix (§4.1 table)", () => {
  it("accepts dates, priority, recurrence, dependencies, on-completion and a block ID", () => {
    for (const s of [
      " ✅ 2026-10-08",
      " 🔁 every week 📅 2026-10-08",
      "\t⏫ 🛫 2026-10-01 ➕ 2026-09-30  ",
      " 🆔 a1 ⛔ b2,c-3 🏁 delete ^block-1",
      " 📅️ 2026-10-08",
    ])
      expect(isTasksSuffix(s), s).toBe(true);
  });

  it("refuses other text, a malformed field and nothing at all", () => {
    for (const s of [
      " call Anna first",
      " 📅 next week",
      " #tag",
      "",
      " ✅2026-10-08",
      " 🏁 maybe",
    ])
      expect(isTasksSuffix(s), s).toBe(false);
  });

  it("tells a field given both before and after the ref", () => {
    expect(suffixAmbiguous("Water 📅 2026-10-01", " 📅 2026-10-08")).toBe(true);
    expect(suffixAmbiguous("Water ⏫", " 🔽")).toBe(true);
    expect(suffixAmbiguous("Water 📅 2026-10-01", " ✅ 2026-10-08")).toBe(false);
  });
});

describe("inside a section only", () => {
  it("MS42: Tasks' ✅ after an inline ref is a completion date; the Task stays bound", () => {
    const md = note(`- [x] Prepare contract ${REF} ✅ 2026-10-08`);
    const scan = parseSections(md);
    expect(scan.sections[0]?.blocked).toBe(false);
    const p = scanSectionRefs(md).projections[0];
    expect(p?.objectId).toBe(TASK);
    expect(p?.taskText).toBe("Prepare contract ✅ 2026-10-08");
    const r = representLine(`- [x] Prepare contract ${REF} ✅ 2026-10-08`);
    expect(r?.status).toBe("done");
    expect(r?.text.completion).toBe("2026-10-08");
    // Outside a section the same line is LFCP_REF_NOT_AT_LINE_END (MARKDOWN-REFS-01 §11).
    expect(scanRefs(md).diagnostics.map((d) => d.code)).toContain("LFCP_REF_NOT_AT_LINE_END");
  });

  it("MS42: the completion goes out as task.complete with Tasks' date", () => {
    const me = principalId(new Uint8Array(32).fill(4));
    const { replica } = SharedObjectsReplica.create({
      resource: resourceId(new Uint8Array(32).fill(3)),
      principal: me,
    });
    replica.apply(
      createTask({ id: TASK as never, title: "Prepare contract", createdBy: me }).intent,
    );
    const before = note(`- [ ] Prepare contract ${REF}`);
    const after = note(`- [x] Prepare contract ${REF} ✅ 2026-10-08`);
    const state = (md: string) => {
      const s = parseSections(md).sections[0];
      if (s === undefined) throw new Error("no section");
      return markdownState(md, s).state;
    };
    const plan = planTaskFields(state(after), state(before), () => replica.task(TASK));
    expect(plan.intents).toEqual([
      { intent: "task.complete", id: TASK, completionDate: "2026-10-08" },
    ]);
  });

  it("MS44: other text after the ref blocks the Task, and pauses the section", () => {
    const md = note(`- [ ] Prepare contract ${REF} call Anna first`);
    expect(scanSectionRefs(md).diagnostics.map((d) => d.code)).toContain(
      "LFCP_REF_NOT_AT_LINE_END",
    );
    expect(parseSections(md).sections[0]?.blocked).toBe(true);
  });

  it("a field before and after the ref is ambiguous: blocked", () => {
    const md = note(`- [ ] Water 📅 2026-10-01 ${REF} 📅 2026-10-08`);
    expect(scanSectionRefs(md).diagnostics.map((d) => d.code)).toContain(
      "LFCP_REF_NOT_AT_LINE_END",
    );
    expect(parseSections(md).sections[0]?.blocked).toBe(true);
  });
});

describe("the canonical inline form (§4.1)", () => {
  const me = principalId(new Uint8Array(32).fill(4));
  const view = (title: string, more: Record<string, unknown> = {}) => {
    const { replica } = SharedObjectsReplica.create({
      resource: resourceId(fromBase64url(R)),
      principal: me,
    });
    replica.apply(createTask({ id: TASK as never, title, createdBy: me, ...more }).intent);
    return replica;
  };
  const sectionOf = (md: string) => {
    const s = parseSections(md).sections[0];
    if (s === undefined) throw new Error("no section");
    return s;
  };

  it("MS45: an inline ref after the Tasks fields moves before them", () => {
    const line = `- [ ] Water plants 🔁 every week 📅 2026-10-08 ${REF}`;
    expect(canonicalInline(line)).toBe(`- [ ] Water plants ${REF} 🔁 every week 📅 2026-10-08`);
    // Already canonical, or no fields: nothing to move.
    expect(canonicalInline(`- [ ] Water plants ${REF} 🔁 every week`)).toBeNull();
    expect(canonicalInline(`- [ ] Water plants #home ${REF}`)).toBeNull();
    expect(canonicalInline("- [ ] No ref 📅 2026-10-08")).toBeNull();
  });

  it("a collaborator's completion keeps the ref before the fields", () => {
    const replica = view("Water plants", { due: "2026-10-08" });
    replica.apply({ intent: "task.complete", id: TASK as never, completionDate: "2026-10-08" });
    const md = note(`- [ ] Water plants ${REF} 🔁 every week 📅 2026-10-08`);
    const base = markdownState(md, sectionOf(md)).state;
    const snap = {
      revision: "h2",
      title: "Joint launch",
      ready: true,
      nodes: { [TASK]: { kind: "task" as const, parent: null, lifecycle: "active" as const } },
      order: { "": [TASK] },
      problems: [],
    };
    const p = planRemote(md, sectionOf(md), base, snap, () => ({ view: replica.task(TASK) }));
    if (p.kind !== "patch") throw new Error(p.kind);
    expect(applyRemote(md, p)).toBe(
      note(`- [x] Water plants ${REF} 🔁 every week 📅 2026-10-08 ✅ 2026-10-08`),
    );
  });

  it("a new Task's ref under the inline setting goes before its fields, and binds", () => {
    const md = note("- [ ] Call Anna 📅 2026-11-01");
    const s = sectionOf(md);
    const [u] = markdownState(md, s).unbound;
    const r = bindingChanges(
      md,
      s,
      [{ line: u?.line ?? 0, kind: "task", id: TASK }],
      fromBase64url(R),
      "inline",
    );
    const out = r.changes.reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), md);
    expect(out).toBe(note(`- [ ] Call Anna ${REF} 📅 2026-11-01`));
    expect(scanSectionRefs(out).projections[0]?.objectId).toBe(TASK);
    expect(parseSections(out).sections[0]?.blocked).toBe(false);
  });

  it("a Task a collaborator added, under the inline setting, is written canonically", () => {
    const md = note("");
    const base = markdownState(md, sectionOf(md)).state;
    const replica = view("Call Anna", { due: "2026-11-01" });
    const snap = {
      revision: "h2",
      title: "Joint launch",
      ready: true,
      nodes: { [TASK]: { kind: "task" as const, parent: null, lifecycle: "active" as const } },
      order: { "": [TASK] },
      problems: [],
    };
    const p = planStructure(md, sectionOf(md), base, snap, {
      resourceId: fromBase64url(R),
      task: () => replica.task(TASK)?.task,
      placement: "inline",
    });
    const out = p.changes.reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), md);
    expect(out).toContain(`- [ ] Call Anna ${REF} 📅 2026-11-01\n`);
  });
});
