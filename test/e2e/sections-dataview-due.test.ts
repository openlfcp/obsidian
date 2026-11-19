// @vitest-environment happy-dom
// PB-11 (E-021): a Task with a Dataview due date (`[due:: 2026-11-13]`, the
// Tasks plugin's Dataview format) reaches another client with its due, so
// the bridge's `default` filter takes it. Before PB-11 the field was title
// text: the Task synced without a due and the filter dropped it silently.
// A writes the field into its shared section; B, a second installation that
// claimed an invitation, reads the Task from its own replica (what came
// through the server), not from Markdown. The filter is the bridge's QB10
// rule, restated here (the bridge is not a dependency of the plugin). A's
// line keeps its Dataview format. Skipped without the server unless
// LFCP_REQUIRE_LIVE=1 (then an error).

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import type { Task } from "@openlfcp/shared-objects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

const DUE = "2026-11-13";

/**
 * The bridge's `default` filter (bridge `packages/reminders/src/adapter/filter.ts`,
 * QB10) for a Task that may get a new reminder: active, not closed, and
 * assigned to me or unassigned with a due date. Nobody is assigned here.
 */
const inDefaultFilter = (t: Task): boolean =>
  t.lifecycle === "active" &&
  t.status !== "done" &&
  t.status !== "cancelled" &&
  Object.keys(t.assignees).length === 0 &&
  t.due !== undefined &&
  t.due !== null;

/** The Tasks of a section as `who`'s replica holds them, by title. */
function tasksOf(who: SoakPeer, R: ResourceId): Map<string, Task> {
  const replica = who.runtime.sectionProfile(R)?.replica;
  const out = new Map<string, Task>();
  if (replica === undefined) return out;
  for (const node of Object.values(replica.snapshot().nodes)) {
    if (node.taskId === undefined || node.deleted) continue;
    const task = replica.task(node.taskId)?.task;
    if (task !== undefined) out.set(task.title, task);
  }
  return out;
}

describe.skipIf(!live)("a Dataview due date crosses to another client (PB-11)", () => {
  it("B receives the Task with its due, and the bridge's default filter takes it", async () => {
    const { resource } = await A.share(2, ["a"]);
    const R = fromBase64url(resource) as ResourceId;
    await until(
      "A current",
      async () =>
        (await A.sectionStates()).every((s) => s.state === "CURRENT") ? true : undefined,
      60_000,
    );

    // A adds the field after the first Task's title, as a person types it.
    const before = A.vault.read(SECTION_NOTE);
    const line = /^- \[ \] (a1 [^<\n]*?)(?=\s*(<!--|$))/m.exec(before);
    const title = line?.[1];
    if (line === null || title === undefined) throw new Error(`no a1 Task in\n${before}`);
    const at = line.index + line[0].length;
    await A.vault.write(SECTION_NOTE, `${before.slice(0, at)}  [due:: ${DUE}]${before.slice(at)}`);
    await until(
      "A's due in its model",
      () => (tasksOf(A, R).get(title)?.due === DUE ? true : undefined),
      60_000,
    );
    await until(
      "A sent it",
      async () =>
        (await A.sectionStates()).every((s) => s.state === "CURRENT" && s.pending === 0)
          ? true
          : undefined,
      60_000,
    );

    // B claims an invitation and receives the section through the server.
    const link = await A.invite(resource);
    await B.join(link, "Work");
    const received = await until(
      "B's replica has the Task with its due",
      () => {
        const t = tasksOf(B, R).get(title);
        return t?.due === DUE ? t : undefined;
      },
      120_000,
    );
    expect(received.title).toBe(title);
    expect(inDefaultFilter(received)).toBe(true);
    // The other Task has no due and nobody assigned: not in the filter.
    const other = [...tasksOf(B, R).values()].find((t) => t.title !== title);
    expect(other).toBeDefined();
    expect(inDefaultFilter(other as Task)).toBe(false);

    // A's line keeps the Dataview field; it is not rewritten as 📅.
    const after = A.vault.read(SECTION_NOTE);
    expect(after).toContain(`${title}  [due:: ${DUE}]`);
    expect(after).not.toContain("📅");
  }, 300_000);
});
