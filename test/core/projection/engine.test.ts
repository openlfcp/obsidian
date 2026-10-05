// LFCP-061: Markdown Task → Shared Object projection through the real SDK
// path (runtime.writeIntent: intent → Automerge change → queued Data Unit).

import { readFileSync } from "node:fs";
import {
  generateObjectId,
  type ObjectId,
  principalId,
  type ResourceId,
  toBase64url,
} from "@openlfcp/core";
import {
  complete,
  createTask,
  type ReplicaIntent,
  SharedObjectsReplica,
  setTitle,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskView,
} from "@openlfcp/shared-objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { ProjectionEngine } from "../../../src/core/projection/engine";
import { MutationGuard } from "../../../src/core/projection/guard";
import { planIntents } from "../../../src/core/projection/intents";
import { applyRepair } from "../../../src/core/projection/reassociation";
import { parseTaskText } from "../../../src/core/projection/task-text";
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
  readonly intents: readonly Record<string, unknown>[];
  readonly diagnostics: readonly string[];
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
  R = await runtime.createResource({ name: "Projection", endpoints: [URL_], coordinatorUrl: URL_ });
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error("not ready");
  me = status.principalId;
});
afterAll(async () => {
  await runtime.stop();
});

const refOf = (id: string) => `lfcp1:${toBase64url(R)}#task:${id}`;
const task = async (id: string): Promise<Task> =>
  (await runtime.profileOf(R)).replica.task(id)?.task as Task;
const view = async (id: string): Promise<TaskView | undefined> =>
  (await runtime.profileOf(R)).replica.task(id);

/** A new shared Task with these fields, written through the SDK like any local change. */
async function shared(
  fields: Case["shared"],
  extra: Record<string, unknown> = {},
): Promise<ObjectId> {
  const id = generateObjectId();
  const { status, completion_date, ...rest } = fields;
  const created = createTask({
    id,
    createdBy: me,
    ...rest,
    ...(status === undefined || status === "done" ? {} : { status }),
  });
  await runtime.writeIntent(R, {
    intent: "task.create",
    task: { ...created.task, ...extra } as Task,
  });
  if (status === "done")
    await runtime.writeIntent(R, complete(await task(id), completion_date).intent);
  return id;
}

const engine = () => new ProjectionEngine(() => runtime, new MutationGuard());
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const sentIntents = (o: { sent: readonly { intent: ReplicaIntent }[] }) =>
  o.sent.map((s) => s.intent);
const codes = (o: { diagnostics: readonly { code: string }[] }) =>
  [...new Set(o.diagnostics.map((d) => d.code))].sort();

describe("projection fixtures (cases.json), LF and CRLF", () => {
  for (const c of CASES)
    for (const [eol, convert] of [
      ["LF", (s: string) => s],
      ["CRLF", crlf],
    ] as const)
      it(`${c.name} (${eol})`, async () => {
        const id = await shared(c.shared);
        const outbound = (await runtime.storage?.outbound.list(R))?.length ?? 0;
        const out = await engine().processFile(
          "note.md",
          convert(c.markdown.replaceAll("{{ref}}", refOf(id))),
        );
        expect(sentIntents(out)).toMatchObject(c.intents);
        expect(sentIntents(out)).toHaveLength(c.intents.length);
        expect(codes(out)).toEqual([...new Set(c.diagnostics)].sort());
        // Every sent intent is one queued Data Unit (item 12).
        expect((await runtime.storage?.outbound.list(R))?.length).toBe(outbound + c.intents.length);
        // The object now matches the Markdown: a second pass sends nothing.
        const again = await engine().processFile(
          "note.md",
          convert(c.markdown.replaceAll("{{ref}}", refOf(id))),
        );
        expect(sentIntents(again)).toEqual([]);
      });
});

