// Every way a person moves a Task in a shared section, on the real section
// replica (after the cut-and-paste loss of 0.4.0-beta.1, cut-paste.test.ts):
// the Task stays active, the note shows it once, and two vaults moving it
// to different places offline both need attention. Each edit is the note as
// the editor leaves it, with the IDs the host collects from removed lines.

import { SectionReplica } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import {
  A_ME,
  block,
  count,
  cut,
  id,
  lines,
  paste,
  pasteInto,
  placementConflict,
  reconnect,
  sectionNote,
  shared,
  taskId,
  twoVaults,
  type Vault,
} from "../../support/section-vaults";

const BODY = [
  "- [ ] Buy milk",
  "- [ ] Write report",
  "  - [ ] Draft",
  "- [ ] Call Anna",
  "",
  "A paragraph",
];

/** The note with the lines [from, to) put before line `at`. */
function moveLines(md: string, [from, to]: [number, number], at: number): string {
  const L = lines(md);
  const moved = L.slice(from, to);
  const rest = [...L.slice(0, from), ...L.slice(to)];
  const k = at > from ? at - (to - from) : at;
  return [...rest.slice(0, k), ...moved, ...rest.slice(k)].join("\n");
}

/** The note with the Task `title` and its nested lines indented by a tab (Tab), or by one less (Shift+Tab). */
function indent(md: string, title: string, out = false): string {
  const [from, to] = block(md, title);
  return lines(md)
    .map((l, k) => (k < from || k >= to ? l : out ? l.replace(/^(\t| {2})/, "") : `\t${l}`))
    .join("\n");
}

/** A drag of the Task `title` under `parent` (one editor transaction: the lines move at once). */
function drag(v: Vault, title: string, parent: string) {
  const before = v.note();
  return v.pass(paste(before, cut(before, title), title, parent, "\t"), {
    deletedIds: new Set([taskId(before, title)]),
  });
}

const active = (v: Vault, nodeId: string) => v.model()?.nodes[nodeId]?.lifecycle === "active";

