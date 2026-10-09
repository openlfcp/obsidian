// LFCP-02-053/054: importing 0.1 shared Tasks into a new shared section,
// an explicit copy (MVP-0.2-COMPATIBILITY-AND-MIGRATION §5–§10). The pure
// preflight on mock Task views (CM04, CM08, CM09, CM12, UX17), then the
// import on the plugin's runtime and the real SDK, offline: new identities,
// the source untouched, the note's refs replaced only with the section bound,
// a changed source note, a crash, cancel and a non-destructive rollback
// (CM05–CM07, CM13, CM14).

import { type ResourceId, toBase64url } from "@openlfcp/core";
import type { Task, TaskView } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { type CreationDeps, SectionCreation } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  type LegacySource,
  legacyPreflight,
  legacyStrip,
  missingChoices,
} from "../../../src/core/sections/legacy";
import { parseSections } from "../../../src/core/sections/parser";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const ID = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ref = (id: string, resource = R0) => `<!-- lfcp-ref: lfcp1:${resource}#task:${id} -->`;

/** A Task view as the SDK gives it, from a Task and the fields in conflict. */
function view(
  task: Omit<Partial<Task>, "id"> & { id: string },
  conflicts: Record<string, unknown[]> = {},
): TaskView {
  const full = {
    type: "task",
    lifecycle: "active",
    created_by: "p",
    title: "T",
    status: "todo",
    priority: "normal",
    tags: {},
    assignees: {},
    extensions: {},
    ...task,
  } as unknown as Task;
  const fields = Object.fromEntries(
    ["lifecycle", "title", "status", "due", "scheduled", "completion_date", "priority"].map((f) => [
      f,
      {
        value: (full as unknown as Record<string, unknown>)[f],
        values: conflicts[f] ?? [(full as unknown as Record<string, unknown>)[f]],
        conflicted: conflicts[f] !== undefined,
      },
    ]),
  );
  return {
    id: task.id,
    status: "ready",
    problems: [],
    task: full,
    fields,
    tags: [],
    assignees: Object.keys(full.assignees),
  } as unknown as TaskView;
}

describe("the import preflight (053)", () => {
  const note = (...body: string[]) => ["## Launch", ...body, ""].join("\n");
  const range = (md: string) => ({ headingLine: 0, lastLine: md.split("\n").length - 2 });

  it("CM04: lists the text entering the boundary; legacy Tasks keep their source", () => {
    const md = note(
      "- [ ] Prepare contract",
      `  ${ref(ID(1))}`,
      "  Private note about the contract",
    );
    const p = legacyPreflight(md, range(md), () => ({
      view: view({ id: ID(1), title: "Prepare contract" }),
      revision: "heads-1",
      pending: false,
    }));
    expect(p.tasks).toEqual([{ line: 1, resource: R0, objectId: ID(1) }]);
    expect(p.newlyShared).toEqual(["  Private note about the contract"]);
    expect(p.blocks).toEqual([]);
    expect(p.captured).toEqual({ [R0]: "heads-1" });
  });

  it("CM08: a source conflict asks for a value for the copy", () => {
    const md = note(`- [ ] Contract ${ref(ID(1))}`);
    const p = legacyPreflight(md, range(md), () => ({
      view: view({ id: ID(1) }, { due: ["2026-10-20", "2026-10-27"] }),
      revision: "h",
      pending: true,
    }));
    expect(p.choices).toEqual([
      { code: "CONFLICT", objectId: ID(1), field: "due", values: ["2026-10-20", "2026-10-27"] },
    ]);
    expect(p.pendingSources).toEqual([R0]);
    expect(missingChoices(p, {})).toHaveLength(1);
    expect(missingChoices(p, { values: { [ID(1)]: { due: "2026-10-27" } } })).toEqual([]);
  });

  it("CM09: an extension it cannot carry blocks; an unknown source blocks", () => {
    const md = note(`- [ ] A ${ref(ID(1))}`, `- [ ] B ${ref(ID(2))}`);
    const p = legacyPreflight(md, range(md), (_r, id) =>
      id === ID(1)
        ? {
            view: view({ id, extensions: { "x.example": { link: `lfcp1:${R0}#task:${ID(9)}` } } }),
            revision: "h",
            pending: false,
          }
        : undefined,
    );
    expect(p.blocks).toEqual([
      { code: "UNMAPPABLE_EXTENSION", line: 1, fields: ["extensions.x.example"] },
      { code: "UNKNOWN_SOURCE", line: 2 },
    ]);
  });

  it("CM12 and UX17: assignees are values, not access; a repeated Task needs a choice", () => {
    const md = note(`- [ ] A ${ref(ID(1))}`, "", `- [ ] A again ${ref(ID(1))}`);
    const p = legacyPreflight(md, range(md), () => ({
      view: view({ id: ID(1), assignees: { "principal:abc": true } as never }),
      revision: "h",
      pending: false,
    }));
    expect(p.assignees).toEqual([{ objectId: ID(1), refs: ["principal:abc"] }]);
    expect(p.choices).toEqual([{ code: "REPEATED", objectId: ID(1), lines: [1, 3] }]);
    expect(missingChoices(p, { copies: [ID(1)] })).toEqual([]);
  });

  it("CM13: strips child and inline refs, nothing else", () => {
    const md = note(
      "- [ ] Child",
      `  ${ref(ID(1))}`,
      `- [ ] Inline 📅 2026-10-20 ${ref(ID(2))}`,
      "",
      "A private paragraph.",
    );
    expect(applyChanges(md, legacyStrip(md, range(md)))).toBe(
      note("- [ ] Child", "- [ ] Inline 📅 2026-10-20", "", "A private paragraph."),
    );
  });
});

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

