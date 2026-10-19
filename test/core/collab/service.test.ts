// LFCP-065: the collaboration flows on a real runtime (real SDK, real
// IndexedDB storage through fake-indexeddb) on a device without network.
// The live flows against the reference server are in live.test.ts.

import { fromHex, type ObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { PROFILE_ID, SharedObjectsReplica, setStatus } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import { ABILITY, decodeControlRecord, parseInviteUri } from "@openlfcp/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskAt } from "../../../src/core/collab/markdown";
import { CollabError, Collaboration } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { collaborator, storeBlocked } from "../../support/blocked-units";
import { SECTIONS, storeForeign } from "../../support/foreign-resource";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const SERVER = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of running.splice(0)) await r.stop();
});

/** A ready runtime on an offline device, and the flows with short timeouts. */
async function offline() {
  const device = new Device();
  const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
  running.push(runtime);
  const collab = new Collaboration(runtime, {
    sleep,
    connectTimeoutMs: 50,
    ackTimeoutMs: 50,
    joinTimeoutMs: 200,
  });
  return { device, runtime, collab };
}

const localTask = (line: string) => {
  const at = taskAt(line, 0);
  if (at.kind !== "local") throw new Error(at.kind);
  return at.state;
};

/** The control records queued for the coordinator, decoded. */
async function queuedRecords(runtime: LfcpRuntime, R: ResourceId) {
  const items = (await runtime.storage?.outbound.list(R)) ?? [];
  return items.filter((i) => i.kind === "control-record").map((i) => decodeControlRecord(i.bytes));
}

describe("Create collaboration (LFCP-065)", () => {
  it("creates the Resource locally with its registry entry; hosting waits for the server", async () => {
    const { runtime, collab } = await offline();
    const created = await collab.create({ name: "Team tasks", server: SERVER });
    expect(created.hosting.kind).toBe("pending");
    const entry = (await runtime.registry()).find(
      (e) => toHex(e.resourceId) === toHex(created.resourceId),
    );
    expect(entry).toMatchObject({
      localName: "Team tasks",
      profile: PROFILE_ID,
      routes: [SERVER],
      state: "offline",
    });
    expect(entry?.lastKnownControlHead).toMatch(/^[0-9a-f]{64}$/);
    // The Shared Objects root is the Resource's first Data Unit, queued.
    const status = await collab.status(created.resourceId);
    expect(status.hosting).toBe("pending");
    expect(status.pendingOutbound).toBe(1);
    expect(status.participants).toEqual([
      {
        id: expect.any(String),
        principal: expect.stringMatching(/^[0-9a-f]{64}$/),
        you: true,
        owner: true,
        abilities: ["owner"],
      },
    ]);
  });

  it("refuses an empty name and a non-WebSocket server", async () => {
    const { collab } = await offline();
    await expect(collab.create({ name: " ", server: SERVER })).rejects.toThrow(CollabError);
    await expect(collab.create({ name: "x", server: "https://a.example" })).rejects.toThrow(
      "The server must be a WebSocket URL",
    );
  });
});

describe("a shared section in the pickers and status (LFCP-02-066)", () => {
  it('with the sections preview, its session\'s state, not "needs a newer version"; without, unsupported', async () => {
    const { runtime } = await offline();
    const R = await storeForeign(runtime, SECTIONS, "Launch");
    const on = new Collaboration(runtime, { sleep, connectTimeoutMs: 50, sections: true });
    const off = new Collaboration(runtime, { sleep, connectTimeoutMs: 50 });
    const stateOf = async (c: Collaboration) =>
      (await c.list()).find((e) => toHex(e.resourceId) === toHex(R))?.state;
    expect(await stateOf(on)).toBe("offline");
    expect((await on.status(R)).state).toBe("offline");
    // 0.3.2's rule stands without the preview: this version cannot read it.
    expect(await stateOf(off)).toBe("unsupported");
  });
});

