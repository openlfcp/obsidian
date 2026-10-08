// ADR 0001 §1 (0.4): the 0.1 Task engine leaves the lines of shared
// sections to the section engine, even when they hold ordinary lfcp-refs.

import { generateObjectId, type ObjectId, type ResourceId, toBase64url } from "@openlfcp/core";
import { createTask, type Task } from "@openlfcp/shared-objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planBatchShare } from "../../../src/core/collab/batch";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { ProjectionEngine } from "../../../src/core/projection/engine";
import { MutationGuard } from "../../../src/core/projection/guard";
import { scanLegacy } from "../../../src/core/projection/legacy-scan";
import { type NoteIO, ProjectionWriter } from "../../../src/core/projection/writer";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL_ = "wss://offline.example.invalid/v1/ws";
let runtime: LfcpRuntime;
let R: ResourceId;
beforeAll(async () => {
  runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  R = await runtime.createResource({ name: "Legacy", endpoints: [URL_], coordinatorUrl: URL_ });
});
afterAll(async () => {
  await runtime.stop();
});

const S = parseSectionRef(
  "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#section:019a2f85-7b31-7c42-b85a-fc843e2f4001",
) as SectionRef;
const refOf = (id: string) => `<!-- lfcp-ref: lfcp1:${toBase64url(R)}#task:${id} -->`;
async function shared(title: string): Promise<ObjectId> {
  const id = generateObjectId();
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error("not ready");
  await runtime.writeIntent(R, createTask({ id, title, createdBy: status.principalId }).intent);
  return id;
}
const task = async (id: string) => (await runtime.profileOf(R)).replica.task(id)?.task as Task;

/** A note with the same shared Task outside a section and inside one. */
const note = (id: string, outside: string, inside: string) =>
  [
    `- [ ] ${outside}`,
    `  ${refOf(id)}`,
    "## Shared",
    formatBoundary("start", S),
    `- [ ] ${inside}`,
    `  ${refOf(id)}`,
    "- [ ] Local in the section",
    formatBoundary("end", S),
    "- [ ] Local outside",
    "",
  ].join("\n");

describe("the 0.1 engine and shared sections (ADR 0001 §1)", () => {
  it("scanLegacy drops the Tasks, refs and diagnostics inside a section", () => {
    const scan = scanLegacy(note("019a2f85-7b31-7c42-b85a-fc843e2f40ad", "A", "B"));
    expect(scan.projections.map((p) => p.taskLine)).toEqual([0]);
    expect(scan.tasks.map((t) => t.task.line)).toEqual([0, 8]);
  });

  it("an edit inside a section sends nothing; the same Task outside still syncs", async () => {
    const id = await shared("Title");
    const engine = new ProjectionEngine(() => runtime, new MutationGuard());
    await engine.processFile("n.md", note(id, "Title", "Title"));
    const inside = await engine.processFile("n.md", note(id, "Title", "Edited inside"));
    expect(inside.sent).toEqual([]);
    expect((await task(id)).title).toBe("Title");
    const outside = await engine.processFile("n.md", note(id, "Edited outside", "Edited inside"));
    expect(outside.sent.map((s) => s.intent)).toEqual([
      { intent: "task.set_title", id, title: "Edited outside" },
    ]);
  });

  it("the render never rewrites a Task line inside a section", async () => {
    const id = await shared("Stale");
    const files = new Map([["r.md", note(id, "Stale", "Stale")]]);
    const io: NoteIO = {
      read: async (p) => files.get(p) ?? null,
      rewrite: async (p, fn) => void files.set(p, fn(files.get(p) ?? "")),
      isBeingEdited: () => false,
    };
    const guard = new MutationGuard();
    const engine = new ProjectionEngine(() => runtime, guard);
    await engine.reindex("r.md", files.get("r.md") as string); // the base: what the note shows
    // A shared change arrives; the note shows the old title outside and inside.
    await runtime.writeIntent(R, { intent: "task.set_title", id, title: "Fresh" });
    await new ProjectionWriter(engine, guard, io, () => runtime).syncNote("r.md");
    const lines = (files.get("r.md") ?? "").split("\n");
    expect(lines[0]).toBe("- [ ] Fresh");
    expect(lines[4]).toBe("- [ ] Stale");
  });

  it('"Share selected tasks" never shares a Task inside a section', () => {
    const md = note("019a2f85-7b31-7c42-b85a-fc843e2f40ad", "A", "B");
    const plan = planBatchShare(md, { from: 0, to: 8 });
    expect(plan.share.map((s) => s.task.line)).toEqual([8]);
  });
});
