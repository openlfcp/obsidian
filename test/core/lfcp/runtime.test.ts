// The plugin's LFCP runtime (LFCP-059): lifecycle, offline startup,
// durable pending state, the Resource registry.

import { saveControlChain } from "@openlfcp/client";
import {
  actorSequence,
  controlRecordId,
  type DataUnitId,
  dataEpoch,
  dataUnitId,
  generateResourceId,
  hash32,
  type ObjectId,
  principalId,
  type ResourceId,
  toHex,
} from "@openlfcp/core";
import {
  dekCommitment,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
  sha256,
} from "@openlfcp/crypto";
import { createTask, PROFILE_ID } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  principalDescriptorFromKeys,
  type Signer,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseName } from "../../../src/core/lfcp/install";
import { HELD_BLOCKED_MS, LfcpRuntime, NEEDS_RESTART } from "../../../src/core/lfcp/runtime";
import { Device, deleteDatabase, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const TASK = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f" as ObjectId;
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});
const start = async (device: Device, local: FakeLocal, extra = {}) => {
  const r = await LfcpRuntime.start(device.env(local, extra));
  running.push(r);
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Some owner's Resource, stored locally (its Genesis, route and a local name). The owner is not the local Principal. */
async function storeResource(runtime: LfcpRuntime, name: string): Promise<ResourceId> {
  const storage = runtime.storage as LfcpStorage;
  const key = generateSigningKeyPair();
  const owner: Signer = {
    key,
    descriptor: principalDescriptorFromKeys(key, generateAgreementKeyPair()),
  };
  const R = generateResourceId();
  const genesis = signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: PROFILE_ID,
      owner: owner.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), generateResourceDEK()),
      endpoints: [{ url: URL, priority: 0n }],
      coordinatorUrl: URL,
    },
    owner,
  );
  const chain = validateControlChain([genesis.bytes]);
  if (chain.kind !== "linear") throw new Error(chain.kind);
  expect((await saveControlChain(storage, chain, null)).ok).toBe(true);
  await storage.commit([
    {
      op: "put-resource",
      row: { resourceId: R, dataProfile: PROFILE_ID, localPrincipal: null, labels: { name } },
    },
  ]);
  return R;
}

