// LFCP-063: the golden projection suite (test/fixtures/golden, format in its
// README), run through the real projection path: ProjectionWriter over a
// vault in memory, the LFCP runtime and the SDK. Every case runs with LF
// and with CRLF line endings; failures print a unified diff.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type DataUnitId, principalId, type ResourceId, toBase64url } from "@openlfcp/core";
import {
  addTag,
  cancel,
  clearDue,
  clearScheduled,
  complete,
  createTask,
  deleteTask,
  type ReplicaIntent,
  removeTag,
  reopen,
  SharedObjectsReplica,
  setDue,
  setPriority,
  setScheduled,
  setStatus,
  setTitle,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@openlfcp/shared-objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { ProjectionEngine } from "../../../src/core/projection/engine";
import { MutationGuard } from "../../../src/core/projection/guard";
import {
  type NoteIO,
  type NoteOutcome,
  ProjectionWriter,
} from "../../../src/core/projection/writer";
import { scanRefs } from "../../../src/core/refs";
import { unifiedDiff } from "../../support/diff";
import { Device, FakeLocal } from "../../support/lfcp-env";

type Fields = {
  readonly title?: string;
  readonly status?: TaskStatus;
  readonly due?: string | null;
  readonly scheduled?: string | null;
  readonly priority?: TaskPriority;
  readonly tags?: readonly string[];
  readonly completion_date?: string;
};
type GoldenEvent =
  | { type: "remote"; set?: Record<string, Fields>; delete?: string[]; then?: GoldenEvent }
  | { type: "edit"; file: string; then?: GoldenEvent }
  | { type: "move"; from: string; to: string; then?: GoldenEvent }
  | { type: "concurrent"; object: string; local: Fields; remote: Fields; then?: GoldenEvent }
  | { type: "withdraw"; object: string; applied: Fields; then?: GoldenEvent };
interface GoldenCase {
  readonly description: string;
  readonly objects: Record<string, Fields & { readonly id: string; readonly title: string }>;
  readonly event: GoldenEvent;
  readonly expect: {
    readonly intents?: readonly ({ object: string; intent: string } & Record<string, unknown>)[];
    readonly diagnostics?: readonly { file: string; code: string }[];
    readonly conflicts?: readonly { file: string; object: string; fields: string[] }[];
  };
  readonly alternatives?: Record<string, string[]>;
}

const DIR = new URL("../../fixtures/golden/", import.meta.url);
const CASES = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const read = (path: string): string => readFileSync(new URL(path, DIR), "utf8");
const notes = (name: string, part: string): Map<string, string> => {
  const dir = new URL(`${name}/${part}/`, DIR);
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).map((f) => [f, read(`${name}/${part}/${f}`)]));
};

class Vault implements NoteIO {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async rewrite(path: string, fn: (data: string) => string) {
    const next = fn(this.files.get(path) ?? "");
    if (next !== this.files.get(path)) this.writes.push(path);
    this.files.set(path, next);
  }
  isBeingEdited() {
    return false;
  }
}

const URL_ = "wss://offline.example.invalid/v1/ws";
let runtime: LfcpRuntime;
let me: ReturnType<typeof principalId>;
beforeAll(async () => {
  runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  const s = runtime.status;
  if (s.kind !== "ready") throw new Error("not ready");
  me = s.principalId;
});
afterAll(async () => {
  await runtime.stop();
});

/** The intents that set `fields` on the current Task (re-read after each write). */
async function apply(R: ResourceId, id: string, fields: Fields): Promise<DataUnitId[]> {
  const units: DataUnitId[] = [];
  const task = async () => (await runtime.profileOf(R)).replica.task(id)?.task as Task;
  const write = async (intent: ReplicaIntent) => {
    const u = await runtime.writeIntent(R, intent);
    if (u !== null) units.push(u);
  };
  if (fields.title !== undefined) await write(setTitle(await task(), fields.title).intent);
  if (fields.status !== undefined) {
    const t = await task();
    const s = fields.status;
    await write(
      (s === "done"
        ? complete(t, fields.completion_date)
        : s === "todo"
          ? reopen(t)
          : s === "cancelled"
            ? cancel(t)
            : setStatus(t, s)
      ).intent,
    );
  } else if (fields.completion_date !== undefined)
    await write(complete(await task(), fields.completion_date).intent);
  for (const [field, set, clear] of [
    ["due", setDue, clearDue],
    ["scheduled", setScheduled, clearScheduled],
  ] as const) {
    const v = fields[field];
    if (v === undefined) continue;
    await write((v === null ? clear(await task()) : set(await task(), v)).intent);
  }
  if (fields.priority !== undefined) await write(setPriority(await task(), fields.priority).intent);
  if (fields.tags !== undefined) {
    const t = await task();
    for (const tag of fields.tags)
      if (t.tags[tag] !== true) await write(addTag(await task(), tag).intent);
    for (const tag of Object.keys(t.tags))
      if (!fields.tags.includes(tag)) await write(removeTag(await task(), tag).intent);
  }
  return units;
}

