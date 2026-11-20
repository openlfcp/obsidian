// E-022d1 review r1: an attempt of "Connect Apple Reminders" across a
// crash or a refused cancel. (1) after a restart only the request the
// person said [Yes] to is approved; (2) an approval the SDK journaled
// before a crash is resumed, also once J is consumed; (3) a J made but not
// journaled in the attempt is found again and revoked by a cancel; (4) a
// cancel not finished blocks any approval.

import { OperationJournal, type PairingReview, requestPairing } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
import { decodeControlRecord } from "@openlfcp/wire";
import { expect, it, vi } from "vitest";
import { BridgeConnect, type ConnectDeps } from "../../../src/core/identity/connect";
import { type Attempt, connectView } from "../../../src/core/identity/connect-attempt";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { DeviceWorld } from "../../support/device-world";

vi.setConfig({ testTimeout: 30_000 });

const C = "22".repeat(32);
const scope = [Uint8Array.from({ length: 32 }, () => 0x22)];
const request = (requestKey: string, fingerprint: string) =>
  ({ kind: 1, requestedScope: scope, requestKey, fingerprint }) as unknown as PairingReview;
const MAC = request("p:mac", "mac-code");
/** What the SDK journals for the attempt's own approval: kind 1, scope [C], its record in C. */
const OWN_INTENT = {
  session: "session",
  requestKey: "p:mac",
  payload: { kind: 1, scope: [C] },
  approvalRecord: { resource: C, role: "base" },
};
const FOREIGN = request("p:foreign", "foreign-code");

/** A BridgeConnect over substituted flows, its attempt stored in memory. */
function fake(extra: Partial<Attempt> = {}) {
  const storage = new InMemoryLfcpStorage();
  let stored: Attempt = {
    id: "attempt",
    metaAt: "2026-11-20T10:00:00Z",
    vault: "Vault",
    root: "11".repeat(32),
    c: C,
    url: "wss://example",
    session: "session",
    j: "33".repeat(32),
    createdAt: Date.now(),
    state: "committing",
    initialized: true,
    ...extra,
  };
  const approve = vi.fn(async () => ({ kind: "done" as const, message: "" }));
  const finishApproval = vi.fn(async () => ({ kind: "done" as const, message: "" }));
  const pairingRequests = vi.fn(async () => [] as PairingReview[]);
  const cancelPairing = vi.fn(async () => ({ kind: "unavailable", reason: "offline" }) as const);
  const deps = {
    runtime: () => ({
      localState: {
        get: async () => stored,
        put: async (_: string, a: Attempt) => {
          stored = a;
        },
      },
    }),
    flow: () => ({ now: Date.now, storage }),
    flows: {
      pairingRequests,
      cancelPairing,
      openPairingSessions: async () => [],
      resumePairingSession: async () => ({
        kind: "created",
        link: { reveal: () => "lfcp://pair/x" },
      }),
    },
    identity: async () => undefined,
    approve,
    finishApproval,
  } as unknown as ConnectDeps;
  return {
    connect: new BridgeConnect(deps),
    storage,
    approve,
    finishApproval,
    pairingRequests,
    cancelPairing,
  };
}

it("(1) after a restart, approves the request said [Yes] to, never another under J", async () => {
  const p = fake({ confirmed: { requestKey: "p:mac", fingerprint: "mac-code" } });
  // A foreign request listed first: still the confirmed one is approved.
  p.pairingRequests.mockResolvedValue([FOREIGN, MAC]);
  expect((await p.connect.tick())?.state).toBe("registering");
  expect(p.approve).toHaveBeenCalledOnce();
  expect((p.approve.mock.calls[0] as unknown[])[0]).toBe(MAC);
});

it("(1) the confirmed request gone before the consume: its code is compared again, nothing approved", async () => {
  const p = fake({ confirmed: { requestKey: "p:mac", fingerprint: "mac-code" } });
  // Replaced under the same key by another descriptor: another code, not the confirmed one.
  p.pairingRequests.mockResolvedValue([request("p:mac", "other-code")]);
  const a = await p.connect.tick();
  expect(p.approve).not.toHaveBeenCalled();
  expect(a?.state).toBe("confirm-code");
  expect(a?.confirmed).toBeUndefined();
  expect(p.connect.code()).toBe("other-code");
});

it("(2) a crash after A1: the SDK's journaled approval of J is resumed, J consumed", async () => {
  const p = fake({ confirmed: { requestKey: "p:mac", fingerprint: "mac-code" } });
  const journal = new OperationJournal(p.storage);
  // Another session's approval is not this attempt's.
  await journal.begin({
    id: "other",
    kind: "pairing-approval",
    createdAt: 0,
    intent: { ...OWN_INTENT, session: "another" },
  });
  await journal.begin({
    id: "mine",
    kind: "pairing-approval",
    createdAt: 0,
    intent: OWN_INTENT,
  });
  // J consumed: its requests are no longer listed.
  const a = await p.connect.tick();
  expect(p.finishApproval).toHaveBeenCalledWith("mine", "LFCP Bridge");
  expect(p.approve).not.toHaveBeenCalled();
  expect(a?.state).toBe("registering");
  expect(a?.approval).toBe("mine");
});

