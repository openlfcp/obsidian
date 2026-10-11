// Moving a Task by cut and paste (MARKDOWN-SECTIONS-01 §10, rules.ts
// pasteDecision), on the real section replica: two vaults offline, each
// with the engine and the port as the host wires them. In the editor a cut
// and its paste are separate passes (the scheduler waits 400 ms of quiet),
// so the cut is committed as a node.delete before the paste is seen. The
// paste of this session's cut is a move: the Task is restored and placed
// where it was pasted, in one batch. Found in the owner's two-vault check of
// 0.4.0-beta.1 (row 6): the pasted Task stayed deleted in the model, the
// other vault's move then lost it, and both badges were green.

import type { Receipt } from "@openlfcp/client";
import { type PrincipalId, principalId, resourceId, toBase64url } from "@openlfcp/core";
import { type SectionIntent as SdkIntent, SectionReplica } from "@openlfcp/shared-objects/sections";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
import { describe, expect, it } from "vitest";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { MemorySectionBaseStore } from "../../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { newSectionTask } from "../../../src/core/sections/task-fields";

const RID = resourceId(new Uint8Array(32).fill(7));
const R = toBase64url(RID);
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const SID = id(1);
const S = parseSectionRef(`lfcp1:${R}#section:${SID}`) as SectionRef;
const A_ME = principalId(new Uint8Array(32).fill(4));
const B_ME = principalId(new Uint8Array(32).fill(5));
// The engine of the first vault allocates IDs from 100: the three Tasks, then the paragraph.
const MILK = id(100);
const REPORT = id(101);
const MOVED = id(102);

/** One vault: its replica, the port over it, and the engine as sections-host wires it. */
function vault(name: string, replica: SectionReplica, me: PrincipalId) {
  let unit = 0;
  const port = new SdkSectionPort({
    profile: () => ({ replica }) as never,
    commit: async (_r, intents, o): Promise<Receipt> => {
      const change = replica.commit(intents as readonly SdkIntent[]);
      return {
        operationId: o.operationId,
        unitIds: [new Uint8Array(32).fill(++unit)] as never,
        affectedNodeIds: change?.affectedNodeIds ?? [],
        modelRevision: replica.revision(),
        intentsHash: `${name}-${unit}`,
        durable: true,
      };
    },
    storage: new InMemoryLfcpStorage(),
    canWrite: async () => ({ allowed: true, reason: null, controlHead: null, verifiedAt: null }),
  });
  let node = 100;
  let op = 0;
  const engine = new SectionEngine({
    port,
    journal: new MemorySectionJournalStore(),
    bases: new MemorySectionBaseStore(),
    newNodeId: () => id(node++),
    newOperationId: () => `${name}-op-${++op}`,
    createdBy: me,
    newProjectionId: () => `${name}-projection`,
    tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
    newTask: (line, taskId) => newSectionTask(line, me, taskId),
  });
  let note = "";
  /** One pass on `md`, written as the host writes it; the note is what it leaves. */
  const pass = async (md: string, ctx: Partial<PassContext> = {}) => {
    const p = await engine.pass("Plan.md", md, {
      caretLine: null,
      deletedIds: new Set(),
      origin: "other",
      ...ctx,
    });
    note = applyChanges(md, p.changes);
    await engine.written(p, note);
    return p.sections[0];
  };
  return {
    replica,
    pass,
    note: () => note,
    model: () => port.snapshot(R, SID),
  };
}

const lines = (md: string) => md.split("\n");
const count = (md: string, title: string) =>
  lines(md).filter((l) => l.includes(`[ ] ${title}`)).length;

/** The lines of the Task titled `title` with its ref (and nested lines). */
function block(md: string, title: string): [number, number] {
  const L = lines(md);
  const from = L.findIndex((l) => l.includes(`[ ] ${title}`));
  let to = from + 1;
  while (/^[ \t]/.test(L[to] ?? "")) to++;
  return [from, to];
}

/** `md` with the Task `title` (and its ref) cut. */
function cut(md: string, title: string): string {
  const L = lines(md);
  const [from, to] = block(md, title);
  return [...L.slice(0, from), ...L.slice(to)].join("\n");
}

/** `after` with the cut lines of `title` from `before` pasted under the Task `parent`, at `indent`. */
function paste(before: string, after: string, title: string, parent: string, indent = ""): string {
  const [from, to] = block(before, title);
  const pasted = lines(before)
    .slice(from, to)
    .map((l) => indent + l);
  const L = lines(after);
  const [, end] = block(after, parent);
  return [...L.slice(0, end), ...pasted, ...L.slice(end)].join("\n");
}

/** A in Obsidian: the cut, the paste and the Tab, each its own pass. */
async function moveInSteps(v: ReturnType<typeof vault>, title: string, parent: string) {
  const before = v.note();
  const removed = cut(before, title);
  const ids = new Set([MOVED]);
  await v.pass(removed, { deletedIds: ids, cut: ids });
  await v.pass(paste(before, removed, title, parent), { cut: ids });
  await v.pass(paste(before, removed, title, parent, "\t"), { cut: ids });
}

