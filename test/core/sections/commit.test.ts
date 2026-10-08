// LFCP-02-039: local section edits committed through the journal exactly
// once, against a fake of the SDK port (mock evidence; the real SDK
// replaces it with LFCP-02-012..016). Crashes before the commit, after it
// and after the source write; SI02 and SI17.

import { describe, expect, it } from "vitest";
import type { SectionPlan, UnboundNode } from "../../../src/core/sections/base";
import {
  applyBatch,
  type CommitDeps,
  commitPass,
  finish,
  type LocalPass,
  localStatus,
  markProjected,
  resumeOperation,
} from "../../../src/core/sections/commit";
import {
  diagnosticView,
  type JournalEntry,
  MemorySectionJournalStore,
} from "../../../src/core/sections/journal";
import { FakeSectionPort } from "./fake-port";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const EMPTY: SectionPlan = { textEdits: [], moves: [], missing: [], kindMismatch: [] };

function deps(port = new FakeSectionPort(), journal = new MemorySectionJournalStore()) {
  let node = 100;
  let op = 0;
  const d: CommitDeps = {
    port,
    journal,
    newNodeId: () => id(node++),
    newOperationId: () => `op-${++op}`,
  };
  return { d, port, journal };
}

const paragraph = (line: number, after: string | null, text: string): UnboundNode => ({
  kind: "paragraph",
  parent: null,
  after,
  text,
  line,
});
const task = (line: number, after: string | null): UnboundNode => ({
  kind: "task",
  parent: null,
  after,
  line,
});

const SECTION = id(1);
const ME = "principal-me";
const pass = (over: Partial<LocalPass> = {}): LocalPass => ({
  projectionId: "p-1",
  resource: R,
  sectionId: SECTION,
  createdBy: ME,
  sourceHash: "h0",
  sourceText: "## Launch\n- [ ] Contract\n",
  baseRevision: "heads-0",
  plan: EMPTY,
  newTask: (_c, taskId) => ({ id: taskId, title: "Contract", status: "todo" }),
  ...over,
});

/** A journal whose process "dies" when it would record the commit. */
class CrashOnCommitted extends MemorySectionJournalStore {
  armed = true;
  override async put(entry: JournalEntry): Promise<void> {
    if (this.armed && entry.phase === "committed") {
      this.armed = false;
      throw new Error("process stopped");
    }
    return super.put(entry);
  }
}

describe("one pass, one durable batch", () => {
  it("allocates IDs before the commit and sends the whole pass as one batch", async () => {
    const { d, port, journal } = deps();
    const out = await commitPass(
      d,
      pass({
        plan: {
          ...EMPTY,
          title: "Launch plan",
          textEdits: [{ nodeId: id(5), edit: { index: 0, deleteCount: 0, insert: "New " } }],
          moves: [{ nodeId: id(6), parent: null, after: id(5) }],
        },
        creations: [paragraph(7, id(5), "First"), paragraph(9, id(5), "Second"), task(11, id(6))],
        deletes: [id(8)],
        restores: [id(4)],
      }),
    );
    expect(out.kind).toBe("committed");
    if (out.kind !== "committed") return;
    expect(out.ids).toEqual({ 7: id(100), 9: id(101), 11: id(102) });
    expect(port.changes).toHaveLength(1);
    expect(port.changes[0]?.intents).toEqual([
      { intent: "section.set_title", title: "Launch plan" },
      {
        intent: "paragraph.create",
        id: id(100),
        parent: SECTION,
        after: id(5),
        text: "First",
        createdBy: ME,
      },
      // Consecutive new nodes follow each other, not the same bound sibling.
      {
        intent: "paragraph.create",
        id: id(101),
        parent: SECTION,
        after: id(100),
        text: "Second",
        createdBy: ME,
      },
      {
        intent: "task.create_in_section",
        task: { id: id(102), title: "Contract", status: "todo" },
        parent: SECTION,
        after: id(6),
      },
      { intent: "node.restore", id: id(4) },
      {
        intent: "text.edit",
        id: id(5),
        edits: [{ index: 0, deleteCount: 0, insert: "New " }],
        base: "heads-0",
      },
      { intent: "node.move", id: id(6), parent: SECTION, after: id(5) },
      { intent: "node.delete", id: id(8) },
    ]);
    expect(out.receipt.modelRevision).toBe("heads-1");
    expect((await journal.get("op-1"))?.phase).toBe("committed");
    expect(localStatus(out)).toBe("SAVED_LOCAL");
  });

  it("sends nothing for an empty pass", async () => {
    const { d, port } = deps();
    expect(await commitPass(d, pass())).toEqual({ kind: "nothing" });
    expect(port.changes).toEqual([]);
  });
});