it("(4) a cancel not finished blocks [Yes]; nothing more is offered until it ends", async () => {
  const p = fake({ state: "confirm-code" });
  p.pairingRequests.mockResolvedValue([MAC]);
  await p.connect.tick();
  expect(p.connect.code()).toBe("mac-code");
  // [Cancel]: the server cannot be reached; the cancel is journaled.
  expect(await p.connect.cancel()).toBe(true);
  const waiting = await p.connect.attempt();
  expect(waiting?.aborting).toBe("cancelled");
  // A [Yes] queued meanwhile approves nothing.
  expect((await p.connect.confirm(true))?.state).toBe("confirm-code");
  expect(p.approve).not.toHaveBeenCalled();
  expect(connectView(waiting)).toEqual({ lines: ["Cancelling the connection…"], actions: [] });
  // The next tick finishes the cancel.
  p.cancelPairing.mockResolvedValue({ kind: "cancelled", rotation: {} } as never);
  const done = await p.connect.tick();
  expect(done?.state).toBe("cancelled");
  expect(done?.aborting).toBeUndefined();
  expect(p.approve).not.toHaveBeenCalled();
});

it("(4) a [No] not finished keeps its request key for the retry", async () => {
  const p = fake({ state: "confirm-code" });
  p.pairingRequests.mockResolvedValue([MAC]);
  await p.connect.tick();
  await p.connect.confirm(false);
  expect((await p.connect.attempt())?.reject).toBe("p:mac");
  p.cancelPairing.mockResolvedValue({ kind: "cancelled", rotation: {} } as never);
  expect((await p.connect.tick())?.state).toBe("rejected");
  expect(p.cancelPairing).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: "session", reject: "p:mac" }),
  );
});

it("(3) J made but not journaled (a crash): found again, its link given, revoked by a cancel", async () => {
  const world = new DeviceWorld();
  try {
    let crash = true;
    const a = await world.installation({
      createPairingSession: async (o) => {
        const made = await SDK_IDENTITY_FLOWS.createPairingSession(o);
        expect(made.kind).toBe("created");
        if (crash) throw new Error("crash after the SDK made J");
        return made;
      },
    });
    await a.section("Plans");
    const connect = a.service.connector();
    await expect(connect.start("Vault")).rejects.toThrow("crash");
    crash = false;
    expect((await connect.attempt())?.session).toBeUndefined();
    const [open] = await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a));
    if (open === undefined) throw new Error("no session made");
    // The link finds J again from the SDK's journal.
    expect(await connect.link()).toMatch(/^lfcp-bridge:\/\/connect\?/);
    expect((await connect.attempt())?.session).toBe(open.session);
    // [Cancel] revokes it: no session of the attempt left open.
    expect(await connect.cancel()).toBe(true);
    expect((await connect.attempt())?.state).toBe("cancelled");
    expect(await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a))).toEqual([]);
  } finally {
    await world.stop();
  }
});

it("(3) a crash before the cancel too: the tick finds J and the cancel revokes it", async () => {
  const world = new DeviceWorld();
  try {
    let crash = true;
    const a = await world.installation({
      createPairingSession: async (o) => {
        const made = await SDK_IDENTITY_FLOWS.createPairingSession(o);
        if (crash) throw new Error("crash after the SDK made J");
        return made;
      },
    });
    await a.section("Plans");
    const connect = a.service.connector();
    await expect(connect.start("Vault")).rejects.toThrow("crash");
    crash = false;
    // The next tick adopts J (no second session is made).
    const t = await connect.tick();
    expect(t?.session).toBeDefined();
    expect(await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a))).toHaveLength(1);
    await connect.cancel();
    expect(await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a))).toEqual([]);
  } finally {
    await world.stop();
  }
});

// Arbiter round 3 (obsidian#121, on ee95b2b).

/** Whether I's chain on the server grants device `hex`. */
const grantedIn = (world: DeviceWorld, I: ResourceId, hex: string) =>
  world.server
    .chain(I)
    .records.map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );

it("round 3, 1a: after a crash once J is made, Add my other device gets its own session, not J", async () => {
  const world = new DeviceWorld();
  try {
    let crash = true;
    const a = await world.installation({
      createPairingSession: async (o) => {
        const made = await SDK_IDENTITY_FLOWS.createPairingSession(o);
        if (crash) throw new Error("crash after the SDK made J");
        return made;
      },
    });
    await a.section("Plans");
    const connect = a.service.connector();
    await expect(connect.start("Vault")).rejects.toThrow("crash");
    crash = false;
    const [J] = await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a));
    if (J === undefined) throw new Error("no J");
    // Before any tick: the personal flow finds J again for the attempt and leaves it out.
    const personal = await a.service.startSession("Desk");
    if (personal.kind !== "link") throw new Error(JSON.stringify(personal));
    expect(personal.session).not.toBe(J.session);
    expect((await connect.tick())?.session).toBe(J.session);
    // [Cancel] revokes J only; the personal session stays open.
    expect(await connect.cancel()).toBe(true);
    const open = (await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a))).map(
      (s) => s.session,
    );
    expect(open).toEqual([personal.session]);
  } finally {
    await world.stop();
  }
});