/** A vault with a 0.1 collaboration holding two shared Tasks, and a note that projects them. */
async function setup() {
  const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(r);
  const status = r.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const collab = new Collaboration(r, { sleep, connectTimeoutMs: 30 });
  const SERVER = "wss://offline.example.invalid/v1/ws";
  const { resourceId: L } = await collab.create({ name: "Team", server: SERVER });
  const share = async (line: string) => {
    const at = taskAt(line, 0);
    if (at.kind !== "local") throw new Error(at.kind);
    return (await collab.share(L, at.state)).objectId;
  };
  const a = await share("- [ ] Prepare contract 📅 2026-10-20");
  const b = await share("- [ ] Book venue");
  const l = toBase64url(L);
  const NOTE = [
    "PRIVATE_BEFORE: mine.",
    "",
    "## Launch",
    "- [ ] Prepare contract 📅 2026-10-20",
    `  ${ref(a, l)}`,
    "  Private note about the contract",
    `- [ ] Book venue ${ref(b, l)}`,
    "",
    "## Other",
    "",
  ].join("\n");
  const files = new Map([["Launch.md", NOTE]]);
  const port = new SdkSectionPort({
    profile: (res) => r.sectionProfile(res),
    commit: (res, intents, o) => r.commitSection(res, intents, o),
    storage: r.storage as LfcpStorage,
    canWrite: (res) => r.canWriteSection(res),
  });
  const fail = { edit: false };
  let n = 100;
  const deps: CreationDeps = {
    host: {
      createSectionResource: (o) => r.createSectionResource(o),
      openSection: (R) => r.openSection(R),
      host: async () => ({ kind: "pending", reason: "offline" }),
    },
    port,
    edit: async (path, fn) => {
      const current = files.get(path) as string;
      const changes = fn(current);
      if (changes === null) return;
      files.set(path, applyChanges(current, changes));
      if (fail.edit) throw new Error("crash after the note was written");
    },
    journal: r.localState,
    createdBy: status.principalId,
    server: () => SERVER,
    newResourceId: () => new Uint8Array(32).fill(++n % 255) as ResourceId,
    newNodeId: () => ID(++n),
    newOperationId: () => `import-${++n}`,
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  };
  const replica = (await r.profileOf(L)).replica;
  const source = (resource: string, objectId: string): LegacySource | undefined =>
    resource !== l
      ? undefined
      : (() => {
          const v = replica.task(objectId);
          return v === undefined ? undefined : { view: v, revision: "captured", pending: true };
        })();
  const range = { headingLine: 2, lastLine: 6 };
  return { r, L, a, b, files, NOTE, port, deps, source, range, fail, replica };
}