describe("projection engine (LFCP-061)", () => {
  it("gives the same intents for inline and child placements", async () => {
    const a = await shared({ title: "Same" });
    const b = await shared({ title: "Same" });
    const child = await engine().processFile(
      "a.md",
      `- [x] Renamed 📅 2026-10-10\n  <!-- lfcp-ref: ${refOf(a)} -->\n`,
    );
    const inline = await engine().processFile(
      "b.md",
      `- [x] Renamed 📅 2026-10-10 <!-- lfcp-ref: ${refOf(b)} -->\n`,
    );
    const strip = (o: typeof child) => sentIntents(o).map((i) => ({ ...i, id: undefined }));
    expect(strip(child)).toEqual(strip(inline));
    expect(strip(child).map((i) => i.intent)).toEqual([
      "task.set_title",
      "task.complete",
      "task.set_due",
    ]);
  });

  it("never resolves a conflicted field from Markdown (item 8)", async () => {
    const id = await shared({ title: "Base" });
    const profile = await runtime.profileOf(R);
    // A collaborator renamed it concurrently with a local rename.
    const other = SharedObjectsReplica.fromChanges(profile.replica.changes(), {
      resource: R,
      principal: principalId(new Uint8Array(32).fill(9)),
    }).replica;
    const theirs = other.apply(setTitle(other.task(id)?.task as Task, "Theirs").intent);
    await runtime.writeIntent(R, setTitle(await task(id), "Mine").intent);
    profile.replica.receiveChange(theirs?.change as Uint8Array);
    const v = await view(id);
    expect(v?.fields.title.conflicted).toBe(true);
    const visible = String(v?.fields.title.value);
    for (const title of [visible, "Mine", "Theirs", "Something else"]) {
      const out = await engine().processFile(
        "c.md",
        `- [ ] ${title}\n  <!-- lfcp-ref: ${refOf(id)} -->\n`,
      );
      expect(sentIntents(out), title).toEqual([]);
      expect(codes(out), title).toEqual(["FIELD_CONFLICTED"]);
    }
    // Other fields are still edited.
    const out = await engine().processFile(
      "c.md",
      `- [x] ${visible}\n  <!-- lfcp-ref: ${refOf(id)} -->\n`,
    );
    expect(sentIntents(out).map((i) => i.intent)).toEqual(["task.complete"]);
    expect((await view(id))?.fields.title.conflicted).toBe(true);
  });

  it("skips objects that are not valid Tasks (item 10)", () => {
    const invalid = {
      id: "x",
      status: "profile_invalid",
      problems: [
        {
          code: "PROFILE_INVALID",
          diagnostic: "INVALID_FIELD_TYPE",
          pointer: "/title",
          message: "",
        },
      ],
      task: undefined,
    } as unknown as TaskView;
    const plan = planIntents({ status: "done", text: parseTaskText("Renamed") }, invalid);
    expect(plan.intents).toEqual([]);
    expect(plan.issues.map((i) => i.code)).toEqual(["OBJECT_PROFILE_INVALID"]);
    const collision = { ...invalid, status: "object_id_collision" } as TaskView;
    expect(
      planIntents({ status: "done", text: parseTaskText("x") }, collision).issues.map(
        (i) => i.code,
      ),
    ).toEqual(["OBJECT_ID_COLLISION"]);
  });

  it("skips the plugin's own writes by path and content hash, not by time (item 9)", async () => {
    const id = await shared({ title: "Guarded" });
    const guard = new MutationGuard();
    const e = new ProjectionEngine(() => runtime, guard);
    const written = `- [ ] Guarded\n  <!-- lfcp-ref: ${refOf(id)} -->\n`;
    guard.expect("g.md", written);
    expect(await e.processFile("g.md", written)).toMatchObject({ skipped: "echo", sent: [] });
    expect(guard.pending).toBe(0);
    expect(e.indexed("g.md")).toEqual([`${toBase64url(R)}#${id}`]); // the echo reindexes
    // A repeated event with the same content is not an edit either.
    expect(sentIntents(await e.processFile("g.md", written))).toEqual([]);
    // An expectation for other content does not hide a user edit.
    guard.expect("g.md", "something else");
    expect(sentIntents(await e.processFile("g.md", written.replace("[ ]", "[x]")))).toMatchObject([
      { intent: "task.complete" },
    ]);
  });

  it("treats several projections as one object: one edit sends, two different edits do not", async () => {
    const id = await shared({ title: "Twice" });
    const unit = (t: string) => `- [ ] ${t}\n  <!-- lfcp-ref: ${refOf(id)} -->\n`;
    const one = await engine().processFile("m.md", `${unit("Twice")}\n${unit("Twice edited")}`);
    expect(sentIntents(one)).toMatchObject([{ intent: "task.set_title", title: "Twice edited" }]);
    const two = await engine().processFile("m.md", `${unit("A")}\n${unit("B")}`);
    expect(sentIntents(two)).toEqual([]);
    expect(codes(two)).toEqual(["PROJECTIONS_DISAGREE"]);
  });

  it("moves and renames change nothing shared; a lost ref is a local detachment (tests 13, 16)", async () => {
    const id = await shared({ title: "Movable" });
    const e = engine();
    const unit = `- [ ] Movable\n  <!-- lfcp-ref: ${refOf(id)} -->\n`;
    const outbound = (await runtime.storage?.outbound.list(R))?.length;
    expect(sentIntents(await e.processFile("a.md", unit))).toEqual([]);
    expect(sentIntents(await e.processFile("a.md", `# Moved down\n\n${unit}`))).toEqual([]);
    const renamed = await e.handleChanges(
      [{ kind: "rename", path: "b.md", oldPath: "a.md" }],
      async () => unit,
    );
    expect(renamed.flatMap(sentIntents)).toEqual([]);
    expect(e.indexed("b.md")).toEqual([`${toBase64url(R)}#${id}`]);
    const detached = await e.processFile("b.md", "- [ ] Movable\n");
    expect(codes(detached)).toEqual(["PROJECTION_DETACHED"]);
    expect((await task(id)).lifecycle).toBe("active");
    expect((await runtime.storage?.outbound.list(R))?.length).toBe(outbound);
  });

  it("processes edits made outside the editor through vault changes (test 15)", async () => {
    const id = await shared({ title: "External" });
    const files = new Map([["ext.md", `- [x] External\n  <!-- lfcp-ref: ${refOf(id)} -->\n`]]);
    const out = await engine().handleChanges(
      [{ kind: "modify", path: "ext.md" }],
      async (p) => files.get(p) ?? null,
    );
    expect(out.flatMap(sentIntents)).toMatchObject([{ intent: "task.complete" }]);
  });

  it("keeps unknown fields and extensions across a title edit (tests 10, 11)", async () => {
    const id = await shared(
      { title: "Rich" },
      {
        x_future_field: "kept",
        extensions: { "com.example.tracker": { ticket: "ABC-42" } },
      },
    );
    await engine().processFile(
      "r.md",
      `- [ ] Rich and renamed\n  <!-- lfcp-ref: ${refOf(id)} -->\n`,
    );
    expect(await task(id)).toMatchObject({
      title: "Rich and renamed",
      x_future_field: "kept",
      extensions: { "com.example.tracker": { ticket: "ABC-42" } },
    });
  });

  it("local Tasks never reach the SDK (test 1)", async () => {
    const outbound = (await runtime.storage?.outbound.list(R))?.length;
    const out = await engine().processFile("l.md", "- [ ] Buy milk\n- [x] Call mum\n");
    expect(out).toMatchObject({ sent: [], diagnostics: [] });
    expect((await runtime.storage?.outbound.list(R))?.length).toBe(outbound);
  });

  it("a Resource not on this device sends nothing", async () => {
    const other =
      "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f40ad";
    const out = await engine().processFile("u.md", `- [ ] X <!-- lfcp-ref: ${other} -->\n`);
    expect(codes(out)).toEqual(["RESOURCE_UNKNOWN"]);
  });

  it("offers a repair for a re-associated ref, which binds it back (ST-2), LF and CRLF", async () => {
    const id = await shared({ title: "Prepare API contract" });
    for (const convert of [(s: string) => s, crlf]) {
      const text = convert(
        `- [ ] Prepare API contract\n- [ ] Call Bob\n  <!-- lfcp-ref: ${refOf(id)} -->`,
      );
      const out = await engine().processFile("s.md", text);
      const d = out.diagnostics.find((x) => x.code === "REF_REASSOCIATION_SUSPECTED");
      expect(d?.repair).toEqual({ kind: "move-ref", from: 2, after: 0 });
      const repaired = applyRepair(text, d?.repair as never);
      expect(repaired).toBe(
        convert(`- [ ] Prepare API contract\n  <!-- lfcp-ref: ${refOf(id)} -->\n- [ ] Call Bob`),
      );
      const after = await engine().processFile("s.md", repaired);
      expect(after).toMatchObject({ sent: [], diagnostics: [] });
    }
  });
});
