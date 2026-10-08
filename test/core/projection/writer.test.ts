// LFCP-062 gate matrix: echo, guard and G-EP7 regression, and the round trip
// LFCP-061 → SDK → LFCP-062 → LFCP-061 producing zero intents for every
// fixture of cases.json, LF and CRLF.

import { readFileSync } from "node:fs";
import {
  generateObjectId,
  type ObjectId,
  type principalId,
  type ResourceId,
  toBase64url,
} from "@openlfcp/core";
import {
  complete,
  createTask,
  deleteTask,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@openlfcp/shared-objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { ProjectionEngine } from "../../../src/core/projection/engine";
import { MutationGuard } from "../../../src/core/projection/guard";
import { type NoteIO, ProjectionWriter } from "../../../src/core/projection/writer";
import { Device, FakeLocal } from "../../support/lfcp-env";

interface Case {
  readonly name: string;
  readonly shared: {
    readonly title: string;
    readonly status?: TaskStatus;
    readonly due?: string;
    readonly scheduled?: string;
    readonly priority?: TaskPriority;
    readonly completion_date?: string;
    readonly tags?: readonly string[];
  };
  readonly markdown: string;
}
const CASES = JSON.parse(
  readFileSync(new URL("../../fixtures/projection/cases.json", import.meta.url), "utf8"),
) as Case[];

const URL_ = "wss://offline.example.invalid/v1/ws";
let runtime: LfcpRuntime;
let R: ResourceId;
let me: ReturnType<typeof principalId>;
beforeAll(async () => {
  runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  R = await runtime.createResource({ name: "W", endpoints: [URL_], coordinatorUrl: URL_ });
  const s = runtime.status;
  if (s.kind !== "ready") throw new Error("not ready");
  me = s.principalId;
});
afterAll(async () => {
  await runtime.stop();
});

/** A vault in memory: writes are counted; editing marks a note as unsaved in an editor. */
class FakeVault implements NoteIO {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  readonly editing = new Set<string>();
  /** Content an editor changes between the writer's read and its write. */
  sneak: { path: string; content: string } | null = null;
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async rewrite(path: string, fn: (data: string) => string) {
    if (this.sneak?.path === path) {
      this.files.set(path, this.sneak.content);
      this.sneak = null;
    }
    const next = fn(this.files.get(path) ?? "");
    if (next !== this.files.get(path)) this.writes.push(path);
    this.files.set(path, next);
  }
  isBeingEdited(path: string) {
    return this.editing.has(path);
  }
}

function setup() {
  const guard = new MutationGuard();
  const engine = new ProjectionEngine(() => runtime, guard);
  const vault = new FakeVault();
  const writer = new ProjectionWriter(engine, guard, vault, () => runtime);
  return { guard, engine, vault, writer };
}
const refOf = (id: string) => `lfcp1:${toBase64url(R)}#task:${id}`;
const keyOf = (id: string) => `${toBase64url(R)}#${id}`;
const task = async (id: string) => (await runtime.profileOf(R)).replica.task(id)?.task as Task;

async function shared(fields: Case["shared"]): Promise<ObjectId> {
  const id = generateObjectId();
  const { status, completion_date, ...rest } = fields;
  await runtime.writeIntent(
    R,
    createTask({
      id,
      createdBy: me,
      ...rest,
      ...(status === undefined || status === "done" ? {} : { status }),
    }).intent,
  );
  if (status === "done")
    await runtime.writeIntent(R, complete(await task(id), completion_date).intent);
  return id;
}

const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const intentsOf = (o: { projection?: { sent: readonly unknown[] } }) =>
  o.projection?.sent.length ?? 0;

describe("round trip 061 → SDK → 062 → 061 is quiet (item 9)", () => {
  for (const c of CASES)
    for (const [eol, convert] of [
      ["LF", (s: string) => s],
      ["CRLF", crlf],
    ] as const)
      it(`${c.name} (${eol})`, async () => {
        const { vault, writer, engine } = setup();
        const id = await shared(c.shared);
        vault.files.set("n.md", convert(c.markdown.replaceAll("{{ref}}", refOf(id))));
        await writer.syncNote("n.md"); // the user's edit is sent, then rendered
        const rendered = vault.files.get("n.md") as string;
        expect(rendered.includes("\r\n")).toBe(eol === "CRLF");
        // The write's own vault event is an echo, and a second identical event sends nothing.
        for (let i = 0; i < 2; i++) {
          const again = await writer.handleChanges([{ kind: "modify", path: "n.md" }]);
          expect(again.map(intentsOf)).toEqual([0]);
          expect(again.map((o) => o.wrote)).toEqual([false]);
        }
        // A fresh engine (no guard, as after a restart) reads the rendered note: zero intents.
        const fresh = await new ProjectionEngine(() => runtime, new MutationGuard()).processFile(
          "n.md",
          rendered,
        );
        expect(fresh.sent).toEqual([]);
        void engine;
      });
});

describe("ProjectionWriter (LFCP-062)", () => {
  it("updates every projection of an object across notes, and leaves private text exact", async () => {
    const { vault, writer } = setup();
    const id = await shared({ title: "Shared" });
    const unit = `- [ ] Shared\n  <!-- lfcp-ref: ${refOf(id)} -->\n`;
    vault.files.set("Dashboard.md", `# Dash\n\nPrivate.\n\n${unit}\nMore private.`);
    vault.files.set("Today.md", `- [ ] Shared <!-- lfcp-ref: ${refOf(id)} -->`);
    await writer.handleChanges([
      { kind: "create", path: "Dashboard.md" },
      { kind: "create", path: "Today.md" },
    ]);
    expect(vault.writes).toEqual([]);
    // The user completes it in Today.md: sent, then rendered into Dashboard.md too.
    vault.files.set("Today.md", `- [x] Shared <!-- lfcp-ref: ${refOf(id)} -->`);
    await writer.handleChanges([{ kind: "modify", path: "Today.md" }]);
    expect((await task(id)).status).toBe("done");
    await writer.objectsChanged(new Set([keyOf(id)]));
    expect(vault.files.get("Dashboard.md")).toBe(
      `# Dash\n\nPrivate.\n\n- [x] Shared\n  <!-- lfcp-ref: ${refOf(id)} -->\n\nMore private.`,
    );
    expect(vault.writes).toEqual(["Dashboard.md"]);
  });

  it("never writes a note open with unsaved changes; the next save renders it", async () => {
    const { vault, writer } = setup();
    const id = await shared({ title: "Busy" });
    vault.files.set("b.md", `- [ ] Busy\n  <!-- lfcp-ref: ${refOf(id)} -->\n`);
    await writer.syncNote("b.md");
    await runtime.writeIntent(R, complete(await task(id)).intent);
    vault.editing.add("b.md");
    expect(await writer.objectsChanged(new Set([keyOf(id)]))).toMatchObject([
      { deferred: "editing", wrote: false },
    ]);
    expect(vault.writes).toEqual([]);
    vault.editing.delete("b.md"); // saved
    expect(await writer.handleChanges([{ kind: "modify", path: "b.md" }])).toMatchObject([
      { wrote: true },
    ]);
    expect(vault.files.get("b.md")).toContain("- [x] Busy");
  });

  it("abandons a write when the note changed after it was read, and keeps the user's text", async () => {
    const { vault, writer } = setup();
    const id = await shared({ title: "Race" });
    vault.files.set("r.md", `- [ ] Race\n  <!-- lfcp-ref: ${refOf(id)} -->\n`);
    await writer.syncNote("r.md");
    await runtime.writeIntent(R, complete(await task(id)).intent);
    const typed = `- [ ] Race typed\n  <!-- lfcp-ref: ${refOf(id)} -->\n`;
    vault.sneak = { path: "r.md", content: typed };
    expect(await writer.objectsChanged(new Set([keyOf(id)]))).toMatchObject([
      { deferred: "changed" },
    ]);
    expect(vault.files.get("r.md")).toBe(typed);
    // Its save: the typed title is sent, the remote completion rendered.
    await writer.handleChanges([{ kind: "modify", path: "r.md" }]);
    expect(await task(id)).toMatchObject({ title: "Race typed", status: "done" });
    expect(vault.files.get("r.md")).toBe(`- [x] Race typed\n  <!-- lfcp-ref: ${refOf(id)} -->\n`);
  });

  it("leaves deleted objects, unknown Resources and moved notes alone", async () => {
    const { vault, writer, engine } = setup();
    const id = await shared({ title: "Gone" });
    await runtime.writeIntent(R, deleteTask(await task(id)).intent);
    const unknown =
      "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f40ad";
    const note = `- [ ] Old title\n  <!-- lfcp-ref: ${refOf(id)} -->\n- [x] Elsewhere <!-- lfcp-ref: ${unknown} -->\n`;
    vault.files.set("d.md", note);
    const out = await writer.syncNote("d.md");
    expect(out.wrote).toBe(false);
    expect(out.rendered.flatMap((p) => p.issues.map((i) => i.code))).toEqual(["OBJECT_DELETED"]);
    expect(vault.files.get("d.md")).toBe(note);
    vault.files.set("e.md", note);
    vault.files.delete("d.md");
    await writer.handleChanges([{ kind: "rename", path: "e.md", oldPath: "d.md" }]);
    expect(engine.pathsOf(keyOf(id))).toEqual(["e.md"]);
    expect(vault.writes).toEqual([]);
  });
  it("projects a G-EP7 regression faithfully with no echo intents and reports it (item 3)", async () => {
    // Its own Resource: excluding this client's own unit leaves the replica unable
    // to write again (§9, fail-closed in the SDK), which must not affect other tests.
    const own = await runtime.createResource({
      name: "G",
      endpoints: [URL_],
      coordinatorUrl: URL_,
    });
    const { vault, writer } = setup();
    const id = generateObjectId();
    await runtime.writeIntent(own, createTask({ id, title: "Cut", createdBy: me }).intent);
    const refOf = (x: string) => `lfcp1:${toBase64url(own)}#task:${x}`;
    const keyOf = (x: string) => `${toBase64url(own)}#${x}`;
    const task = async (x: string) => (await runtime.profileOf(own)).replica.task(x)?.task as Task;
    vault.files.set("g.md", `- [ ] Cut\n  <!-- lfcp-ref: ${refOf(id)} -->\n`);
    await writer.syncNote("g.md");
    // Completed (a local write), rendered into the note.
    const unit = await runtime.writeIntent(own, complete(await task(id), "2026-10-05").intent);
    await writer.objectsChanged(new Set([keyOf(id)]));
    expect(vault.files.get("g.md")).toBe(
      `- [x] Cut ✅ 2026-10-05\n  <!-- lfcp-ref: ${refOf(id)} -->\n`,
    );
    const profile = await runtime.profileOf(own);
    // A Key Epoch cutoff excludes the completion: the profile rebuilds without it.
    const regressed = new Set<string>();
    const off = runtime.onObjectChanged((_r, c) => {
      if (c.origin === "rebuild") regressed.add(keyOf(c.objectId));
    });
    profile.exclude([unit as never]);
    off();
    expect((await task(id)).status).toBe("todo");
    const out = await writer.objectsChanged(new Set([keyOf(id)]), regressed);
    expect(out[0]?.rendered[0]?.issues.map((i) => i.code)).toEqual(["STATE_REGRESSED"]);
    expect(vault.files.get("g.md")).toBe(`- [ ] Cut\n  <!-- lfcp-ref: ${refOf(id)} -->\n`);
    const echo = await writer.handleChanges([{ kind: "modify", path: "g.md" }]);
    expect(echo.map(intentsOf)).toEqual([0]);
    expect((await task(id)).status).toBe("todo");
  });
});

describe("a pass compares the note with the shared state it was read against (0.3.2)", () => {
  /**
   * The runtime as projection host, renaming `target` to `title` the
   * `at`-th time the pass looks up a Resource: a remote change landing in
   * the middle of a pass, after the note was read.
   */
  function midPass(target: ObjectId, title: string, at: number) {
    let calls = 0;
    return {
      hasResource: async (r: typeof R) => {
        if (++calls === at)
          await runtime.writeIntent(R, { intent: "task.set_title", id: target, title });
        return runtime.hasResource(r);
      },
      supportsResource: (r: typeof R) => runtime.supportsResource(r),
      profileOf: (r: typeof R) => runtime.profileOf(r),
      writeIntent: (r: typeof R, i: Parameters<LfcpRuntime["writeIntent"]>[1]) =>
        runtime.writeIntent(r, i),
    };
  }

  it("a change landing mid-pass, with no base yet, is not sent back (the revert race)", async () => {
    const a = await shared({ title: "Alpha" });
    const b = await shared({ title: "Beta" });
    const note = `- [ ] Alpha\n  <!-- lfcp-ref: ${refOf(a)} -->\n- [ ] Beta\n  <!-- lfcp-ref: ${refOf(b)} -->\n`;
    const guard = new MutationGuard();
    const host = midPass(b, "Beta, renamed by a peer", 3);
    const engine = new ProjectionEngine(() => host, guard); // no bases: first sight
    const vault = new FakeVault();
    vault.files.set("race.md", note);
    const writer = new ProjectionWriter(engine, guard, vault, () => host);
    const out = await writer.syncNote("race.md");
    expect(out.projection?.sent).toEqual([]);
    expect((await task(b)).title).toBe("Beta, renamed by a peer");
    // The next pass (the change's own render) shows it.
    await writer.objectsChanged(new Set([keyOf(b)]));
    expect(vault.files.get("race.md")).toContain("- [ ] Beta, renamed by a peer\n");
    expect((await task(b)).title).toBe("Beta, renamed by a peer");
  });

  it("without a snapshot the same pass would revert it (the engine's live reading, kept for callers that have none)", async () => {
    const b = await shared({ title: "Gamma" });
    const note = `- [ ] Gamma\n  <!-- lfcp-ref: ${refOf(b)} -->\n`;
    await runtime.writeIntent(R, { intent: "task.set_title", id: b, title: "Gamma, renamed" });
    const engine = new ProjectionEngine(() => runtime, new MutationGuard());
    const stale = await engine.processFile("stale.md", note);
    expect(stale.sent.map((s) => s.intent)).toEqual([
      { intent: "task.set_title", id: b, title: "Gamma" },
    ]);
  });

  it("a snapshot equal to the note sends nothing, whatever the state is now", async () => {
    const b = await shared({ title: "Delta" });
    const note = `- [ ] Delta\n  <!-- lfcp-ref: ${refOf(b)} -->\n`;
    const snapshot = new Map([[keyOf(b), (await runtime.profileOf(R)).replica.task(b)]]);
    await runtime.writeIntent(R, { intent: "task.set_title", id: b, title: "Delta, renamed" });
    const engine = new ProjectionEngine(() => runtime, new MutationGuard());
    const out = await engine.processFile("snap.md", note, snapshot);
    expect(out.sent).toEqual([]);
    expect((await task(b)).title).toBe("Delta, renamed");
  });
});
