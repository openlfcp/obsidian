// E-022d1 review r1: an attempt of "Connect Apple Reminders" across a
// crash or a refused cancel. (1) after a restart only the request the
// person said [Yes] to is approved; (2) an approval the SDK journaled
// before a crash is resumed, also once J is consumed; (3) a J made but not
// journaled in the attempt is found again and revoked by a cancel; (4) a
// cancel not finished blocks any approval.

import { OperationJournal, type PairingReview } from "@openlfcp/client";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
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
    flows: { pairingRequests, cancelPairing, openPairingSessions: async () => [] },
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
    intent: { session: "another", requestKey: "p:mac" },
  });
  await journal.begin({
    id: "mine",
    kind: "pairing-approval",
    createdAt: 0,
    intent: { session: "session", requestKey: "p:mac" },
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
