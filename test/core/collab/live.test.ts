// LFCP-065 against the reference server: create and host a collaboration,
// share a task, invite with each preset, join from other devices through
// the real LFCP-053 claim flow, and see edits flow both ways. Skipped
// without a server binary (test/support/live-server.ts).

import { type ObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type JoinStage, taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal } from "../../support/lfcp-env";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
const running: LfcpRuntime[] = [];

beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  for (const r of running.splice(0)) await r.stop();
  await server?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A device with the platform WebSocket (online). */
async function device() {
  const d = new Device();
  // The platform WebSocket: the device's offline factory is left out.
  const { webSocket: _offline, ...online } = d.env(new FakeLocal(), { tickMs: 20 });
  const runtime = await LfcpRuntime.start(online);
  running.push(runtime);
  return { runtime, collab: new Collaboration(runtime, { connectTimeoutMs: 5000 }) };
}

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const local = (line: string) => {
  const at = taskAt(line, 0);
  if (at.kind !== "local") throw new Error(at.kind);
  return at.state;
};

describe.skipIf(skip !== null)("LFCP-065 live, against the reference server", () => {
  it("create, host, share, invite, join and sync; read-only and one-time invitations hold", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });

    // The owner creates and hosts the collaboration, and shares a task.
    const owner = await device();
    const created = await owner.collab.create({ name: "Team", server: server.url });
    expect(created.hosting.kind).toBe("hosted");
    const R: ResourceId = created.resourceId;
    const { objectId } = await owner.collab.share(
      R,
      local("- [ ] Prepare API contract 📅 2026-10-15"),
    );
    await until("the owner's units to be sent", async () =>
      (await owner.collab.status(R)).pendingOutbound === 0 ? true : undefined,
    );

    // Read + Write: the joiner sees the task and edits it; the owner sees the edit.
    const rw = await owner.collab.invite(R, "read-write");
    expect(rw.confirmed).toBe(true);
    const writer = await device();
    const stages: JoinStage[] = [];
    const joined = await writer.collab.join(rw.link.reveal(), {
      name: "Their team",
      onStage: (s) => stages.push(s),
    });
    expect(joined).toMatchObject({ kind: "joined", abilities: ["data/read", "data/write"] });
    // §73's order, as the SDK reports it: the key comes before the claim.
    expect(stages).toEqual([
      "connecting",
      "validating invitation",
      "retrieving key",
      "claiming capability",
      "synchronizing",
    ]);
    const seen = await until(
      "the task on the joiner",
      async () => (await writer.runtime.profileOf(R)).replica.task(objectId)?.task,
    );
    expect(seen.title).toBe("Prepare API contract");
    await writer.runtime.writeIntent(R, {
      intent: "task.set_status",
      id: objectId as ObjectId,
      status: "done",
    });
    await until("the joiner's edit on the owner", async () =>
      (await owner.runtime.profileOf(R)).replica.task(objectId)?.task?.status === "done"
        ? true
        : undefined,
    );
    expect(
      (await writer.collab.status(R)).participants.map((p) => [p.you, p.owner]),
    ).toContainEqual([true, false]);

    // Read: the claim grants data/read only.
    const read = await owner.collab.invite(R, "read");
    expect(read.confirmed).toBe(true);
    const reader = await device();
    const readerJoin = await reader.collab.join(read.link.reveal(), { name: "Read only" });
    expect(readerJoin).toMatchObject({ kind: "joined", abilities: ["data/read"] });

    // One-time: the same link is refused for a second device.
    const late = await device();
    const again = await late.collab.join(read.link.reveal(), { name: "Late" });
    expect(again).toMatchObject({ kind: "refused", code: "AUTHORIZATION_FAILED" });
    expect(await late.runtime.hasResource(R)).toBe(false);

    // No output ever carried a link or its secret.
    for (const link of [rw.link.reveal(), read.link.reveal()]) {
      const secret = link.slice(link.indexOf("#secret=") + "#secret=".length);
      for (const line of logged) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(link);
      }
    }
    expect(toHex(R)).toHaveLength(64);
  }, 60_000);
});