/** The same move as one edit (all within one pass). */
async function moveAtOnce(v: ReturnType<typeof vault>, title: string, parent: string) {
  const before = v.note();
  await v.pass(paste(before, cut(before, title), title, parent, "\t"));
}

/** Vault A with three Tasks and a paragraph shared, and vault B showing the same note. */
async function twoVaults() {
  const ra = SectionReplica.empty({ resource: RID, principal: A_ME });
  ra.commit([{ intent: "section.create", sectionId: SID, title: "Plan", createdBy: A_ME }]);
  const a = vault("A", ra, A_ME);
  const end = formatBoundary("end", S);
  const empty = ["Intro", "## Plan", formatBoundary("start", S), end, ""].join("\n");
  await a.pass(empty);
  const body = ["- [ ] Buy milk", "- [ ] Write report", "- [ ] Task from B", "", "A paragraph"];
  await a.pass(empty.replace(end, [...body, end].join("\n")));
  await a.pass(a.note());
  expect(a.model()?.nodes[MOVED]?.lifecycle).toBe("active");
  const rb = SectionReplica.empty({ resource: RID, principal: B_ME });
  rb.receiveChanges(ra.changes());
  const b = vault("B", rb, B_ME);
  await b.pass(a.note());
  expect(b.note()).toBe(a.note());
  return { a, b };
}

/** The network comes back: each replica receives the other's changes, then each note is passed twice. */
async function reconnect(a: ReturnType<typeof vault>, b: ReturnType<typeof vault>) {
  const fromA = a.replica.changes();
  a.replica.receiveChanges(b.replica.changes());
  b.replica.receiveChanges(fromA);
  for (const v of [a, b]) {
    await v.pass(v.note());
    await v.pass(v.note());
  }
}

const placementConflict = (v: ReturnType<typeof vault>) =>
  v.model()?.problems.some((p) => p.code === "PLACEMENT_CONFLICT" && p.nodeIds.includes(MOVED));

describe("moving a Task by cut and paste", () => {
  it("in one vault: the paste of the cut restores the Task where it was pasted", async () => {
    const { a } = await twoVaults();
    await moveInSteps(a, "Task from B", "Buy milk");
    expect(a.model()?.nodes[MOVED]).toMatchObject({ lifecycle: "active", parent: MILK });
    expect(count(a.note(), "Task from B")).toBe(1);
    expect(a.model()?.problems).toEqual([]);
  });

  it("the restored Task's later edits are shared", async () => {
    const { a } = await twoVaults();
    await moveInSteps(a, "Task from B", "Buy milk");
    await a.pass(a.note());
    await a.pass(a.note().replace("[ ] Task from B", "[ ] Task from B today"));
    expect(a.replica.task(MOVED)?.task?.title).toBe("Task from B today");
  });

  it("a cut without a paste stays a delete", async () => {
    const { a } = await twoVaults();
    const ids = new Set([MOVED]);
    await a.pass(cut(a.note(), "Task from B"), { deletedIds: ids, cut: ids });
    await a.pass(a.note(), { cut: ids });
    expect(a.model()?.nodes[MOVED]?.lifecycle).toBe("deleted");
  });

  it("a deleted Task back in the note without the cut: reported, nothing sent; restored when chosen", async () => {
    const { a } = await twoVaults();
    const before = a.note();
    const removed = cut(before, "Task from B");
    const ids = new Set([MOVED]);
    await a.pass(removed, { deletedIds: ids, cut: ids });
    // Pasted in another session (the cut is not this one's).
    const pasted = paste(before, removed, "Task from B", "Buy milk", "\t");
    const shown = await a.pass(pasted);
    expect(shown?.reappeared).toEqual([MOVED]);
    expect(a.model()?.nodes[MOVED]?.lifecycle).toBe("deleted");
    expect(count(a.note(), "Task from B")).toBe(1);
    // "Restore it where your note shows it".
    const restored = await a.pass(a.note(), { restore: ids });
    expect(restored?.reappeared).toBeUndefined();
    expect(a.model()?.nodes[MOVED]).toMatchObject({ lifecycle: "active", parent: MILK });
  });

  for (const [name, moveA, moveB] of [
    ["A in steps, B at once", moveInSteps, moveAtOnce],
    ["A at once, B in steps", moveAtOnce, moveInSteps],
    ["both in steps", moveInSteps, moveInSteps],
  ] as const)
    it(`under different parents offline (${name}): both keep the Task and need attention`, async () => {
      const { a, b } = await twoVaults();
      await moveA(a, "Task from B", "Buy milk");
      await moveB(b, "Task from B", "Write report");
      await reconnect(a, b);
      for (const v of [a, b]) {
        expect(v.model()?.nodes[MOVED]?.lifecycle).toBe("active");
        expect(placementConflict(v)).toBe(true);
        expect(count(v.note(), "Task from B")).toBe(1);
      }
      expect([MILK, REPORT]).toContain(a.model()?.nodes[MOVED]?.parent);
    });
});