describe("crashes and retries: one Task, never two", () => {
  it("SI17: a failed save keeps the edit local and unsaved; the retry sends the same batch once", async () => {
    const { d, port, journal } = deps();
    port.fail({ kind: "storage-error" });
    const out = await commitPass(d, pass({ creations: [task(3, null)] }));
    expect(out.kind).toBe("save-failed");
    expect(localStatus(out)).toBe("LOCAL_SAVE_FAILED");
    const [entry] = await journal.unfinished();
    expect(localStatus(entry as JournalEntry)).toBe("LOCAL_EDIT"); // SI02
    expect(port.changes).toEqual([]);

    const again = await resumeOperation(d, entry as JournalEntry);
    expect(again.kind).toBe("project");
    if (again.kind !== "project") return;
    expect(again.ids).toEqual({ 3: id(100) });
    expect(port.changes).toHaveLength(1);
    expect(port.changes[0]?.operationId).toBe("op-1");
  });

  it("a crash before the commit: the restart asks for the receipt, finds none and submits the same IDs", async () => {
    const { d, port, journal } = deps();
    port.fail({ kind: "crash-before" });
    await commitPass(d, pass({ creations: [task(3, null)] }));
    const [entry] = await journal.unfinished();
    expect(entry?.phase).toBe("ids-allocated");
    const resumed = await resumeOperation(d, entry as JournalEntry);
    expect(resumed.kind).toBe("project");
    expect(port.changes).toHaveLength(1);
    expect(port.changes[0]?.intents[0]).toMatchObject({ task: { id: id(100) } });
  });

  it("a crash after the commit, before the journal knew: the restart projects the existing IDs", async () => {
    const journal = new CrashOnCommitted();
    const { d, port } = deps(new FakeSectionPort(), journal);
    await expect(commitPass(d, pass({ creations: [task(3, null)] }))).rejects.toThrow(
      "process stopped",
    );
    expect(port.changes).toHaveLength(1);
    const [entry] = await journal.unfinished();
    expect(entry?.phase).toBe("ids-allocated");
    const resumed = await resumeOperation(d, entry as JournalEntry);
    expect(resumed).toMatchObject({ kind: "project", ids: { 3: id(100) } });
    // A broad retry of the same operation returns the receipt; no second change, no second Task.
    await port.commit(R, entry?.intents ?? [], { operationId: "op-1" });
    expect(port.changes).toHaveLength(1);
  });

  it("an error after a durable commit is settled by the receipt, in the same pass", async () => {
    const { d, port } = deps();
    port.fail({ kind: "crash-after" });
    const out = await commitPass(d, pass({ creations: [task(3, null)] }));
    expect(out.kind).toBe("committed");
    expect(port.changes).toHaveLength(1);
  });

  it("a crash after the source write: the markers are not written again with new IDs", async () => {
    const { d, port, journal } = deps();
    const out = await commitPass(d, pass({ creations: [task(3, null)] }));
    if (out.kind !== "committed") throw new Error(out.kind);
    // Restart before "projected": project the same IDs.
    const r1 = await resumeOperation(d, out.entry);
    expect(r1).toMatchObject({ kind: "project", ids: { 3: id(100) } });
    const projected = await markProjected(d, out.entry, "h1");
    // Restart before "done": finish when the source still has the patched hash.
    expect(await resumeOperation(d, projected)).toMatchObject({
      kind: "finish",
      patchedHash: "h1",
    });
    const done = await finish(d, projected);
    expect(done.phase).toBe("done");
    expect(port.released).toEqual(["op-1"]);
    expect(await journal.unfinished()).toEqual([]);
    expect(port.changes).toHaveLength(1);
  });

  it("the SDK refuses the same operation ID with a different batch", async () => {
    const { d, port } = deps();
    await commitPass(d, pass({ creations: [task(3, null)] }));
    await expect(
      port.commit(R, [{ intent: "node.delete", id: id(1) }], { operationId: "op-1" }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
  });
});

describe("edits that may not be sent stay local candidates", () => {
  it("read-only or revoked: no journal entry, no change, the source kept with why", async () => {
    for (const [reason, kept] of [
      ["read-only", "read-only"],
      ["revoked", "access-revoked"],
    ] as const) {
      const { d, port, journal } = deps();
      port.access = { allowed: false, reason };
      const out = await commitPass(d, pass({ creations: [task(3, null)] }));
      expect(out).toMatchObject({ kind: "kept", candidate: { reason: kept } });
      expect(port.changes).toEqual([]);
      expect(await journal.unfinished()).toEqual([]);
      const [c] = await journal.candidates("p-1");
      expect(c?.sourceText).toBe("## Launch\n- [ ] Contract\n");
      expect(JSON.stringify(diagnosticView(c as never))).not.toContain("Contract");
    }
  });

  it("refusals: stale base, importing, access lost on the way, a profile code", async () => {
    const cases = [
      ["STALE_BASE", { kind: "stale" }],
      ["SECTION_IMPORTING", { kind: "importing" }],
      ["NOT_WRITABLE", { kind: "kept", candidate: { reason: "read-only" } }],
      ["PARENT_CYCLE", { kind: "kept", candidate: { reason: "rejected" } }],
    ] as const;
    for (const [code, expected] of cases) {
      const { d, port, journal } = deps();
      port.fail({ kind: "refuse", code });
      const out = await commitPass(
        d,
        pass({ plan: { ...EMPTY, moves: [{ nodeId: id(6), parent: id(6), after: null }] } }),
      );
      expect(out).toMatchObject(expected);
      expect(port.changes).toEqual([]);
      expect((await journal.get("op-1"))?.phase).toBe("abandoned");
    }
  });
});

describe("applyBatch: the base a committed batch leads to", () => {
  it("applies title, creations after their sibling, Text edits, moves and deletions", () => {
    const base = {
      title: "Launch",
      nodes: {
        [id(5)]: { kind: "paragraph" as const, parent: null, text: "Draft" },
        [id(6)]: { kind: "item" as const, parent: null, text: "Item" },
        [id(8)]: { kind: "paragraph" as const, parent: null, text: "Gone" },
      },
      order: { "": [id(5), id(6), id(8)] },
    };
    const out = applyBatch(
      base,
      [
        { intent: "section.set_title", title: "Launch plan" },
        {
          intent: "paragraph.create",
          id: id(100),
          parent: SECTION,
          after: id(5),
          text: "New",
          createdBy: ME,
        },
        {
          intent: "task.create_in_section",
          task: { id: id(101), title: "Call" },
          parent: id(6),
          after: null,
        },
        {
          intent: "text.edit",
          id: id(5),
          edits: [{ index: 5, deleteCount: 0, insert: " v2" }],
          base: "h",
        },
        { intent: "node.move", id: id(6), parent: SECTION, after: null },
        { intent: "node.delete", id: id(8) },
      ],
      SECTION,
      (taskId) => (taskId === id(101) ? "- [ ] Call" : undefined),
    );
    expect(out).toEqual({
      title: "Launch plan",
      nodes: {
        [id(5)]: { kind: "paragraph", parent: null, text: "Draft v2" },
        [id(6)]: { kind: "item", parent: null, text: "Item" },
        [id(100)]: { kind: "paragraph", parent: null, text: "New" },
        [id(101)]: { kind: "task", parent: id(6), line: "- [ ] Call" },
      },
      order: { "": [id(6), id(5), id(100)], [id(6)]: [id(101)] },
    });
  });
});