async function run(name: string, crlf: boolean): Promise<void> {
  const c = JSON.parse(read(`${name}/case.json`)) as GoldenCase;
  const R = await runtime.createResource({ name, endpoints: [URL_], coordinatorUrl: URL_ });
  const ids = new Map(Object.entries(c.objects).map(([alias, o]) => [alias, o.id]));
  const aliasOf = new Map([...ids].map(([alias, id]) => [id, alias]));
  const key = (alias: string) => `${toBase64url(R)}#${ids.get(alias)}`;
  const fill = (text: string) => {
    let t = text;
    for (const [alias, id] of ids)
      t = t.replaceAll(`{{${alias}}}`, `lfcp1:${toBase64url(R)}#task:${id}`);
    return crlf ? t.replace(/\r?\n/g, "\r\n") : t;
  };
  const where = `${name} (${crlf ? "CRLF" : "LF"}): ${c.description}\nevent: ${JSON.stringify(c.event)}`;

  for (const [, o] of Object.entries(c.objects)) {
    const { id, title, status, completion_date, ...rest } = o;
    await runtime.writeIntent(
      R,
      createTask({
        id: id as never,
        title,
        createdBy: me,
        ...(rest.due ? { due: rest.due } : {}),
        ...(rest.scheduled ? { scheduled: rest.scheduled } : {}),
        ...(rest.priority ? { priority: rest.priority } : {}),
        ...(rest.tags ? { tags: rest.tags } : {}),
        ...(status !== undefined && status !== "done" ? { status } : {}),
      }).intent,
    );
    if (status === "done")
      await apply(R, id, { status, ...(completion_date ? { completion_date } : {}) });
  }
  let withdrawn: DataUnitId[] = [];
  const events: GoldenEvent[] = [];
  for (let e: GoldenEvent | undefined = c.event; e !== undefined; e = e.then) events.push(e);
  for (const e of events)
    if (e.type === "withdraw") withdrawn = await apply(R, ids.get(e.object) as string, e.applied);

  const guard = new MutationGuard();
  const engine = new ProjectionEngine(() => runtime, guard);
  const vault = new Vault();
  const writer = new ProjectionWriter(engine, guard, vault, () => runtime);
  const before = notes(name, "before");
  for (const [f, t] of before) vault.files.set(f, fill(t));
  const initial = await writer.handleChanges(
    [...before.keys()].map((path) => ({ kind: "create", path })),
  );
  expect(vault.writes, `${where}\nbefore/ must match the objects`).toEqual([]);
  expect(
    initial.flatMap((o) => o.projection?.sent ?? []),
    `${where}\nbefore/ sends nothing`,
  ).toEqual([]);

  const outcomes: NoteOutcome[] = [];
  let moved: { from: string; to: string } | null = null;
  for (const e of events) {
    if (e.type === "remote") {
      const keys = new Set<string>();
      for (const [alias, fields] of Object.entries(e.set ?? {})) {
        await apply(R, ids.get(alias) as string, fields);
        keys.add(key(alias));
      }
      for (const alias of e.delete ?? []) {
        const task = (await runtime.profileOf(R)).replica.task(ids.get(alias) as string)
          ?.task as Task;
        await runtime.writeIntent(R, deleteTask(task).intent);
        keys.add(key(alias));
      }
      outcomes.push(...(await writer.objectsChanged(keys)));
    } else if (e.type === "edit") {
      vault.files.set(e.file, fill(read(`${name}/edit/${e.file}`)));
      outcomes.push(...(await writer.handleChanges([{ kind: "modify", path: e.file }])));
    } else if (e.type === "move") {
      vault.files.set(e.to, vault.files.get(e.from) as string);
      vault.files.delete(e.from);
      moved = { from: e.from, to: e.to };
      outcomes.push(
        ...(await writer.handleChanges([{ kind: "rename", path: e.to, oldPath: e.from }])),
      );
    } else if (e.type === "concurrent") {
      const id = ids.get(e.object) as string;
      const profile = await runtime.profileOf(R);
      const other = SharedObjectsReplica.fromChanges(profile.replica.changes(), {
        resource: R,
        principal: principalId(new Uint8Array(32).fill(9)),
      }).replica;
      const theirs: Uint8Array[] = [];
      const t = other.task(id)?.task as Task;
      if (e.remote.status !== undefined)
        theirs.push(other.apply(setStatus(t, e.remote.status).intent)?.change as Uint8Array);
      if (e.remote.title !== undefined)
        theirs.push(other.apply(setTitle(t, e.remote.title).intent)?.change as Uint8Array);
      await apply(R, id, e.local);
      for (const ch of theirs) profile.replica.receiveChange(ch);
      outcomes.push(...(await writer.objectsChanged(new Set([key(e.object)]))));
    } else {
      const profile = await runtime.profileOf(R);
      profile.exclude(withdrawn);
      const k = new Set([key(e.object)]);
      outcomes.push(...(await writer.objectsChanged(k, k)));
    }
  }

  // Notes: exact content.
  const edited = notes(name, "edit");
  const after = notes(name, "after");
  const expectedFiles = new Map<string, string>();
  for (const [f, t] of before) {
    const path = moved !== null && f === moved.from ? moved.to : f;
    expectedFiles.set(path, fill(after.get(path) ?? edited.get(path) ?? t));
  }
  expect([...vault.files.keys()].sort(), where).toEqual([...expectedFiles.keys()].sort());
  for (const [f, want] of expectedFiles) {
    const got = vault.files.get(f) as string;
    const options = c.alternatives?.[f]?.map(fill) ?? [want];
    if (!options.includes(got))
      throw new Error(`${where}\nnote ${f} differs:\n${unifiedDiff(options[0] as string, got)}`);
  }

  // Intents.
  const sent = outcomes.flatMap((o) =>
    (o.projection?.sent ?? []).map((s) => ({ object: aliasOf.get(s.objectId), ...s.intent })),
  );
  if (c.expect.intents !== undefined) {
    expect(sent, where).toMatchObject(c.expect.intents);
    expect(sent, where).toHaveLength(c.expect.intents.length);
  }

  // Diagnostics (engine, render, and the ref scanner on the final note).
  for (const d of c.expect.diagnostics ?? []) {
    const codes = new Set([
      ...outcomes
        .filter((o) => o.path === d.file)
        .flatMap((o) => [
          ...(o.projection?.diagnostics.map((x) => x.code) ?? []),
          ...o.rendered.flatMap((r) => r.issues.map((i) => i.code)),
        ]),
      ...scanRefs(vault.files.get(d.file) ?? "").diagnostics.map((x) => x.code),
    ]);
    expect([...codes], `${where}\ndiagnostic ${d.code} for ${d.file}`).toContain(d.code);
  }

  // Conflicts (surfaced, never written).
  for (const want of c.expect.conflicts ?? []) {
    const got = outcomes
      .filter((o) => o.path === want.file)
      .flatMap((o) => o.rendered)
      .filter((r) => r.key === key(want.object) && r.conflicts.length > 0)
      .at(-1);
    expect(got?.conflicts, where).toEqual(want.fields);
  }
  for (const t of vault.files.values()) expect(t, where).not.toMatch(/<{7}|={7}|>{7}/);

  // Idempotency: a second sync of every note writes nothing and sends nothing.
  vault.writes.length = 0;
  for (const f of vault.files.keys()) {
    const again = await writer.syncNote(f);
    expect(again.projection?.sent ?? [], `${where}\nsecond sync of ${f}`).toEqual([]);
  }
  expect(vault.writes, `${where}\nsecond sync writes nothing`).toEqual([]);
}

describe("golden projection fixtures (LFCP-063)", () => {
  for (const name of CASES) {
    it(`${name} (LF)`, () => run(name, false));
    it(`${name} (CRLF)`, () => run(name, true));
  }
});

describe("unifiedDiff", () => {
  it("shows the changed lines with context and visible CRs", () => {
    expect(unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nd\n")).toBe(
      "@@ -1 +1 @@\n  a\n- b\n+ B\n  c\n  d",
    );
    expect(unifiedDiff("x\r\n", "y\r\n")).toBe("@@ -1 +1 @@\n- x\\r\n+ y\\r\n  ");
  });
});
