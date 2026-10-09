// Task field edits inside sections: the 0.1 planner on section Tasks.

import { principalId, resourceId } from "@openlfcp/core";
import { createTask, SharedObjectsReplica } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import type { SectionState } from "../../../src/core/sections/base";
import {
  newSectionTask,
  planTaskFields,
  representLine,
} from "../../../src/core/sections/task-fields";

const T = "019a2f85-7b31-7c42-b85a-fc843e2f4009";
const REF =
  "<!-- lfcp-ref: lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f4009 -->";
const me = principalId(new Uint8Array(32).fill(4));

const state = (line: string): SectionState => ({
  title: "Launch",
  nodes: { [T]: { kind: "task", parent: null, line } },
  order: { "": [T] },
});

function view() {
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(new Uint8Array(32).fill(3)),
    principal: me,
  });
  replica.apply(
    createTask({ id: T as never, title: "Contract", createdBy: me, due: "2026-11-01" }).intent,
  );
  return () => replica.task(T);
}

describe("representLine", () => {
  it("reads the glyph and the fields, without an inline ref at the end or before the fields", () => {
    for (const line of [
      `- [x] Contract 📅 2026-11-01 ${REF}`,
      `- [x] Contract ${REF} 📅 2026-11-01`,
      "- [x] Contract 📅 2026-11-01",
    ]) {
      const r = representLine(line);
      expect(r?.status).toBe("done");
      expect(r?.text.title).toBe("Contract");
      expect(r?.text.due).toBe("2026-11-01");
    }
    expect(representLine("- Not a task")).toBeNull();
  });
});

describe("planTaskFields", () => {
  it("sends only what the user changed since the base", () => {
    const base = state("- [ ] Contract 📅 2026-11-01");
    const v = view();
    expect(planTaskFields(base, base, v).intents).toEqual([]);
    const moved = planTaskFields(state("- [ ] Contract 📅 2026-11-05"), base, v);
    expect(moved.intents.map((i) => i.intent)).toEqual(["task.set_due"]);
    const done = planTaskFields(state("- [x] Contract 📅 2026-11-01"), base, v);
    expect(done.intents.map((i) => i.intent)).toEqual(["task.complete"]);
  });

  it("reports the planner's issues, such as an unknown Task", () => {
    const r = planTaskFields(state("- [x] Contract"), state("- [ ] Contract"), () => undefined);
    expect(r.intents).toEqual([]);
    expect(r.issues.map((i) => i.issue.code)).toContain("OBJECT_UNKNOWN");
  });
});

describe("a new section Task from its line", () => {
  it("at any depth: a Task nested three levels down is a Task, not code (LFCP-02-067 W200)", () => {
    for (const indent of ["", "  ", "    ", "      ", "\t\t"]) {
      const t = newSectionTask(`${indent}- [ ] Deep task 📅 2026-11-02`, me, T);
      expect(t).toMatchObject({ title: "Deep task", due: "2026-11-02" });
    }
    expect(() => newSectionTask("    plain text", me, T)).toThrow("not a Task line");
  });
});
