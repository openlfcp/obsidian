// LFCP-065: the Markdown side of the collaboration commands, against
// exact-byte fixtures (test/fixtures/collab/detach.json).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ObjectId, principalId, resourceId } from "@openlfcp/core";
import { createTask, principalRef } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { attachToTask, detachExact, planShare, taskAt } from "../../../src/core/collab/markdown";
import { renderNewTaskLine } from "../../../src/core/projection/render";
import { attachRef, type ObjectRef, scanRefs } from "../../../src/core/refs";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/collab/detach.json"), "utf8"),
) as { cases: { id: string; before: string; line: number; after: string }[] };

const ALICE = principalId(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ID = "019a2f85-7b31-7c42-b85a-fc843e2f40ad" as ObjectId;
const REF: ObjectRef = {
  resourceId: resourceId(Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + (i % 16))),
  objectType: "task",
  objectId: ID,
};

const bound = (markdown: string, line: number) => {
  const at = taskAt(markdown, line);
  if (at.kind !== "bound") throw new Error(`line ${line} is ${at.kind}`);
  return at.ref;
};

describe("detach (LFCP-065, MARKDOWN-REFS-01 §18)", () => {
  for (const c of fixtures.cases)
    it(`removes exactly the ref: ${c.id}`, () => {
      const after = detachExact(c.before, bound(c.before, c.line));
      expect(after).toBe(c.after);
      // The visible Task is the same and is now local.
      const task = scanRefs(after).tasks.find((t) => t.task.line === c.line);
      expect(task?.binding).toBe("local");
      expect(scanRefs(after).projections).toEqual([]);
    });

  it("undoes attachRef byte for byte, both placements, every line ending", () => {
    for (const eol of ["\n", "\r\n", "\r"])
      for (const tail of ["", `${eol}- [ ] Next${eol}`])
        for (const placement of ["child-line", "inline"] as const) {
          const note = `# T${eol}- [x] Prepare API contract 📅 2026-10-15${tail}`;
          const attached = attachRef(note, 1, REF, placement);
          const back = detachExact(attached, bound(attached, 1));
          // A last Task line without an ending gets one from attachRef (child); detach gives it back.
          expect(back, `${placement} ${JSON.stringify(eol)} ${JSON.stringify(tail)}`).toBe(note);
        }
  });

  it("finds the Task from its child ref line too", () => {
    const note = fixtures.cases[0]?.before as string;
    expect(taskAt(note, 1).kind).toBe("bound");
    expect(taskAt(note, 2).kind).toBe("local");
    expect(taskAt("Plain text\n", 0).kind).toBe("none");
  });
});

describe("share planning (LFCP-065)", () => {
  const state = (line: string) => {
    const at = taskAt(line, 0);
    if (at.kind !== "local") throw new Error(at.kind);
    return at.state;
  };

  it("shares what LFCP-061 owns and keeps the rest local", () => {
    const plan = planShare(
      state("- [x] Prepare API contract 🔼 🛫 2026-10-01 📅 2026-10-15 ✅ 2026-10-14 #api #ui ^b1"),
      ALICE,
      ID,
    );
    expect(plan.objectId).toBe(ID);
    expect(plan.intents).toEqual([
      createTask({
        id: ID,
        title: "Prepare API contract",
        createdBy: ALICE,
        status: "done",
        due: "2026-10-15",
        tags: ["api", "ui"],
      }).intent,
      { intent: "task.complete", id: ID, completionDate: "2026-10-14" },
    ]);
    expect(plan.warnings).toEqual([
      "This priority has no shared equivalent; the shared task starts as normal.",
    ]);
  });

  it("warns about unowned glyphs, links and recurrence; keeps ✅ local unless done", () => {
    const plan = planShare(
      state("- [>] See [[Meeting notes]] 🔁 every week ⏫ ✅ 2026-10-14"),
      ALICE,
      ID,
    );
    const create = plan.intents[0] as { task: Record<string, unknown> };
    expect(create.task).toMatchObject({ status: "todo", priority: "high" });
    expect(plan.intents).toHaveLength(1);
    expect(plan.warnings).toEqual([
      "The title links to notes: their names are shared with collaborators.",
      "Recurrence (🔁) is not shared; collaborators do not see it.",
      'The checkbox [>] has no shared status; the shared task starts as "todo".',
      "The ✅ date is kept local: the task is not done.",
    ]);
  });

  it("stamps created_at when given one", () => {
    const at = "2026-10-07T10:00:00.003Z";
    const create = planShare(state("- [ ] Ship it"), ALICE, ID, at).intents[0] as {
      task: Record<string, unknown>;
    };
    expect(create.task.created_at).toBe(at);
    const unstamped = planShare(state("- [ ] Ship it"), ALICE, ID).intents[0] as {
      task: Record<string, unknown>;
    };
    expect("created_at" in unstamped.task).toBe(false);
  });

  it("refuses a Task without a title", () => {
    expect(() => planShare(state("- [ ] 📅 2026-10-15"), ALICE, ID)).toThrow(
      "The task has no title to share.",
    );
  });
});

describe("attaching and inserting (LFCP-065)", () => {
  it("attaches to the same Task even when lines moved, child-line by default", () => {
    const read = "- [ ] Other\n- [ ] Share me\n";
    const now = "New first line\n- [ ] Other\n- [ ] Share me\n";
    const out = attachToTask(now, "- [ ] Share me", 1, REF, "child-line");
    expect(out).toBe(
      `New first line\n- [ ] Other\n- [ ] Share me\n  <!-- lfcp-ref: lfcp1:wMHCw8TFxsfIycrLzM3Oz8DBwsPExcbHyMnKy8zNzs8#task:${ID} -->\n`,
    );
    expect(attachToTask(read, "- [ ] Gone", 1, REF, "inline")).toBeNull();
    expect(attachToTask(out as string, "- [ ] Share me", 2, REF, "inline")).toBeNull();
  });

  it("inline placement when configured", () => {
    expect(attachToTask("- [ ] Share me\r\n", "- [ ] Share me", 0, REF, "inline")).toBe(
      `- [ ] Share me <!-- lfcp-ref: lfcp1:wMHCw8TFxsfIycrLzM3Oz8DBwsPExcbHyMnKy8zNzs8#task:${ID} -->\r\n`,
    );
  });

  it("inserts a projection rendered from the shared state (renderNewTaskLine)", () => {
    const task = createTask({
      id: ID,
      title: "Prepare API contract",
      createdBy: ALICE,
      status: "in_progress",
      priority: "high",
      due: "2026-10-15",
      tags: ["api"],
      assignees: [principalRef(ALICE)],
    }).task;
    for (const placement of ["child", "inline"] as const) {
      const text = renderNewTaskLine(task, { placement, ref: REF, eol: "\r\n" });
      const scan = scanRefs(`Intro\r\n${text}`);
      expect(scan.projections.map((p) => [p.objectId, p.placement])).toEqual([[ID, placement]]);
      expect(scan.diagnostics).toEqual([]);
      expect(text.startsWith("- [/] Prepare API contract")).toBe(true);
    }
  });
});
