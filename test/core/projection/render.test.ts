// LFCP-062: rendering Shared Objects state into Markdown Task lines.

import { principalId, resourceId, toBase64url } from "@openlfcp/core";
import {
  addTag,
  cancel,
  complete,
  createTask,
  deleteTask,
  type ReplicaIntent,
  reopen,
  SharedObjectsReplica,
  setDue,
  setPriority,
  setTitle,
  type Task,
} from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import {
  type RenderTarget,
  renderNewTaskLine,
  renderNote,
} from "../../../src/core/projection/render";
import { parseTaskText } from "../../../src/core/projection/task-text";

const R = resourceId(new Uint8Array(32).fill(3));
const ME = principalId(new Uint8Array(32).fill(4));
const ID = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
const REF = `lfcp1:${toBase64url(R)}#task:${ID}`;
const KEY = `${toBase64url(R)}#${ID}`;

function replica(
  title = "Prepare API contract",
  more: Partial<Parameters<typeof createTask>[0]> = {},
) {
  const { replica: r } = SharedObjectsReplica.create({ resource: R, principal: ME });
  r.apply(createTask({ id: ID as never, title, createdBy: ME, ...more }).intent);
  return r;
}
const task = (r: SharedObjectsReplica) => r.task(ID)?.task as Task;
const apply = (r: SharedObjectsReplica, intent: ReplicaIntent) => r.apply(intent);
const lookup =
  (r: SharedObjectsReplica, extra: Partial<RenderTarget> = {}) =>
  (key: string) =>
    key === KEY ? { view: r.task(ID), ...extra } : undefined;
const child = (line: string) => `- ${line}\n  <!-- lfcp-ref: ${REF} -->\n`;