describe("Invite collaborator (LFCP-065)", () => {
  for (const [preset, abilities] of [
    ["read", [ABILITY.DATA_READ, ABILITY.INVITE_CLAIM]],
    ["read-write", [ABILITY.DATA_READ, ABILITY.DATA_WRITE, ABILITY.INVITE_CLAIM]],
  ] as const)
    it(`${preset}: a one-time grant with the preset's abilities and a bearer link`, async () => {
      const { runtime, collab } = await offline();
      const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
      const invitation = await collab.invite(R, preset);
      // Offline: queued, not confirmed by the coordinator yet.
      expect(invitation.confirmed).toBe(false);
      expect(invitation.claimLimit).toBe(1n);
      const [grant] = await queuedRecords(runtime, R);
      expect(grant?.body).toMatchObject({ type: "CAPABILITY_GRANT", claimLimit: 1n });
      expect((grant?.body as { abilities?: readonly bigint[] } | undefined)?.abilities).toEqual(
        abilities,
      );
      // The link names the Resource, its endpoint and the grant; it prints redacted.
      const parsed = parseInviteUri(invitation.link.reveal());
      expect(toHex(parsed.resourceId)).toBe(toHex(R));
      expect(parsed.endpoints).toEqual([SERVER]);
      expect(String(invitation.link)).toBe("[redacted]");
      expect(
        JSON.stringify(invitation, (_, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain("lfcp://");
    });

  it("waits while this vault does not know yet whether it may publish the epoch's Snapshot (LFCP-03-037)", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    // Just started: "checking" until its session is LIVE, then the Snapshot is published.
    const states = ["checking", "checking", "publishing", "ready"] as const;
    let asked = 0;
    vi.spyOn(runtime, "epochSnapshotState").mockImplementation(async () => {
      const s = states[Math.min(asked, states.length - 1)] ?? "ready";
      asked++;
      // The grant is not made while the Snapshot may still be missing.
      if (s !== "ready") expect(await queuedRecords(runtime, R)).toEqual([]);
      return s;
    });
    await collab.invite(R, "read");
    expect(asked).toBe(4);
    expect(await queuedRecords(runtime, R)).toHaveLength(1);
  });

  it("gives up on a session that never answers: an honest error and nothing created (LFCP-03-037)", async () => {
    const device = new Device();
    const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(runtime);
    const collab = new Collaboration(runtime, {
      sleep,
      connectTimeoutMs: 50,
      ackTimeoutMs: 50,
      snapshotTimeoutMs: 300,
    });
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    vi.spyOn(runtime, "epochSnapshotState").mockResolvedValue("checking");
    const refused = collab.invite(R, "read");
    await expect(refused).rejects.toMatchObject({ code: "SNAPSHOT_PENDING" });
    await expect(refused).rejects.toThrow(
      /Nothing was created\. Invite again once it is connected/,
    );
    // No grant made, so no second one under a new ID when the user invites again (D12).
    expect(await queuedRecords(runtime, R)).toEqual([]);
  });

  it("does not wait for a Snapshot the server refuses: its refusal at once, nothing created (LFCP-03-037)", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    vi.spyOn(runtime, "epochSnapshotState").mockResolvedValue("checking");
    vi.spyOn(runtime, "refusal").mockReturnValue({ code: "RESOURCE_NOT_HOSTED" } as never);
    const started = Date.now();
    const refused = collab.invite(R, "read");
    await expect(refused).rejects.toMatchObject({ code: "RESOURCE_NOT_HOSTED" });
    await expect(refused).rejects.toThrow(
      /refused this collaboration \(RESOURCE_NOT_HOSTED\).*Nothing was created/,
    );
    // Well before the Snapshot wait's timeout (60 s by default).
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await queuedRecords(runtime, R)).toEqual([]);
  });

  it("names a revoked section by its shared title, without the server's address (C-8)", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const entries = await runtime.registry();
    vi.spyOn(runtime, "registry").mockResolvedValue(
      entries.map((e) => ({ ...e, localName: null, profile: SECTIONS })),
    );
    vi.spyOn(runtime, "newlyRefused").mockResolvedValue({
      code: "AUTHORIZATION_FAILED",
      url: SERVER,
    } as never);
    vi.spyOn(runtime, "sectionProfile").mockReturnValue({
      replica: { snapshot: () => ({ title: { value: "Core with Tasks" } }) },
    } as never);
    const text = await collab.refusalNotice(R);
    expect(text).toContain('"Core with Tasks" stopped syncing');
    expect(text).not.toContain("a shared section");
    expect(text).not.toContain(SERVER);
    // Without a title it falls back to the words, still no address.
    vi.spyOn(runtime, "newlyRefused").mockResolvedValue({
      code: "AUTHORIZATION_FAILED",
      url: SERVER,
    } as never);
    vi.spyOn(runtime, "sectionProfile").mockReturnValue(undefined);
    const bare = await collab.refusalNotice(R);
    expect(bare).toContain('"a shared section" stopped syncing');
    expect(bare).not.toContain(SERVER);
  });

  it("is refused while the Control Chain is forked", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    vi.spyOn(runtime, "registry").mockResolvedValue(
      (await runtime.registry()).map((e) => ({ ...e, state: "control_conflict" as const })),
    );
    await expect(collab.invite(R, "read")).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
    await expect(collab.share(R, localTask("- [ ] A"))).rejects.toMatchObject({
      code: "CONTROL_CONFLICT",
    });
    expect((await collab.status(R)).blocked).toBe(true);
  });

  it("shows collaborators whose edits cannot be applied, with codes and counts only", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const row = async () =>
      statusView(await collab.status(R)).rows.find(
        (r) => r.label === "Edits that cannot be applied here",
      )?.value;
    expect(await row()).toBe("none");
    await storeBlocked(runtime.storage as LfcpStorage, R, [
      { n: 1, who: 0x11, seq: 3n, status: "equivocation" },
      { n: 2, who: 0x11, seq: 3n, status: "equivocation" },
      {
        n: 3,
        who: 0x22,
        seq: 1n,
        status: "local-failure",
        detail: "INVALID_AUTOMERGE_BYTES: crashed the engine twice",
      },
    ]);
    const id = (n: number) => toHex(collaborator(n)).slice(0, 8);
    expect(await row()).toBe(
      `${id(0x11)}: 2 changes (ACTOR_EQUIVOCATION); ${id(0x22)}: 1 change (INVALID_AUTOMERGE_BYTES)`,
    );
  });
});