describe("moving a Task in one vault", () => {
  it("Move line up/down, the Task with its ref: a reorder, nothing deleted", async () => {
    const { a } = await twoVaults(BODY);
    const anna = taskId(a.note(), "Call Anna");
    const report = block(a.note(), "Write report");
    // The editor replaces both lines: the host sees both bindings removed.
    const ids = new Set([anna, taskId(a.note(), "Write report")]);
    await a.pass(moveLines(a.note(), block(a.note(), "Call Anna"), report[0]), { deletedIds: ids });
    expect(active(a, anna)).toBe(true);
    expect(count(a.note(), "Call Anna")).toBe(1);
    const order = a.model()?.order?.[""] ?? [];
    expect(order.indexOf(anna)).toBeLessThan(order.indexOf(taskId(a.note(), "Write report")));
  });

  it("Move line on the Task line alone, its ref left behind: the section pauses, nothing is lost", async () => {
    const { a } = await twoVaults(BODY);
    const anna = taskId(a.note(), "Call Anna");
    const [from] = block(a.note(), "Call Anna");
    const r = await a.pass(moveLines(a.note(), [from, from + 1], from - 1));
    expect(r?.skipped).toBe("blocked");
    expect(active(a, anna)).toBe(true);
    expect(Object.values(a.model()?.nodes ?? {}).filter((n) => n.lifecycle !== "active")).toEqual(
      [],
    );
  });

  it("a drag under another Task: moved, the note shows it once", async () => {
    const { a } = await twoVaults(BODY);
    const anna = taskId(a.note(), "Call Anna");
    await drag(a, "Call Anna", "Buy milk");
    expect(a.model()?.nodes[anna]).toMatchObject({
      lifecycle: "active",
      parent: taskId(a.note(), "Buy milk"),
    });
    expect(count(a.note(), "Call Anna")).toBe(1);
  });

  it("Tab on a Task with a subtask moves both; Shift+Tab on the subtask moves it out", async () => {
    const { a } = await twoVaults(BODY);
    const milk = taskId(a.note(), "Buy milk");
    const report = taskId(a.note(), "Write report");
    const draft = taskId(a.note(), "Draft");
    await a.pass(indent(a.note(), "Write report"));
    expect(a.model()?.nodes[report]).toMatchObject({ lifecycle: "active", parent: milk });
    expect(a.model()?.nodes[draft]).toMatchObject({ lifecycle: "active", parent: report });
    await a.pass(indent(a.note(), "Draft", true));
    expect(a.model()?.nodes[draft]).toMatchObject({ lifecycle: "active", parent: milk });
    expect([count(a.note(), "Write report"), count(a.note(), "Draft")]).toEqual([1, 1]);
  });

  it("undo of a cut restores the Task; redo deletes it again", async () => {
    const { a } = await twoVaults(BODY);
    const before = a.note();
    const anna = taskId(before, "Call Anna");
    const ids = new Set([anna]);
    await a.pass(cut(before, "Call Anna"), { deletedIds: ids, cut: ids });
    await a.pass(before, { origin: "undo", cut: ids });
    expect(active(a, anna)).toBe(true);
    expect(count(a.note(), "Call Anna")).toBe(1);
    await a.pass(cut(before, "Call Anna"), { origin: "redo", deletedIds: ids, cut: ids });
    expect(a.model()?.nodes[anna]?.lifecycle).toBe("deleted");
  });

  it("a cut in one note pasted in another copy of the section: moved, each note shows it once", async () => {
    const { a } = await twoVaults(BODY);
    const before = a.note();
    const anna = taskId(before, "Call Anna");
    await a.pass(before, {}, "Copy.md");
    const ids = new Set([anna]);
    await a.pass(cut(before, "Call Anna"), { deletedIds: ids, cut: ids });
    await a.pass(a.note("Copy.md"), {}, "Copy.md");
    const pasted = paste(before, a.note("Copy.md"), "Call Anna", "Buy milk", "\t");
    await a.pass(pasted, { cut: ids }, "Copy.md");
    await a.pass(a.note());
    expect(a.model()?.nodes[anna]).toMatchObject({
      lifecycle: "active",
      parent: taskId(before, "Buy milk"),
    });
    expect([count(a.note(), "Call Anna"), count(a.note("Copy.md"), "Call Anna")]).toEqual([1, 1]);
  });

  /** Vault A with a second section, of another Resource, in Other.md. */
  async function withOther() {
    const { a, b } = await twoVaults(BODY);
    const other = shared(9, id(900));
    const replica = SectionReplica.empty({ resource: other.rid, principal: A_ME });
    replica.commit([
      { intent: "section.create", sectionId: other.sid, title: "Other", createdBy: A_ME },
    ]);
    a.replicas.set(other.R, replica);
    await a.pass(sectionNote(other, "Other", []), {}, "Other.md");
    await a.pass(sectionNote(other, "Other", ["- [ ] Existing"]), {}, "Other.md");
    await a.pass(a.note("Other.md"), {}, "Other.md");
    return { a, b, other };
  }

  /** A cuts "Call Anna" (a delete) and returns its lines as cut. */
  async function cutAnna(a: Vault) {
    const before = a.note();
    const anna = taskId(before, "Call Anna");
    const ids = new Set([anna]);
    await a.pass(cut(before, "Call Anna"), { deletedIds: ids, cut: ids });
    const [from, to] = block(before, "Call Anna");
    return { anna, ids, text: `${lines(before).slice(from, to).join("\n")}\n` };
  }

  it("a paste into another Resource's section is a copy with a new identity, shared there (§10)", async () => {
    const { a, other } = await withOther();
    const { anna, ids, text } = await cutAnna(a);
    const target = a.note("Other.md");
    const end = lines(target).findIndex((l) => l.includes("/lfcp-section"));
    const pasted = pasteInto(a, target, end, text);
    // The old ref is gone before the engine sees the text: it binds nothing there.
    expect(pasted).not.toContain(anna);
    const r = await a.pass(pasted, { cut: ids }, "Other.md");
    expect(r?.skipped).toBeUndefined();
    expect(r?.local?.kind).toBe("committed");
    const copy = taskId(a.note("Other.md"), "Call Anna");
    expect(copy).not.toBe(anna);
    expect(a.model(other)?.nodes[copy]?.lifecycle).toBe("active");
    expect(a.replica(other).task(copy)?.task?.title).toBe("Call Anna");
    expect(count(a.note("Other.md"), "Call Anna")).toBe(1);
    // The cut stays a delete in its own section; neither projection differs from its model.
    expect(a.model()?.nodes[anna]?.lifecycle).toBe("deleted");
    expect(r?.reappeared).toBeUndefined();
    expect((await a.pass(a.note()))?.reappeared).toBeUndefined();
  });

  it("a paste outside every section is plain text: the section's bindings are removed", async () => {
    const { a } = await withOther();
    const { anna, text } = await cutAnna(a);
    const plain = pasteInto(a, "# Notes\n\nEnd\n", 2, text);
    expect(plain).toBe("# Notes\n\n- [ ] Call Anna\nEnd\n");
    expect(plain).not.toContain(anna);
  });

  it("a paste of the cut back into its own section keeps the binding: a move", async () => {
    const { a } = await withOther();
    const { anna, ids, text } = await cutAnna(a);
    const [, end] = block(a.note(), "Buy milk");
    const pasted = pasteInto(a, a.note(), end, text);
    expect(pasted).toContain(anna);
    await a.pass(pasted, { cut: ids });
    expect(active(a, anna)).toBe(true);
    expect(count(a.note(), "Call Anna")).toBe(1);
  });
});

