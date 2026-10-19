// LFCP-03-055 (obsidian#57): a deletion made while a section is suspended by a
// lost binding is kept until the section resumes, then sent; it never becomes
// a lost binding itself. Covers the user's deletion and a resumed batch's node
// whose line is gone (vanished), each in the pass that also finds a lost binding.

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { createTask, SharedObjectsReplica } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { MemorySectionBaseStore, markdownState } from "../../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import { FakeSectionPort } from "./fake-port";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const SID = id(1);
const S = parseSectionRef(`lfcp1:${R}#section:${SID}`) as SectionRef;
const PATH = "Launch.md";
const P = id(2);
const Q = id(3);
const X = id(4);
const T = id(5);
const REF = (t: string) => `  <!-- lfcp-ref: lfcp1:${R}#task:${t} -->`;
const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

const note = (body: string[]) =>
  ["Intro.", "## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join(
    "\n",
  );

const BEFORE = note([
  formatNodeMarker("paragraph", P),
  "Draft",
  "",
  formatNodeMarker("paragraph", Q),
  "Notes",
  "",
  formatNodeMarker("paragraph", X),
  "Old",
  "",
  "- [ ] Contract",
  REF(T),
]);

/**
 * The user's edit, in one pass: Draft retitled, Old deleted, a new Task,
 * and Contract moved (cut and pasted) to the top.
 */
const EDITED = note([
  "- [ ] Contract",
  REF(T),
  "",
  formatNodeMarker("paragraph", P),
  "Draft v2",
  "",
  formatNodeMarker("paragraph", Q),
  "Notes",
  "",
  "- [ ] Call Anna",
]);
const EDIT_CTX: PassContext = {
  caretLine: null,
  deletedIds: new Set([X]),
  origin: "other",
  inserted: new Set([T]),
};

const stateOf = (md: string) => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return markdownState(md, s);
};

function vault() {
  const port = new FakeSectionPort();
  port.host(R, SID, stateOf(BEFORE).state);
  const journal = new MemorySectionJournalStore();
  const bases = new MemorySectionBaseStore();
  let nodeId = 100;
  let op = 0;
  let projection = 0;
  // The section's Tasks: Contract, and each Task a batch created (a base
  // lost in the stop seeds again only on a note that shows them, LFCP-03-043).
  const me = principalId(new Uint8Array(32).fill(4));
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: me,
  });
  replica.apply(createTask({ id: T as never, title: "Contract", createdBy: me }).intent);
  const tasks = (_r: string, taskId: string) => {
    if (replica.task(taskId) === undefined)
      for (const c of port.changes)
        for (const i of c.intents)
          if (i.intent === "task.create_in_section" && i.task.id === taskId)
            replica.apply(createTask({ ...i.task, id: taskId as never, createdBy: me }).intent);
    return { view: replica.task(taskId) };
  };
  /** A new engine on the same stores: the vault (re)started. */
  const start = () =>
    new SectionEngine({
      port,
      journal,
      bases,
      newNodeId: () => id(nodeId++),
      newOperationId: () => `op-${++op}`,
      createdBy: principalId(new Uint8Array(32).fill(4)),
      newProjectionId: () => `projection-${++projection}`,
      tasks,
      newTask: (line, taskId) => ({
        id: taskId,
        title: line.replace(/^[ \t]*[-*+][ \t]+\[.\][ \t]*/, "").trim(),
      }),
    });
  /** A pass written as the host writes it; the note on disk follows. */
  const run = async (engine: SectionEngine, md: string, ctx: PassContext = CTX) => {
    const pass = await engine.pass(PATH, md, ctx);
    const out = applyChanges(md, pass.changes);
    disk = out;
    await engine.written(pass, out);
    return { pass, out };
  };
  let disk = BEFORE;
  return {
    port,
    journal,
    bases,
    start,
    run,
    disk: () => disk,
    setDisk: (md: string) => {
      disk = md;
    },
  };
}

const NO_Q = (md: string) => md.replace(`${formatNodeMarker("paragraph", Q)}\nNotes\n\n`, "");
const NO_X = (md: string) => md.replace(`${formatNodeMarker("paragraph", X)}\nOld\n\n`, "");

