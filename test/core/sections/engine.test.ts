// LFCP-02-039..043: one pass of a note's sections through the engine,
// against the fake SDK port with a model (mock evidence: the SDK binding
// replaces the fake). Seeding (MS11), local batches with bindings, remote
// projection, both at once, a crash between commit and bindings, transient
// input, deletion versus a lost binding, and access.

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

const note = (body: string[], title = "Launch") =>
  [
    "Private intro.",
    `## ${title}`,
    formatBoundary("start", S),
    ...body,
    formatBoundary("end", S),
    "Private outro.",
    "",
  ].join("\n");

const BODY = [
  formatNodeMarker("paragraph", P),
  "Draft",
  "",
  formatNodeMarker("paragraph", Q),
  "Notes",
];

const stateOf = (md: string) => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return markdownState(md, s).state;
};

const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

function setup(initial = note(BODY)) {
  const port = new FakeSectionPort();
  port.host(R, SID, stateOf(initial));
  const journal = new MemorySectionJournalStore();
  const bases = new MemorySectionBaseStore();
  let nodeId = 100;
  let op = 0;
  let projection = 0;
  const engine = new SectionEngine({
    port,
    journal,
    bases,
    newNodeId: () => id(nodeId++),
    newOperationId: () => `op-${++op}`,
    createdBy: "me",
    newProjectionId: () => `projection-${++projection}`,
    tasks: () => undefined,
    newTask: (line, taskId) => ({
      id: taskId,
      title: line.replace(/^[ \t]*[-*+][ \t]+\[.\][ \t]*/, "").trim(),
    }),
  });
  /** A pass on `md`, written as the host would; returns the pass and the note after it. */
  const run = async (md: string, ctx: PassContext = CTX) => {
    const pass = await engine.pass(PATH, md, ctx);
    const out = applyChanges(md, pass.changes);
    await engine.written(pass, out);
    return { pass, out };
  };
  return { port, journal, bases, engine, run, model: () => port.sections.get(R)?.state };
}

/** Set up and seed the base with a first pass on the model's own note. */
async function seeded(initial = note(BODY)) {
  const h = setup(initial);
  const { pass, out } = await h.run(initial);
  expect(pass.sections[0]?.base).toBeDefined();
  expect(out).toBe(initial);
  return h;
}

describe("seeding (MS11)", () => {
  it("a note that shows the model seeds the base and changes nothing", async () => {
    const h = await seeded();
    expect(h.port.changes).toEqual([]);
    expect(await h.bases.projectionsOf(PATH)).toEqual(["projection-1"]);
  });

  it("without a base, a note that differs from the model publishes nothing", async () => {
    const h = setup();
    const { pass, out } = await h.run(note(BODY).replace("Draft", "Draft edited"));
    expect(pass.sections[0]?.skipped).toBe("base-unknown");
    expect(h.port.changes).toEqual([]);
    expect(out).toContain("Draft edited");
  });
});