describe("renderNote (LFCP-062)", () => {
  it("updates a remote status in child and inline placements, keeping the ref bytes and placement", () => {
    const r = replica();
    apply(r, complete(task(r)).intent);
    const note = `# Personal\n\nPrivate paragraph.\n\n- [ ] Prepare API contract\n  <!--  lfcp-ref: ${REF}  -->\n\nAnother paragraph.\n- [ ] Prepare API contract <!-- lfcp-ref: ${REF} -->  \n`;
    const out = renderNote(note, lookup(r));
    expect(out.text).toBe(note.replaceAll("- [ ] Prepare", "- [x] Prepare"));
    expect(out.projections.map((p) => p.changed)).toEqual([["status"], ["status"]]);
  });

  it("is idempotent: an already-current note is not changed", () => {
    const r = replica();
    apply(r, setDue(task(r), "2026-10-10").intent);
    const once = renderNote(child("[ ] Prepare API contract"), lookup(r));
    expect(once.changed).toBe(true);
    const twice = renderNote(once.text, lookup(r));
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("rewrites only owned pieces and keeps unowned tokens, the block ID and spacing", () => {
    const r = replica();
    apply(r, setTitle(task(r), "Prepare the API").intent);
    apply(r, setDue(task(r), "2026-10-12").intent);
    apply(r, setPriority(task(r), "high").intent);
    const before = child(
      "[ ] Prepare API contract 🔼 🔁 every week 🛫 2026-10-01 📅️ 2026-10-10 ^blk",
    );
    const out = renderNote(before, lookup(r));
    expect(out.text).toBe(
      child("[ ] Prepare the API ⏫ 🔁 every week 🛫 2026-10-01 📅 2026-10-12 ^blk"),
    );
  });

  it("writes ✅ exactly once on a done Task and removes it when the status leaves done (ST-5)", () => {
    const r = replica();
    apply(r, complete(task(r), "2026-10-03").intent);
    const done = renderNote(
      child("[ ] Prepare API contract ✅ 2026-10-01 ✅ 2026-10-02"),
      lookup(r),
    );
    expect(done.text).toBe(child("[x] Prepare API contract ✅ 2026-10-03"));
    expect(renderNote(done.text, lookup(r)).changed).toBe(false);
    apply(r, reopen(task(r)).intent);
    expect(renderNote(done.text, lookup(r)).text).toBe(child("[ ] Prepare API contract"));
    apply(r, cancel(task(r)).intent);
    expect(renderNote(done.text, lookup(r)).text).toBe(child("[-] Prepare API contract"));
  });

  it("never touches local Tasks, even with ✅, nor unrelated text", () => {
    const r = replica();
    apply(r, complete(task(r), "2026-10-03").intent);
    const note = `- [x] Local ✅ 2026-09-01\n${child("[ ] Prepare API contract")}Tail without newline`;
    const out = renderNote(note, lookup(r));
    expect(out.text).toBe(
      `- [x] Local ✅ 2026-09-01\n${child("[x] Prepare API contract ✅ 2026-10-03")}Tail without newline`,
    );
  });

  it("keeps CRLF line endings and the indentation of nested Tasks", () => {
    const r = replica();
    apply(r, complete(task(r)).intent);
    const note = `- [ ] Parent\r\n    - [ ] Prepare API contract\r\n      <!-- lfcp-ref: ${REF} -->\r\n`;
    expect(renderNote(note, lookup(r)).text).toBe(
      note.replace("    - [ ] Prepare", "    - [x] Prepare"),
    );
  });

  it("keeps the user's glyph when it already means the status ([X])", () => {
    const r = replica();
    apply(r, complete(task(r)).intent);
    expect(renderNote(child("[X] Prepare API contract"), lookup(r)).changed).toBe(false);
  });

  it("writes tags as one sorted trailing run, keeps the user's order for the same set, skips non-Obsidian tags", () => {
    const r = replica("Plan", { tags: ["web", "api", "two words"], due: "2026-10-10" });
    const out = renderNote(child("[ ] Plan 📅 2026-10-10"), lookup(r));
    expect(out.text).toBe(child("[ ] Plan #api #web 📅 2026-10-10"));
    expect(out.projections[0]?.issues.map((i) => i.code)).toEqual(["TAG_NOT_RENDERABLE"]);
    expect(renderNote(child("[ ] Plan #web #api 📅 2026-10-10"), lookup(r)).changed).toBe(false);
    apply(r, addTag(task(r), "ops").intent);
    expect(renderNote(child("[ ] Plan #web #api 📅 2026-10-10"), lookup(r)).text).toBe(
      child("[ ] Plan #api #ops #web 📅 2026-10-10"),
    );
  });

  it("leaves a legacy LFCP-061 title with trailing tags stable", () => {
    const r = replica("Plan #backend");
    const out = renderNote(child("[ ] Plan"), lookup(r));
    expect(parseTaskText(out.text.split("\n")[0]?.slice(6) ?? "")).toMatchObject({
      title: "Plan",
      tags: ["backend"],
    });
    expect(renderNote(out.text, lookup(r)).changed).toBe(false);
  });

  it("renders the visible value of a conflict, reports it, and writes no conflict marker", () => {
    const r = replica("Base");
    const other = SharedObjectsReplica.fromChanges(r.changes(), {
      resource: R,
      principal: principalId(new Uint8Array(32).fill(9)),
    }).replica;
    const theirs = other.apply(setTitle(other.task(ID)?.task as Task, "Theirs").intent);
    const theirsDue = other.apply(setDue(other.task(ID)?.task as Task, "2026-11-01").intent);
    apply(r, setTitle(task(r), "Mine").intent);
    apply(r, setDue(task(r), "2026-11-02").intent);
    r.receiveChange(theirs?.change as Uint8Array);
    r.receiveChange(theirsDue?.change as Uint8Array);
    const out = renderNote(child("[ ] Base"), lookup(r));
    const visible = r.task(ID)?.fields.title.value as string;
    expect(out.text).toContain(`[ ] ${visible} 📅 ${r.task(ID)?.fields.due.value}`);
    expect(out.projections[0]?.conflicts).toEqual(["title", "due"]);
    expect(out.text).not.toMatch(/<{7}|={7}|>{7}/);
  });

  it("does not rewrite deleted, invalid, collided or unknown objects", () => {
    const r = replica();
    apply(r, deleteTask(task(r)).intent);
    const note = child("[ ] Old title");
    const out = renderNote(note, lookup(r));
    expect(out).toMatchObject({ changed: false, text: note });
    expect(out.projections[0]?.issues.map((i) => i.code)).toEqual(["OBJECT_DELETED"]);
    for (const [view, code] of [
      [undefined, "OBJECT_UNKNOWN"],
      [{ status: "profile_invalid", task: undefined }, "OBJECT_PROFILE_INVALID"],
      [{ status: "object_id_collision", task: undefined }, "OBJECT_ID_COLLISION"],
    ] as const) {
      const o = renderNote(note, (k) => (k === KEY ? { view: view as never } : undefined));
      expect(o.text).toBe(note);
      expect(o.projections[0]?.issues.map((i) => i.code)).toEqual([code]);
    }
    // Objects the lookup does not cover are left alone without a report.
    expect(renderNote(note, () => undefined)).toMatchObject({ changed: false, projections: [] });
  });

  it("never renders into a Task the ref slid under (ST-2)", () => {
    const r = replica();
    apply(r, complete(task(r)).intent);
    const note = `- [ ] Prepare API contract\n- [ ] \n  <!-- lfcp-ref: ${REF} -->\n`;
    const out = renderNote(note, lookup(r));
    expect(out).toMatchObject({ changed: false, text: note });
    expect(out.projections[0]?.issues.map((i) => i.code)).toEqual(["REF_REASSOCIATION_SUSPECTED"]);
  });

  it("reports a G-EP7 regression it renders (item 3)", () => {
    const r = replica();
    const out = renderNote(child("[x] Prepare API contract"), lookup(r, { regressed: true }));
    expect(out.text).toBe(child("[ ] Prepare API contract"));
    expect(out.projections[0]?.issues.map((i) => i.code)).toEqual(["STATE_REGRESSED"]);
  });

  it("renders a new projection unit that scans back to the same binding and represents the Task (renderNewTaskLine)", () => {
    const r = replica("Ship it", { tags: ["web"], due: "2026-10-10", priority: "high" });
    apply(r, complete(task(r), "2026-10-04").intent);
    const ref = { resourceId: R, objectType: "task", objectId: ID } as const;
    for (const placement of ["inline", "child"] as const)
      for (const eol of ["\n", "\r\n"]) {
        const unit = renderNewTaskLine(task(r), {
          placement,
          ref,
          indent: "  ",
          marker: "1.",
          eol,
        });
        expect(unit.endsWith(eol)).toBe(true);
        const out = renderNote(unit, lookup(r));
        expect(out.changed).toBe(false);
        expect(out.projections.map((p) => p.key)).toEqual([KEY]);
      }
    expect(renderNewTaskLine(task(r), { placement: "child", ref })).toBe(
      `- [x] Ship it #web ⏫ 📅 2026-10-10 ✅ 2026-10-04\n  <!-- lfcp-ref: ${REF} -->\n`,
    );
  });
});
