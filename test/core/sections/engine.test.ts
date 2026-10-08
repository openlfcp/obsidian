// LFCP-02-039..043: one pass of a note's sections through the engine,
// against the fake SDK port with a model (mock evidence: the SDK binding
// replaces the fake). Seeding (MS11), local batches with bindings, remote
// projection, both at once, a crash between commit and bindings, transient
// input, deletion versus a lost binding, and access.

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { complete, createTask, SharedObjectsReplica, type Task } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { MemorySectionBaseStore, markdownState } from "../../../src/core/sections/base";
import {
  applyChanges,
  type EngineDeps,
  type PassContext,
  SectionEngine,
} from "../../../src/core/sections/engine";
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

function setup(
  initial = note(BODY),
  tasks: EngineDeps["tasks"] = () => undefined,
  extra: Partial<EngineDeps> = {},
) {
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
    createdBy: principalId(new Uint8Array(32).fill(4)),
    newProjectionId: () => `projection-${++projection}`,
    tasks,
    ...extra,
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
async function seeded(initial = note(BODY), tasks?: EngineDeps["tasks"]) {
  const h = setup(initial, tasks);
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

describe("Task fields inside a section", () => {
  const T = id(9);
  const REF = `  <!-- lfcp-ref: lfcp1:${R}#task:${T} -->`;
  const withTask = (line: string) => note([line, REF, "", ...BODY]);
  const me = principalId(new Uint8Array(32).fill(4));

  function tasks() {
    const { replica } = SharedObjectsReplica.create({
      resource: resourceId(fromBase64url(R)),
      principal: me,
    });
    replica.apply(createTask({ id: T as never, title: "Contract", createdBy: me }).intent);
    return replica;
  }

  it("ticking a Task's checkbox sends task.complete, and the note keeps it", async () => {
    const replica = tasks();
    const h = await seeded(withTask("- [ ] Contract"), (_r, taskId) =>
      taskId === T ? { view: replica.task(T) } : undefined,
    );
    h.port.onTaskIntents = (intents) => {
      for (const i of intents) replica.apply(i as never);
    };
    const ticked = withTask("- [x] Contract");
    const { out } = await h.run(ticked);
    expect(h.port.changes[0]?.intents.map((i) => i.intent)).toContain("task.complete");
    expect(replica.task(T)?.task?.status).toBe("done");
    expect(out).toBe(ticked);
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toHaveLength(1);
  });

  it("a collaborator's completion is rendered onto the line, and sends nothing back", async () => {
    const replica = tasks();
    const h = await seeded(withTask("- [ ] Contract"), (_r, taskId) =>
      taskId === T ? { view: replica.task(T) } : undefined,
    );
    replica.apply(complete(replica.task(T)?.task as Task).intent);
    h.port.remote(R, () => {});
    const { out } = await h.run(withTask("- [ ] Contract"));
    expect(out).toBe(withTask("- [x] Contract"));
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toEqual([]);
  });
});

describe("nodes a collaborator created or moved", () => {
  it("a paragraph and a Task added remotely appear in the note; nothing goes back", async () => {
    const T = id(20);
    const N = id(21);
    const me = principalId(new Uint8Array(32).fill(4));
    const { replica } = SharedObjectsReplica.create({
      resource: resourceId(fromBase64url(R)),
      principal: me,
    });
    replica.apply(createTask({ id: T as never, title: "Call Anna", createdBy: me }).intent);
    const h = await seeded(note(BODY), (_r, taskId) =>
      taskId === T ? { view: replica.task(T) } : undefined,
    );
    h.port.remote(R, (s) => {
      s.state = {
        ...s.state,
        nodes: {
          ...s.state.nodes,
          [N]: { kind: "paragraph", parent: null, text: "From Bob" },
          [T]: { kind: "task", parent: null },
        },
        order: { ...s.state.order, "": [P, N, Q, T] },
      };
    });
    const { out } = await h.run(note(BODY));
    expect(out).toBe(
      note([
        ...BODY.slice(0, 2),
        "",
        formatNodeMarker("paragraph", N),
        "From Bob",
        "",
        ...BODY.slice(3),
        "",
        "- [ ] Call Anna",
        `  <!-- lfcp-ref: lfcp1:${R}#task:${T} -->`,
      ]),
    );
    expect(h.port.changes).toEqual([]);
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toEqual([]);
  });

  it("a node moved remotely moves in the note", async () => {
    const h = await seeded();
    h.port.remote(R, (s) => {
      s.state = { ...s.state, order: { ...s.state.order, "": [Q, P] } };
    });
    const { out } = await h.run(note(BODY));
    expect(out).toBe(note([...BODY.slice(3), "", ...BODY.slice(0, 2)]));
    const again = await h.run(out);
    expect(again.pass.changes).toEqual([]);
    expect(h.port.changes).toEqual([]);
  });
});

describe("MS45 in a pass: the canonical inline form", () => {
  const T = id(30);
  const REF = `<!-- lfcp-ref: lfcp1:${R}#task:${T} -->`;
  const late = `- [ ] Water plants 🔁 every week 📅 2026-10-08 ${REF}`;
  const canonical = `- [ ] Water plants ${REF} 🔁 every week 📅 2026-10-08`;

  it("moves an idle line's ref before its Tasks fields; nothing is published", async () => {
    const h = await seeded(note([late, "", ...BODY]));
    // Seeding only records the base; the next pass moves the ref, and the one after is empty.
    const { out } = await h.run(note([late, "", ...BODY]));
    expect(out).toBe(note([canonical, "", ...BODY]));
    expect(h.port.changes).toEqual([]);
    expect((await h.run(out)).pass.changes).toEqual([]);
  });

  it("leaves the line under the caret", async () => {
    const h = setup(note([late, "", ...BODY]));
    const md = note([late, "", ...BODY]);
    const caretLine = md.split("\n").indexOf(late);
    await h.run(md, { ...CTX, caretLine });
    const { out } = await h.run(md, { ...CTX, caretLine });
    expect(out).toBe(md);
  });
});

describe("comments under the section comments setting (§4.5)", () => {
  it("a comment kept local stays local after the switch to shared; a new one becomes a raw node", async () => {
    let setting: "local" | "shared" = "local";
    const withOld = note([...BODY, "", "%% kept local %%"]);
    const h = setup(withOld, undefined, { sectionComments: () => setting });
    await h.run(withOld);
    setting = "shared";
    const withNew = note([...BODY, "", "%% kept local %%", "", "%% now shared %%"]);
    const { out } = await h.run(withNew);
    expect(h.port.changes).toHaveLength(1);
    expect(h.port.changes[0]?.intents).toMatchObject([
      { intent: "raw.create", text: "%% now shared %%" },
    ]);
    expect(out).toContain(
      `%% kept local %%\n\n${formatNodeMarker("raw", id(100))}\n%% now shared %%`,
    );
    expect((await h.run(out)).pass.changes).toEqual([]);
  });
});

describe("a lost binding suspends the section (§7, MS18, MS21)", () => {
  it("publishes nothing, not even other edits, until the binding is repaired", async () => {
    const h = await seeded();
    // Q's marker removed by an external edit, and P edited: nothing goes out.
    const edited = note([BODY[0] as string, "Draft v2", "", "Notes"]);
    const { pass } = await h.run(edited);
    expect(pass.sections[0]?.lost).toEqual([Q]);
    expect(h.port.changes).toEqual([]);
  });
});