describe("local edits", () => {
  it("a Text edit, a new paragraph and a new Task go out as one batch, with their bindings", async () => {
    const h = await seeded();
    const typed = note([
      ...BODY.slice(0, 2),
      "",
      "New para",
      "",
      "- [ ] Call Anna",
      "",
      ...BODY.slice(3),
    ]).replace("Draft", "Draft v2");
    const { pass, out } = await h.run(typed);
    expect(h.port.changes).toHaveLength(1);
    expect(h.port.changes[0]?.intents.map((i) => i.intent)).toEqual([
      "paragraph.create",
      "task.create_in_section",
      "text.edit",
    ]);
    expect(out).toContain(`${formatNodeMarker("paragraph", id(100))}\nNew para`);
    expect(out).toContain(`- [ ] Call Anna\n  <!-- lfcp-ref: lfcp1:${R}#task:${id(101)} -->`);
    expect(h.model()?.nodes[P]?.text).toBe("Draft v2");
    expect(pass.sections[0]?.local?.kind).toBe("committed");
    // Done: the journal is finished, and a second pass has nothing to do.
    expect(await h.journal.unfinished()).toEqual([]);
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toHaveLength(1);
  });

  it("an empty new Task on the caret's line waits, then binds once the caret leaves", async () => {
    const h = await seeded();
    const typed = note([...BODY, "", "- [ ] "]);
    const caret = typed.split("\n").indexOf("- [ ] ");
    const first = await h.run(typed, { ...CTX, caretLine: caret });
    expect(h.port.changes).toEqual([]);
    expect(first.out).toBe(typed);
    const titled = typed.replace("- [ ] \n", "- [ ] Later\n");
    await h.run(titled, { ...CTX, caretLine: null });
    expect(h.port.changes[0]?.intents.map((i) => i.intent)).toEqual(["task.create_in_section"]);
  });

  it("a node removed with its binding by the user is deleted; one that only lost its marker is not", async () => {
    const h = await seeded();
    const withoutQ = note(BODY.slice(0, 2));
    // An external edit removed it: NODE_BINDING_LOST, nothing deleted.
    const lost = await h.run(withoutQ);
    expect(lost.pass.sections[0]?.lost).toEqual([Q]);
    expect(h.port.changes).toEqual([]);
    // The user's transaction removed it with its marker: node.delete.
    await h.run(withoutQ, { ...CTX, deletedIds: new Set([Q]) });
    expect(h.port.changes[0]?.intents).toEqual([{ intent: "node.delete", id: Q }]);
    expect(h.model()?.nodes[Q]).toBeUndefined();
  });

  it("read-only access keeps the edit local: no batch, no change to the note", async () => {
    const h = await seeded();
    h.port.access = { allowed: false, reason: "read-only" };
    const typed = note(BODY).replace("Notes", "Notes!");
    const { pass, out } = await h.run(typed);
    expect(pass.sections[0]?.local).toMatchObject({
      kind: "kept",
      candidate: { reason: "read-only" },
    });
    expect(out).toBe(typed);
    expect(h.port.changes).toEqual([]);
  });
});

describe("remote changes", () => {
  it("are projected into the note, and a second pass is empty", async () => {
    const h = await seeded();
    h.port.remote(R, (s) => {
      s.state = {
        ...s.state,
        nodes: {
          ...s.state.nodes,
          [Q]: { kind: "paragraph", parent: null, text: "Notes from Bob" },
        },
      };
    });
    const { out } = await h.run(note(BODY));
    expect(out).toBe(note(BODY).replace("Notes", "Notes from Bob"));
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
  });

  it("with local edits in the same pass: the local ones are committed, the remote ones projected", async () => {
    const h = await seeded();
    h.port.remote(R, (s) => {
      s.state = {
        ...s.state,
        nodes: {
          ...s.state.nodes,
          [Q]: { kind: "paragraph", parent: null, text: "Notes from Bob" },
        },
      };
    });
    const typed = note(BODY).replace("Draft", "Draft (mine)");
    const { out } = await h.run(typed);
    expect(h.port.changes[0]?.intents).toMatchObject([{ intent: "text.edit", id: P }]);
    expect(out).toBe(typed.replace("Notes", "Notes from Bob"));
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toHaveLength(1);
  });
});

describe("a crash between the commit and the bindings", () => {
  it("projects the IDs already allocated on the next pass: one Task, never two", async () => {
    const h = await seeded();
    const typed = note([...BODY, "", "- [ ] Call Anna"]);
    // The pass commits, but its changes are never written (the process stops).
    const lostPass = await h.engine.pass(PATH, typed, CTX);
    expect(lostPass.changes).not.toEqual([]);
    h.engine.abandoned(lostPass);
    expect(h.port.changes).toHaveLength(1);
    // Next pass, on the same note: the existing ID is written, no new batch.
    const { out } = await h.run(typed);
    expect(h.port.changes).toHaveLength(1);
    expect(out).toContain(`<!-- lfcp-ref: lfcp1:${R}#task:${id(100)} -->`);
    expect(await h.journal.unfinished()).toEqual([]);
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toHaveLength(1);
  });
});