it("round 3, 1b: J spent by a personal approval ends the attempt, C archived, a new one can start", async () => {
  const world = new DeviceWorld();
  try {
    const a = await world.installation();
    const phone = await world.installation();
    await a.section("Plans");
    const connect = a.service.connector();
    const attempt = await connect.start("Vault");
    const link = await connect.link();
    if (link === null || attempt.session === undefined) throw new Error("no link");
    // A personal device asks under J and this device approves it: J is consumed by that.
    const asked = await requestPairing({
      ...world.flowOf(phone),
      link: decodeURIComponent(link.split("#link=")[1] ?? ""),
      label: "Phone",
      kind: 0,
    });
    if (asked.kind !== "requested") throw new Error(JSON.stringify(asked));
    const reviews = await a.service.requests(attempt.session);
    const review = Array.isArray(reviews) ? reviews[0] : undefined;
    if (review === undefined) throw new Error(JSON.stringify(reviews));
    expect((await a.service.approve(review, "full")).kind).toBe("done");
    // [Cancel] finds J consumed by an approval that is not the attempt's: the attempt ends.
    expect(await connect.cancel()).toBe(true);
    const ended = await connect.attempt();
    expect(ended?.state).toBe("cancelled");
    expect(ended?.approval).toBeUndefined();
    // C archived in the roster: the attempt's archive phase is done.
    const archived = await new OperationJournal(world.flowOf(a).storage).get(
      `archive-control.${attempt.id}`,
    );
    expect(archived?.status).toBe("done");
    const next = await connect.start("Vault");
    expect(next.state).toBe("waiting-app");
    expect(next.id).not.toBe(attempt.id);
  } finally {
    await world.stop();
  }
});

it("round 3, 1c: Add my other device makes no session while the attempt makes J", async () => {
  const world = new DeviceWorld();
  try {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    let first = true;
    const a = await world.installation({
      createPairingSession: async (o) => {
        const mine = first;
        first = false;
        calls.push(mine ? "attempt:start" : "other");
        if (mine) await gate;
        const made = await SDK_IDENTITY_FLOWS.createPairingSession(o);
        if (mine) calls.push("attempt:done");
        return made;
      },
    });
    await a.section("Plans");
    const connect = a.service.connector();
    const started = connect.start("Vault");
    await vi.waitFor(() => expect(calls).toEqual(["attempt:start"]));
    const personal = a.service.startSession("Desk");
    // Nothing else is made while J is.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(["attempt:start"]);
    release();
    const attempt = await started;
    const view = await personal;
    expect(calls).toEqual(["attempt:start", "attempt:done", "other"]);
    if (view.kind !== "link") throw new Error(JSON.stringify(view));
    expect(attempt.session).toBeDefined();
    expect(view.session).not.toBe(attempt.session);
  } finally {
    await world.stop();
  }
});

it("round 3, 2: J's creation the server did not finish is carried on by the tick, no link() needed", async () => {
  const world = new DeviceWorld();
  try {
    let losing = false;
    const a = await world.installation({
      createPairingSession: async (o) => {
        losing = true;
        try {
          return await SDK_IDENTITY_FLOWS.createPairingSession(o);
        } finally {
          losing = false;
        }
      },
    });
    // The DEVICE_GRANT of J in I is lost on its way while J is made.
    world.server.fault = (e) => (losing && e.op === "control" ? "drop-request" : undefined);
    await a.section("Plans");
    const connect = a.service.connector();
    const attempt = await connect.start("Vault");
    const I = await a.service.identity();
    if (I === undefined || attempt.session === undefined || attempt.j === undefined)
      throw new Error(JSON.stringify(attempt));
    expect(grantedIn(world, I, attempt.j)).toBe(false);
    // The connection is back: the tick alone finishes J's creation.
    world.server.fault = () => undefined;
    await connect.tick();
    expect(grantedIn(world, I, attempt.j)).toBe(true);
  } finally {
    await world.stop();
  }
});

it("round 3, 3: requests not readable keep [Yes]: still committing, no cancel; then the confirmed one", async () => {
  const p = fake({ confirmed: { requestKey: "p:mac", fingerprint: "mac-code" } });
  p.pairingRequests.mockRejectedValue(new Error("offline"));
  const a = await p.connect.tick();
  expect(a?.state).toBe("committing");
  expect(a?.confirmed).toEqual({ requestKey: "p:mac", fingerprint: "mac-code" });
  expect(await p.connect.cancel()).toBe(false);
  expect(p.approve).not.toHaveBeenCalled();
  p.pairingRequests.mockResolvedValue([FOREIGN, MAC]);
  expect((await p.connect.tick())?.state).toBe("registering");
  expect((p.approve.mock.calls[0] as unknown[])[0]).toBe(MAC);
});