describe("Join collaboration (LFCP-065)", () => {
  it("reports an unreachable server as needing a connection, with no secret in any output", async () => {
    const { runtime, collab } = await offline();
    const owner = await offline();
    const { resourceId: R } = await owner.collab.create({ name: "Team", server: SERVER });
    const link = (await owner.collab.invite(R, "read-write")).link.reveal();
    const secret = link.slice(link.indexOf("#"));
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
    const stages: string[] = [];
    const outcome = await collab.join(link, { name: "Joined", onStage: (s) => stages.push(s) });
    expect(outcome.kind).toBe("unavailable");
    // The SDK reports each §73 step as it starts; offline, the first one fails.
    expect(stages).toEqual(["connecting"]);
    const everything = [JSON.stringify(outcome), ...logged, ...stages].join("\n");
    expect(everything).not.toContain(secret.slice(1));
    expect(everything).not.toContain("lfcp://join");
    // Nothing was stored for the Resource.
    expect(await runtime.hasResource(R)).toBe(false);
  });

  it("rejects a malformed link without echoing it", async () => {
    const { collab } = await offline();
    const bad = "lfcp://join/not-a-resource#secret=c2VjcmV0";
    await expect(collab.join(bad, { name: "x" })).rejects.toMatchObject({
      code: "INVALID_INVITATION",
    });
    await collab.join(bad, { name: "x" }).catch((e: Error) => {
      expect(e.message).not.toContain("c2VjcmV0");
    });
  });
});