describe("a deletion while the section is suspended (LFCP-03-055)", () => {
  it("the user's deletion in a pass that finds a lost binding is not a lost binding later", async () => {
    const v = vault();
    const first = v.start();
    await v.run(first, BEFORE);
    // Notes loses its binding (no hint) and Old is deleted (hinted) in one pass.
    const suspended = NO_X(NO_Q(BEFORE));
    const a = (await v.run(first, suspended, { ...CTX, deletedIds: new Set([X]) })).pass;
    expect(a.sections[0]?.lost).toEqual([Q]);
    expect(v.port.changes).toHaveLength(0);
    // Later passes carry no hint (here a restart too): only Notes is lost.
    const second = v.start();
    const b = (await v.run(second, suspended)).pass;
    expect(b.sections[0]?.lost).toEqual([Q]);
    expect(v.port.changes).toHaveLength(0);
    // Notes is back: the deletion goes out, nothing is lost.
    const restored = NO_X(BEFORE);
    const c = (await v.run(second, restored)).pass;
    expect(c.sections[0]?.lost).toEqual([]);
    expect(v.port.changes).toHaveLength(1);
    const model = v.port.sections.get(R)?.state;
    expect(model?.nodes[X]).toBeUndefined();
    expect(model?.nodes[Q]?.text).toBe("Notes");
    expect((await v.bases.load("projection-1"))?.deleted).toBeUndefined();
    const d = (await v.run(second, restored)).pass;
    expect(d.sections[0]?.lost).toEqual([]);
    expect(d.changes).toEqual([]);
    expect(v.port.changes).toHaveLength(1);
  });

  it("a deletion made on a later suspended pass is kept as well", async () => {
    const v = vault();
    const engine = v.start();
    await v.run(engine, BEFORE);
    const noQ = NO_Q(BEFORE);
    expect((await v.run(engine, noQ)).pass.sections[0]?.lost).toEqual([Q]);
    const both = NO_X(noQ);
    const b = (await v.run(engine, both, { ...CTX, deletedIds: new Set([X]) })).pass;
    expect(b.sections[0]?.lost).toEqual([Q]);
    expect((await v.run(engine, both)).pass.sections[0]?.lost).toEqual([Q]);
    expect((await v.run(engine, NO_X(BEFORE))).pass.sections[0]?.lost).toEqual([]);
    expect(v.port.sections.get(R)?.state.nodes[X]).toBeUndefined();
  });

  it("a node of a resumed batch whose line is gone (vanished) in a pass with a lost binding", async () => {
    const v = vault();
    const first = v.start();
    await v.run(first, BEFORE);
    // A new Task typed; its batch commits, the note is not written.
    const typed = BEFORE.replace("- [ ] Contract", "- [ ] Call Anna\n\n- [ ] Contract");
    await first.pass(PATH, typed, CTX);
    expect(v.port.changes).toHaveLength(1);
    // After the restart: Anna's line is gone, and so is Notes' binding.
    const engine = v.start();
    const gone = NO_Q(BEFORE);
    const a = (await v.run(engine, gone)).pass;
    expect(a.sections[0]?.lost).toEqual([Q]);
    const b = (await v.run(engine, gone)).pass;
    expect(b.sections[0]?.lost).toEqual([Q]);
    // Notes is back: Anna is deleted, nothing is lost.
    const c = (await v.run(engine, BEFORE)).pass;
    expect(c.sections[0]?.lost).toEqual([]);
    const model = v.port.sections.get(R)?.state;
    const created = Object.keys(model?.nodes ?? {}).filter((n) => ![P, Q, X, T].includes(n));
    expect(created.filter((n) => model?.nodes[n] !== undefined)).toEqual([]);
    expect((await v.run(engine, BEFORE)).pass.changes).toEqual([]);
  });

  it("a node deleted while suspended and back in the note before the repair is kept", async () => {
    const v = vault();
    const engine = v.start();
    await v.run(engine, BEFORE);
    const suspended = NO_X(NO_Q(BEFORE));
    const a = (await v.run(engine, suspended, { ...CTX, deletedIds: new Set([X]) })).pass;
    expect(a.sections[0]?.lost).toEqual([Q]);
    expect((await v.bases.load("projection-1"))?.deleted).toEqual([X]);
    // Old is back (undone) while Notes is still lost, then Notes is repaired.
    expect((await v.run(engine, NO_Q(BEFORE))).pass.sections[0]?.lost).toEqual([Q]);
    const c = (await v.run(engine, BEFORE)).pass;
    expect(c.sections[0]?.lost).toEqual([]);
    expect(v.port.changes).toHaveLength(0);
    expect(v.port.sections.get(R)?.state.nodes[X]?.text).toBe("Old");
    expect((await v.bases.load("projection-1"))?.deleted).toBeUndefined();
  });
});