describe("the import (053, 054)", () => {
  it("copies into a new section: new IDs, the source untouched, the refs replaced with the binding", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepareImport("Launch.md", env.NOTE, env.range, env.source, {});
    expect((await creation.run(entry)).kind).toBe("local");
    const md = env.files.get("Launch.md") as string;
    // The legacy refs are gone; the section is bound; private text outside is untouched.
    expect(md).not.toContain(toBase64url(env.L));
    expect(md.startsWith("PRIVATE_BEFORE: mine.\n\n## Launch\n<!-- lfcp-section: ")).toBe(true);
    expect(md.endsWith("\n\n## Other\n")).toBe(true);
    const section = parseSections(md).sections[0];
    const taskIds = section?.nodes.filter((x) => x.kind === "task").map((x) => x.id) ?? [];
    expect(taskIds).toHaveLength(2);
    expect(taskIds).not.toContain(env.a);
    expect(entry.legacy?.mapping).toEqual({ [env.a]: [taskIds[0]], [env.b]: [taskIds[1]] });
    // The copy has the source's values.
    expect(env.port.taskView(entry.resource, taskIds[0] as string)?.task).toMatchObject({
      title: "Prepare contract",
      due: "2026-10-20",
    });
    // The child note entered the section as shared text.
    const snap = env.port.snapshot(entry.resource, entry.sectionId);
    expect(Object.values(snap?.nodes ?? {}).map((x) => x.text)).toContain(
      "Private note about the contract",
    );
    // The source collaboration is unchanged.
    expect(env.replica.task(env.a)?.task?.title).toBe("Prepare contract");
    expect(env.replica.task(env.b)?.task?.lifecycle).toBe("active");
  });

  it("CM06: the range changed during the import: the note is not replaced", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepareImport("Launch.md", env.NOTE, env.range, env.source, {});
    const edited = env.NOTE.replace("Private note about the contract", "Edited meanwhile");
    env.files.set("Launch.md", edited);
    expect((await creation.run(entry)).kind).toBe("stale");
    expect(env.files.get("Launch.md")).toBe(edited);
  });

  it("CM05, CM14: a crash after the note was written resumes with the same target; cancel keeps the note", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepareImport("Launch.md", env.NOTE, env.range, env.source, {});
    env.fail.edit = true;
    await expect(creation.run(entry)).rejects.toThrow("crash after the note was written");
    env.fail.edit = false;
    const [again] = await creation.unfinished();
    expect(again?.resource).toBe(entry.resource);
    expect((await creation.run(again ?? entry)).kind).toBe("local");
    expect(parseSections(env.files.get("Launch.md") as string).sections).toHaveLength(1);

    const other = await setup();
    const c2 = new SectionCreation(other.deps);
    const e2 = await c2.prepareImport("Launch.md", other.NOTE, other.range, other.source, {});
    const cancelled = await c2.cancel(e2);
    expect(cancelled.phase).toBe("cancelled");
    expect(other.files.get("Launch.md")).toBe(other.NOTE);
  });

  it("CM07: rollback restores the original view; after edits on the section it keeps both", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    let entry = await creation.prepareImport("Launch.md", env.NOTE, env.range, env.source, {});
    entry = (await creation.run(entry)).entry;
    const back = await creation.rollback(entry);
    expect(back.kind).toBe("restored");
    expect(env.files.get("Launch.md")).toBe(env.NOTE);

    const later = await setup();
    const c2 = new SectionCreation(later.deps);
    let e2 = await c2.prepareImport("Launch.md", later.NOTE, later.range, later.source, {});
    e2 = (await c2.run(e2)).entry;
    const withEdit = (later.files.get("Launch.md") as string).replace(
      "Private note about the contract",
      "Work on the new section",
    );
    later.files.set("Launch.md", withEdit);
    expect((await c2.rollback(e2)).kind).toBe("beside");
    const md = later.files.get("Launch.md") as string;
    expect(md).toContain("Work on the new section");
    expect(md).toContain(ref(later.a, toBase64url(later.L)));
    expect(parseSections(md).sections).toHaveLength(1);
  });

  it("refuses while the preflight blocks or a choice is missing", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    await expect(
      creation.prepareImport("Launch.md", env.NOTE, env.range, () => undefined, {}),
    ).rejects.toThrow("UNKNOWN_SOURCE");
  });
});