describe("Share and edit offline (LFCP-065, local-first)", () => {
  it("shares a local Task as task.create and queues it without a connection", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const before = (await runtime.storage?.outbound.list(R))?.length ?? 0;
    const shared = await collab.share(
      R,
      localTask("- [/] Prepare API contract 📅 2026-10-15 #api"),
    );
    const view = (await runtime.profileOf(R)).replica.task(shared.objectId);
    expect(view?.task).toMatchObject({
      title: "Prepare API contract",
      status: "in_progress",
      due: "2026-10-15",
      tags: { api: true },
    });
    expect((await runtime.storage?.outbound.list(R))?.length).toBe(before + 1);
    expect((await collab.status(R)).pendingOutbound).toBe(before + 1);
    expect(await collab.tasks(R)).toEqual([
      { objectId: shared.objectId, title: "Prepare API contract", status: "in_progress" },
    ]);
  });
});

describe("Share many (POST-018)", () => {
  it("shares each Task as its own change, created_at in note order", async () => {
    const device = new Device();
    const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(runtime);
    const collab = new Collaboration(runtime, {
      sleep,
      connectTimeoutMs: 50,
      ackTimeoutMs: 50,
      now: () => Date.UTC(2026, 9, 7, 10, 0, 0),
    });
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const before = (await runtime.storage?.outbound.list(R))?.length ?? 0;
    const { shared, error } = await collab.shareAll(R, [
      localTask("- [ ] One"),
      localTask("- [ ] Two"),
      localTask("- [ ] Three"),
    ]);
    expect(error).toBeUndefined();
    expect(shared).toHaveLength(3);
    expect((await runtime.storage?.outbound.list(R))?.length).toBe(before + 3);
    const candidates = await collab.insertCandidates(R);
    const byId = new Map(candidates.map((c) => [c.objectId, c.createdAt]));
    expect(shared.map((s) => byId.get(s.objectId))).toEqual([
      "2026-10-07T10:00:00.000Z",
      "2026-10-07T10:00:00.001Z",
      "2026-10-07T10:00:00.002Z",
    ]);
    // A failure stops the batch and keeps what was shared before it.
    const partial = await collab.shareAll(R, [
      localTask("- [ ] Four"),
      localTask("- [ ] 📅 2026-10-15"),
    ]);
    expect(partial.shared).toHaveLength(1);
    expect(String(partial.error)).toContain("no title");
  });
});

describe("Conflict hook (LFCP-065)", () => {
  it("lists the competing values and resolves only through task.resolve_field_conflict", async () => {
    const { runtime, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const { objectId } = await collab.share(R, localTask("- [ ] Ship it"));
    const profile = await runtime.profileOf(R);
    // A collaborator's concurrent status change, merged as a remote change would be.
    const other = SharedObjectsReplica.fromChanges(profile.replica.changes(), {
      resource: R,
      principal: fromHex("ab".repeat(32)) as never,
    }).replica;
    const task = other.task(objectId)?.task;
    if (task === undefined) throw new Error("no task");
    const theirs = other.apply(setStatus(task, "cancelled").intent);
    await runtime.writeIntent(R, setStatus(task, "done").intent);
    profile.replica.receiveChange(theirs?.change as Uint8Array);

    expect(await collab.conflicts(R, objectId)).toEqual([
      { field: "status", values: ["cancelled", "done"] },
    ]);
    expect((await collab.status(R)).conflicts).toEqual([
      { objectId, title: "Ship it", fields: ["status"] },
    ]);
    const unit = await collab.resolve(R, objectId as ObjectId, "status", "done");
    expect(unit).not.toBeNull();
    expect(await collab.conflicts(R, objectId)).toEqual([]);
    expect(profile.replica.task(objectId)?.task?.status).toBe("done");
  });
});

describe("Resource status (LFCP-065)", () => {
  it("shows no key material", async () => {
    const { device, collab } = await offline();
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    await collab.invite(R, "read");
    const text = JSON.stringify(await collab.status(R));
    // Every secret this device holds (Principal keys, DEKs, marker), as stored.
    const secrets = [...device.slots.values.values()].filter((v) => v.length >= 16);
    expect(secrets.length).toBeGreaterThan(2);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain("lfcp://join");
  });
});