describe("moving one Task in two vaults offline", () => {
  it("both drag it under different Tasks: both keep it once and need attention", async () => {
    const { a, b } = await twoVaults(BODY);
    const anna = taskId(a.note(), "Call Anna");
    await drag(a, "Call Anna", "Buy milk");
    await drag(b, "Call Anna", "Write report");
    await reconnect(a, b);
    for (const v of [a, b]) {
      expect(active(v, anna)).toBe(true);
      expect(placementConflict(v, anna)).toBe(true);
      expect(count(v.note(), "Call Anna")).toBe(1);
    }
  });

  it("one Tabs it under a Task, the other drags it under another: both need attention", async () => {
    const { a, b } = await twoVaults(BODY);
    const report = taskId(a.note(), "Write report");
    await a.pass(indent(a.note(), "Write report"));
    await drag(b, "Write report", "Call Anna");
    await reconnect(a, b);
    for (const v of [a, b]) {
      expect(active(v, report)).toBe(true);
      expect(placementConflict(v, report)).toBe(true);
      expect(count(v.note(), "Write report")).toBe(1);
    }
  });

  it("one moves it from another copy of the section, the other drags it: both need attention", async () => {
    const { a, b } = await twoVaults(BODY);
    const before = a.note();
    const anna = taskId(before, "Call Anna");
    await a.pass(before, {}, "Copy.md");
    const ids = new Set([anna]);
    await a.pass(cut(before, "Call Anna"), { deletedIds: ids, cut: ids });
    await a.pass(a.note("Copy.md"), {}, "Copy.md");
    await a.pass(
      paste(before, a.note("Copy.md"), "Call Anna", "Buy milk", "\t"),
      { cut: ids },
      "Copy.md",
    );
    await drag(b, "Call Anna", "Write report");
    await reconnect(a, b, ["Plan.md", "Copy.md"]);
    expect(active(a, anna) && active(b, anna)).toBe(true);
    expect(placementConflict(a, anna) && placementConflict(b, anna)).toBe(true);
    expect(count(a.note("Copy.md"), "Call Anna")).toBe(1);
  });

  // A move concurrent with the Task's deletion is retained the way a
  // concurrent title edit is (mvp-0.2-baseline.8, EDIT_UNDER_DELETED_ANCESTOR),
  // so the mover's note does not lose the Task with nothing to review.
  it("one Tabs it while the other deletes it: the mover is asked, as for an edit", async () => {
    const { a, b } = await twoVaults(BODY);
    const report = taskId(a.note(), "Write report");
    await a.pass(indent(a.note(), "Write report"));
    const ids = new Set([report, taskId(b.note(), "Draft")]);
    await b.pass(cut(b.note(), "Write report"), { deletedIds: ids });
    await reconnect(a, b);
    expect(a.replica().tree().retainedConcurrentEdits).toContain(report);
  });

  // mvp-0.2-baseline.9: a fresh deletion after the move ends the attention,
  // for every member.
  it("the mover keeps it deleted: gone from both notes, nothing left to review", async () => {
    const { a, b } = await twoVaults(BODY);
    const report = taskId(a.note(), "Write report");
    await a.pass(indent(a.note(), "Write report"));
    const ids = new Set([report, taskId(b.note(), "Draft")]);
    await b.pass(cut(b.note(), "Write report"), { deletedIds: ids });
    await reconnect(a, b);
    const item = a.recovery().find((i) => i.kind === "retained" && i.nodeId === report);
    if (item === undefined) throw new Error("the move is not offered for review");
    expect((await a.choose(item, { keep: false })).applied).toBe(true);
    await reconnect(a, b);
    for (const v of [a, b]) {
      expect(v.replica().tree().retainedConcurrentEdits).toEqual([]);
      expect(v.recovery()).toEqual([]);
      expect(v.model()?.nodes[report]?.lifecycle).toBe("deleted");
      expect(count(v.note(), "Write report")).toBe(0);
    }
  });
});
