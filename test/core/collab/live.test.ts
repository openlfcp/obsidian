// LFCP-065 against the reference server: create and host a collaboration,
// share a task, invite with each preset, join from other devices through
// the real LFCP-053 claim flow, and see edits flow both ways. Skipped
// without a server binary (test/support/live-server.ts).

import { type ObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type JoinStage, taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
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
  return { runtime, collab: new Collaboration(runtime, { connectTimeoutMs: 5000, sleep }) };
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

    // Read + write: the joiner sees the task and edits it; the owner sees the edit.
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

  it("a collaboration the server does not host: refused once, shown in status, not retried (POST-017)", async () => {
    const d = await device();
    const url = server.url;
    const opening = new Map<string, number>();
    d.runtime.on((e) => {
      if (e.type === "resource-state" && e.state === "OPENING") {
        const key = toHex(e.resourceId);
        opening.set(key, (opening.get(key) ?? 0) + 1);
      }
    });
    const refused = (R: ResourceId) =>
      until("the refusal", async () =>
        (await d.runtime.registry()).find(
          (e) => toHex(e.resourceId) === toHex(R) && e.state === "refused",
        ),
      );
    const sync = async (R: ResourceId) =>
      statusView(await d.collab.status(R)).rows.find((r) => r.label === "Sync")?.value;

    // On this device only, never hosted: to the server, the same as a
    // purged collaboration or one on a restored server.
    const R = await d.runtime.createResource({
      name: "Gone",
      endpoints: [url],
      coordinatorUrl: url,
    });
    await d.runtime.openResource(R);
    expect((await refused(R)).refusal).toMatchObject({ code: "RESOURCE_NOT_HOSTED", url });
    expect(await sync(R)).toBe(
      `Not hosted by ${url}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED)`,
    );
    expect(await d.collab.refusalNotice(R)).toBe(
      `Shared Tasks: "Gone" stopped syncing. Not hosted by ${url}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED). Your tasks stay on this device; see "Resource status".`,
    );
    expect(await d.collab.refusalNotice(R)).toBeNull(); // once per collaboration
    // No reconnect storm: the session does not ask again.
    await new Promise((r) => setTimeout(r, 1500));
    expect(opening.get(toHex(R))).toBe(1);

    // Created while the server was unreachable: no notice, "not hosted yet".
    const P = await d.runtime.createResource({
      name: "Created offline",
      endpoints: [url],
      coordinatorUrl: url,
    });
    await d.runtime.localState.put(`collab-hosting:${toHex(P)}`, "pending");
    await d.runtime.openResource(P);
    await refused(P);
    expect(await d.collab.refusalNotice(P)).toBeNull();
    expect(await sync(P)).toBe(`Not hosted yet on ${url}: host it from here to start syncing`);

    // Opening it again (e.g. right after hosting it) asks the server once more.
    await d.runtime.openResource(R);
    await until("a second open", async () => (opening.get(toHex(R)) === 2 ? true : undefined));
    await refused(R);
  }, 30_000);
});