describe("LfcpRuntime (LFCP-059)", () => {
  it("initializes Automerge before it touches storage", async () => {
    const device = new Device();
    const order: string[] = [];
    const env = device.env(new FakeLocal());
    const r = await LfcpRuntime.start({
      ...env,
      initializeAutomerge: async () => {
        order.push("automerge");
      },
      openStorage: (name, onReserved, secrets) => {
        order.push("storage");
        return env.openStorage(name, onReserved, secrets);
      },
    });
    running.push(r);
    expect(order).toEqual(["automerge", "storage"]);
  });

  it("starts and stops sessions with the plugin, leaving no timer or socket (test 6)", async () => {
    const device = new Device();
    const r = await start(device, new FakeLocal());
    expect(r.status.kind).toBe("ready");
    expect(r.sessions).toBe(0); // Resources open on demand
    const R = await storeResource(r, "Alpha");
    await r.openResource(R);
    await r.openResource(R); // the same session
    expect(r.sessions).toBe(1);
    expect(device.timers.active.size).toBe(1);
    await sleep(60);
    expect(device.sockets.opened.length).toBeGreaterThan(0);
    await r.stop();
    expect(r.status.kind).toBe("stopped");
    expect(r.sessions).toBe(0);
    expect(device.timers.active.size).toBe(0);
    expect(device.locks.size).toBe(0);
    const before = device.sockets.opened.length;
    await sleep(80);
    expect(device.sockets.opened.length).toBe(before); // no reconnect after stop
  });

  it("starts offline without losing the local Resource (test 7)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await storeResource(r, "Alpha");
    const opened = await r.openResource(R);
    expect(opened.profile.replica.objectIds()).toEqual([]);
    await sleep(60); // connection attempts fail
    expect(r.phase(R)).not.toBe("LIVE");
    expect((await r.registry()).map((e) => e.state)).toEqual(["offline"]);
    await r.stop();
    const again = await start(device, local);
    expect((await again.registry()).map((e) => e.localName)).toEqual(["Alpha"]);
    await again.openResource(R);
  });

  it("keeps pending outbound objects across unload (test 8)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await storeResource(r, "Alpha");
    const { storage } = { storage: r.storage as LfcpStorage };
    const bytes = Uint8Array.of(0xd2, 0x84, 1, 2, 3);
    const itemId = hash32(sha256(bytes));
    await storage.commit([
      {
        op: "enqueue",
        item: {
          itemId,
          resourceId: R,
          kind: "data-unit",
          bytes,
          attempts: 0,
          lastAttempt: null,
          nextAttempt: null,
          blocked: null,
        },
      },
    ]);
    expect((await storage.outbound.list(R)).length).toBe(1);
    await r.stop();
    const again = await start(device, local);
    const { storage: s2 } = { storage: again.storage as LfcpStorage };
    const [kept] = await s2.outbound.list(R);
    expect(toHex(kept?.itemId as Uint8Array)).toBe(toHex(itemId));
    expect(kept?.bytes).toEqual(bytes);
  });

  it("keeps the registry's local names, and never overrides the signed Control state (tests 4, 5)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await storeResource(r, "Alpha");
    const { storage } = { storage: r.storage as LfcpStorage };
    const head = toHex((await storage.control.head(R))?.head as Uint8Array);
    await r.setLocalName(R, "Renamed");
    const [entry] = await r.registry();
    expect(entry).toMatchObject({
      localName: "Renamed",
      profile: PROFILE_ID,
      routes: [URL],
      lastKnownControlHead: head,
      state: "offline",
    });
    await r.stop();
    const again = await start(device, local);
    const [after] = await again.registry();
    expect(after?.localName).toBe("Renamed");
    expect(after?.lastKnownControlHead).toBe(head);
    const { storage: s2 } = { storage: again.storage as LfcpStorage };
    expect(toHex((await s2.control.head(R))?.head as Uint8Array)).toBe(head);
  });

  it("writes intents through the real SDK path: change, Data Unit, queued, kept across restart", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createResource({ name: "Mine", endpoints: [URL], coordinatorUrl: URL });
    const storage = r.storage as LfcpStorage;
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const profile = await r.profileOf(R);
    const { intent } = createTask({ id: TASK, title: "Draft", createdBy: status.principalId });
    const unit = await r.writeIntent(R, intent);
    expect(unit).not.toBeNull();
    const queued = await storage.outbound.list(R);
    expect(queued.map((q) => q.kind)).toEqual(["data-unit", "data-unit"]); // initial document + Task
    expect(toHex(queued[1]?.itemId as Uint8Array)).toBe(toHex(unit as Uint8Array));
    expect(profile.replica.task(TASK)?.task?.title).toBe("Draft");
    await r.stop();
    const again = await start(device, local);
    expect((await again.storage?.outbound.list(R))?.length).toBe(2);
    expect((await again.profileOf(R)).replica.task(TASK)?.task?.title).toBe("Draft");
  });

  it("keeps own units remembered while a Key Epoch cut is being collected (no lost update)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createResource({ name: "Mine", endpoints: [URL], coordinatorUrl: URL });
    const storage = r.storage as LfcpStorage;
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const first = createTask({ id: TASK, title: "Draft", createdBy: status.principalId });
    const cutUnit = (await r.writeIntent(R, first.intent)) as DataUnitId;
    // A Key Epoch cut that unit off (G-EP7).
    await storage.commit([
      { op: "set-data-unit-status", unitId: cutUnit, status: "quarantined", detail: "STALE" },
    ]);
    // cutOwnObjects reads the map, then checks each unit's status: pause it there.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = storage.dataUnits.get.bind(storage.dataUnits);
    storage.dataUnits.get = async (id) => {
      await gate;
      return get(id);
    };
    const cutting = r.cutOwnObjects(R);
    await sleep(10);
    storage.dataUnits.get = get;
    // Meanwhile another own unit is written and remembered.
    const second = createTask({
      id: "017f22e2-79b0-7cc3-98c4-dc0c0c07399f" as ObjectId,
      title: "Second",
      createdBy: status.principalId,
    });
    const kept = (await r.writeIntent(R, second.intent)) as DataUnitId;
    release();
    expect(await cutting).toEqual([TASK]);
    const map = (await r.localState.get(`own-units:${toHex(R)}`)) as Record<string, string[]>;
    expect(Object.keys(map)).toEqual([toHex(kept)]);
    // The cut unit is reported once.
    expect(await r.cutOwnObjects(R)).toEqual([]);
  });

  it("an engine trap blocks the runtime once until restart (needs-restart)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createResource({ name: "Mine", endpoints: [URL], coordinatorUrl: URL });
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    await r.openResource(R);
    expect(r.sessions).toBe(1);
    const profile = await r.profileOf(R);
    // Test hook: the engine traps on the next change, as a terminated wasm module does.
    let calls = 0;
    profile.replica.apply = () => {
      calls++;
      throw new WebAssembly.RuntimeError("unreachable executed");
    };
    const heard: string[] = [];
    r.onNeedsRestart((m) => heard.push(m));
    const { intent } = createTask({ id: TASK, title: "Draft", createdBy: status.principalId });
    await expect(r.writeIntent(R, intent)).rejects.toThrow(NEEDS_RESTART);
    expect(r.status).toMatchObject({ kind: "needs-restart" });
    expect(r.sessions).toBe(0); // every session stopped
    expect(heard).toHaveLength(1);
    // Later calls refuse at once, without touching the engine, and are not reported again.
    await expect(r.writeIntent(R, intent)).rejects.toThrow(NEEDS_RESTART);
    await expect(r.openResource(R)).rejects.toThrow(NEEDS_RESTART);
    expect(calls).toBe(1);
    expect(heard).toHaveLength(1);
    // A restart works again (the trap was in this process only).
    await r.stop();
    const again = await start(device, local);
    expect(again.status.kind).toBe("ready");
    expect((await again.profileOf(R)).replica.task(TASK)).toBeUndefined();
  });

  it("lists collaborators whose units cannot be applied, held ones after a delay, and reports each once", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createResource({ name: "Mine", endpoints: [URL], coordinatorUrl: URL });
    const storage = r.storage as LfcpStorage;
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const actor = (n: number) => principalId(new Uint8Array(32).fill(n));
    const unit = (n: number, who: number, seq: bigint) => ({
      unitId: dataUnitId(new Uint8Array(32).fill(n)),
      resourceId: R,
      dataEpoch: dataEpoch(0n),
      actor: actor(who),
      actorSeq: actorSequence(seq),
      prevDataUnitId: null,
      controlHead: controlRecordId(new Uint8Array(32).fill(9)),
      bytes: Uint8Array.of(n),
    });
    const put = (n: number, who: number, seq: bigint, s: string, detail?: string) =>
      storage.commit([
        {
          op: "put-data-unit",
          unit: unit(n, who, seq),
          status: s as never,
          ...(detail === undefined ? {} : { detail }),
        },
      ]);
    // An equivocating pair from collaborator 0x11, a unit of 0x22 that
    // crashed the engine twice, and a unit of 0x33 held just now.
    await put(1, 0x11, 3n, "equivocation");
    await put(2, 0x11, 3n, "equivocation");
    await put(3, 0x22, 1n, "local-failure", "INVALID_AUTOMERGE_BYTES: crashed the engine twice");
    await put(4, 0x33, 2n, "held", "PREV_MISMATCH");
    // POST-001 (sdk-ts 0.1.3): a unit of 0x44 waiting for a rebuild; like held, after a delay.
    await put(6, 0x44, 1n, "profile-held");
    const hex = (n: number) => toHex(actor(n));
    expect(await r.blockedCollaborators(R)).toEqual([
      { principal: hex(0x11), units: 2, reasons: ["ACTOR_EQUIVOCATION"] },
      { principal: hex(0x22), units: 1, reasons: ["INVALID_AUTOMERGE_BYTES"] },
    ]);
    expect((await r.newlyBlocked(R)).map((b) => b.principal)).toEqual([hex(0x11), hex(0x22)]);
    expect(await r.newlyBlocked(R)).toEqual([]); // reported once
    // Held for longer than HELD_BLOCKED_MS: now 0x33 counts too.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + HELD_BLOCKED_MS + 1);
      expect((await r.newlyBlocked(R)).map((b) => [b.principal, b.reasons])).toEqual([
        [hex(0x33), ["PREV_MISMATCH"]],
        [hex(0x44), ["PROFILE_HELD"]],
      ]);
    } finally {
      vi.useRealTimers();
    }
    // Not reported again after a restart; this Principal's own units never count.
    await r.stop();
    const again = await start(device, local);
    expect(await again.newlyBlocked(R)).toEqual([]);
    await (again.storage as LfcpStorage).commit([
      {
        op: "put-data-unit",
        unit: { ...unit(5, 0, 9n), actor: status.principalId },
        status: "quarantined",
        detail: "BEYOND_CUTOFF",
      },
    ]);
    expect((await again.blockedCollaborators(R)).map((b) => b.principal)).not.toContain(
      toHex(status.principalId),
    );
  });

  it("locks, offers a new Principal, and refuses to open Resources while locked", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const installId = local.values.get("openlfcp-install") as string;
    await r.stop();
    await deleteDatabase(databaseName(installId));
    const locked = await start(device, local);
    expect(locked.status).toMatchObject({ kind: "locked", reason: "database-missing" });
    expect((await locked.registry()).length).toBe(0);
    await locked.createNewPrincipal();
    const now = locked.status;
    expect(now.kind).toBe("ready");
    if (now.kind === "ready") expect(toHex(now.principalId)).not.toBe(toHex(status.principalId));
  });

  it("reports a second instance of the same vault as locked", async () => {
    const device = new Device();
    const local = new FakeLocal();
    await start(device, local);
    const second = await start(device, local);
    expect(second.status).toMatchObject({ kind: "locked", reason: "lock-held" });
    await expect(second.createNewPrincipal()).rejects.toThrow();
  });
});
