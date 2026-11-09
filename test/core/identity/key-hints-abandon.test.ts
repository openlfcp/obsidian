// Design 419 (a) and (c), decision I31 (Shared Tasks 0.7.4, sdk-ts 0.5.2):
// the device upkeep on the SDK's own flows over the in-memory coordinator.
//
// (a) A device that lacks a key it should hold (its package lost after the
//     ledger recorded it, its DEK gone) asks for it in its device list; the
//     managing device's next ordinary upkeep sends it again; the device
//     clears its hint. A Read device cannot ask: "Send keys again" on the
//     managing device sends it.
// (c) A key change whose new key the server refuses every time can be
//     given up ("Stop trying"): no longer retried nor listed as owed, shown
//     under "Given up"; "Try again" hands it on once the server takes it.

import {
  deliverKeys,
  heldDeks,
  OperationJournal,
  PackageLedger,
  rotateAfter,
  syncChain,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { dekSecretRef } from "@openlfcp/storage";
import { parseKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const ctxOf = (i: Installation) => {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  return ctx;
};
const me = (i: Installation) => toHex(ctxOf(i).principal.id);
const hasKey = (X: ResourceId, recipient: string, epoch: bigint) =>
  world.server.packagesOf(X).some((p) => toHex(p.recipient) === recipient && p.dataEpoch === epoch);
const epochOf = (X: ResourceId) => world.server.chain(X).state.epoch.epoch;

/** `who` loses its key of X's current epoch: the server's package and its own DEK. */
async function loseKey(who: Installation, X: ResourceId): Promise<bigint> {
  const epoch = epochOf(X);
  const h = world.server.hosted.get(toHex(X));
  if (h === undefined) throw new Error("not hosted");
  h.packages = h.packages.filter((b) => toHex(parseKeyPackage(b).payload.recipient) !== me(who));
  await ctxOf(who).secrets.delete(dekSecretRef(X, epoch));
  expect(hasKey(X, me(who), epoch)).toBe(false);
  return epoch;
}

const kinds = async (i: Installation) => (await i.service.unfinished()).map((u) => u.kind);

it("(a) a Full device asks for a lost key; the managing device's next upkeep sends it again", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  const epoch = await loseKey(b, X);
  // B's upkeep: the package is not on the server either; B writes its hint.
  await b.service.upkeep();
  const wait = (await b.service.unfinished()).find((u) => u.kind === "key-wait");
  expect(wait?.sections).toEqual(["Plans"]);
  expect(wait?.refusal).toBeUndefined();
  // A lists the request, and its next ordinary upkeep sends the key again.
  await a.service.upkeep();
  expect(hasKey(X, me(b), epoch)).toBe(true);
  // B gets it and clears its hint.
  await b.service.upkeep();
  expect(await kinds(b)).not.toContain("key-wait");
  expect((await heldDeks(ctxOf(b).secrets, world.server.chain(X))).has(String(epoch))).toBe(true);
  // Nothing more is asked for: A's next upkeep lists no request.
  await a.service.upkeep();
  expect(await kinds(a)).not.toContain("key-request");
});

it("(a) a Read device cannot ask; Send keys again on the managing device sends its key", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  await c.service.progress(await pair(a, c, "read"));
  await a.service.upkeep(true);
  const epoch = await loseKey(c, X);
  await c.service.upkeep();
  const wait = (await c.service.unfinished()).find((u) => u.kind === "key-wait");
  expect(wait?.refusal).toBe("not-a-writer");
  // A's ordinary upkeep cannot know (no hint, its ledger says sent): nothing is sent.
  await a.service.upkeep();
  expect(hasKey(X, me(c), epoch)).toBe(false);
  expect(await a.service.resendKeys(me(c), "Phone")).toMatch(
    /^Sent the keys of \d+ sections? to Phone\.$/,
  );
  expect(hasKey(X, me(c), epoch)).toBe(true);
});

/** A owns X, shared with another person P; A's key change of X is committed, P's package refused. */
async function refusedKeyChange() {
  world = new DeviceWorld();
  const a = await world.installation();
  const p = await world.installation();
  const X = await a.section("Plans");
  const actx = ctxOf(a);
  const channel = await world.server.network().connect(actx.principal.signer, WORLD_URL);
  const x0 = await syncChain(actx.storage, channel, X);
  const grant = signControlRecord(
    { resourceId: X, controlSeq: x0.state.seq + 1n, prevControlId: x0.state.head },
    {
      type: "CAPABILITY_GRANT",
      subject: ctxOf(p).principal.signer.descriptor,
      abilities: [1n, 2n],
      delegable: [],
    },
    actx.principal.signer,
  ).bytes;
  expect((await channel.putControl(X, x0.state.head, grant)).kind).toBe("ack");
  const x1 = await syncChain(actx.storage, channel, X);
  await deliverKeys({
    channel,
    ledger: new PackageLedger(actx.storage),
    chain: x1,
    sender: actx.principal.signer,
    recipients: [ctxOf(p).principal.signer.descriptor],
    deks: await heldDeks(actx.secrets, x1),
  });
  let refusing = true;
  world.server.fault = (e) =>
    refusing &&
    e.op === "key-package" &&
    toHex(parseKeyPackage(e.bytes).payload.recipient) === me(p)
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const operation = "rotate.refused";
  await new OperationJournal(actx.storage).begin({
    id: operation,
    kind: "rotate",
    createdAt: 1,
    intent: {},
  });
  const x2 = await syncChain(actx.storage, channel, X);
  await rotateAfter({
    installation: { signer: actx.principal.signer, agreement: actx.principal.agreement },
    storage: actx.storage,
    secrets: actx.secrets,
    network: world.server.network(),
    now: actx.now,
    channel,
    operation,
    resource: X,
    revokedAt: x2.state.seq,
  });
  channel.close();
  return {
    a,
    p,
    X,
    operation,
    epoch: epochOf(X),
    lift: () => {
      refusing = false;
    },
  };
}

const packagesTo = (X: ResourceId, who: string, from: number) =>
  world.server.uploads
    .slice(from)
    .filter(
      (e) =>
        e.op === "key-package" &&
        toHex(e.resource) === toHex(X) &&
        toHex(parseKeyPackage(e.bytes).payload.recipient) === who,
    ).length;

it("(c) Stop trying: a refused key change is no longer retried; Try again hands it on", async () => {
  const { a, p, X, operation, epoch, lift } = await refusedKeyChange();
  // The upkeep tries again and is refused again: listed with its refusal.
  await a.service.upkeep();
  const refused = (await a.service.unfinished()).find((u) => u.kind === "refused-handover");
  expect(refused).toMatchObject({ operation, resource: toHex(X), refusal: "QUOTA_EXCEEDED" });
  expect(await a.service.stopTrying(operation, toHex(X))).toBe(
    'Stopped sending the new key of "Plans". You can try again later from Given up.',
  );
  // The next upkeeps send nothing for it, and list it under Given up.
  const from = world.server.uploads.length;
  await a.service.upkeep();
  await a.service.upkeep();
  expect(packagesTo(X, me(p), from)).toBe(0);
  const listed = await kinds(a);
  expect(listed).toContain("given-up");
  expect(listed).not.toContain("refused-handover");
  expect(listed).not.toContain("handover");
  // Try again, the server now takes it: handed on, nothing left.
  lift();
  await a.service.tryAgain(operation, toHex(X));
  await a.service.upkeep();
  expect(hasKey(X, me(p), epoch)).toBe(true);
  const after = await kinds(a);
  expect(after).not.toContain("given-up");
  expect(after).not.toContain("refused-handover");
});

// Review 419 round 2: the reviewer's probes A1, A2 and A3, the serialization of
// Stop trying with the upkeep (P3-1), and the own-root case of (c).

/** The SDK flows, counted per name (and in order: `log`). */
function counted() {
  const calls: Record<string, number> = {};
  const log: string[] = [];
  const wrap = <K extends keyof typeof SDK_IDENTITY_FLOWS>(k: K) => {
    const f = SDK_IDENTITY_FLOWS[k] as unknown as (...a: unknown[]) => Promise<unknown>;
    return (async (...a: unknown[]) => {
      calls[k] = (calls[k] ?? 0) + 1;
      log.push(`${k}:start`);
      try {
        return await f(...a);
      } finally {
        log.push(`${k}:end`);
      }
    }) as unknown as (typeof SDK_IDENTITY_FLOWS)[K];
  };
  return {
    calls,
    log,
    flows: {
      reconcileDevices: wrap("reconcileDevices"),
      setKeyHints: wrap("setKeyHints"),
      resumeRotations: wrap("resumeRotations"),
      abandonDelivery: wrap("abandonDelivery"),
    },
  };
}

const uploadsTo = (who: string, from: number) =>
  world.server.uploads
    .slice(from)
    .filter(
      (e) => e.op === "key-package" && toHex(parseKeyPackage(e.bytes).payload.recipient) === who,
    ).length;

it("A1: a hint whose device stays offline is answered once: the next upkeep neither reconciles nor uploads", async () => {
  world = new DeviceWorld();
  const ca = counted();
  const a = await world.installation(ca.flows);
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  await loseKey(b, X);
  await b.service.upkeep(); // B writes its hint, then never runs again.
  let r0 = ca.calls.reconcileDevices ?? 0;
  let from = world.server.uploads.length;
  await a.service.upkeep();
  expect((ca.calls.reconcileDevices ?? 0) - r0).toBe(1);
  expect(uploadsTo(me(b), from)).toBe(1);
  for (let i = 0; i < 3; i++) {
    r0 = ca.calls.reconcileDevices ?? 0;
    from = world.server.uploads.length;
    await a.service.upkeep();
    expect((ca.calls.reconcileDevices ?? 0) - r0).toBe(0);
    expect(uploadsTo(me(b), from)).toBe(0);
  }
  expect(world.server.packagesOf(X).filter((p) => toHex(p.recipient) === me(b)).length).toBe(1);
  // Still shown: B asks, and was answered.
  expect(await kinds(a)).toContain("key-request");
});

it("A2: a package the server refuses for good: the hint makes the upkeep reconcile once, not every time", async () => {
  world = new DeviceWorld();
  const ca = counted();
  const a = await world.installation(ca.flows);
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  await loseKey(b, X);
  world.server.fault = (e) =>
    e.op === "key-package" && toHex(parseKeyPackage(e.bytes).payload.recipient) === me(b)
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const rounds: number[] = [];
  for (let i = 0; i < 3; i++) {
    await b.service.upkeep();
    const r0 = ca.calls.reconcileDevices ?? 0;
    await a.service.upkeep();
    rounds.push((ca.calls.reconcileDevices ?? 0) - r0);
  }
  expect(rounds).toEqual([1, 0, 0]);
});

it("A3: a Read device asks once; the answer stands until what it lacks changes", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const cc = counted();
  const c = await world.installation(cc.flows);
  const X = await a.section("Plans");
  await c.service.progress(await pair(a, c, "read"));
  await a.service.upkeep(true);
  await loseKey(c, X);
  const s0 = cc.calls.setKeyHints ?? 0;
  for (let i = 0; i < 3; i++) await c.service.upkeep();
  expect((cc.calls.setKeyHints ?? 0) - s0).toBe(1);
  expect((await c.service.unfinished()).find((u) => u.kind === "key-wait")?.refusal).toBe(
    "not-a-writer",
  );
});

it("P3-1: Stop trying waits for an upkeep in flight; the delivery stays given up", async () => {
  const { a, X, operation } = await refusedKeyChange();
  const ca = counted();
  // The same installation's service, with counted flows (one upkeep queue per service).
  const { DeviceService } = await import("../../../src/core/identity/service");
  const { sleep } = await import("../../support/lfcp-env");
  const service = new DeviceService({
    runtime: () => a.runtime,
    context: () => a.runtime.collaborationContext(),
    collab: () => a.collab,
    defaultServer: () => WORLD_URL,
    platform: "desktop",
    sections: true,
    sleep,
    pacing: null,
    flows: {
      ...SDK_IDENTITY_FLOWS,
      connectionNetwork: () => world.server.network(),
      ...ca.flows,
    },
  });
  await service.upkeep(); // records the refusal
  const upkeep = service.upkeep();
  const stop = service.stopTrying(operation, toHex(X));
  await Promise.all([upkeep, stop]);
  expect(await stop).toMatch(/^Stopped sending/);
  // abandonDelivery ran after the upkeep's resumeRotations, never during it.
  const lastResumeEnd = ca.log.lastIndexOf("resumeRotations:end");
  expect(ca.log.indexOf("abandonDelivery:start")).toBeGreaterThan(lastResumeEnd);
  const listed = (await service.unfinished()).map((u) => u.kind);
  expect(listed).toContain("given-up");
  expect(listed).not.toContain("refused-handover");
});

it("(c) own-root: after Stop trying, the upkeep no longer forces a reconciliation; a forced one still tries", async () => {
  world = new DeviceWorld();
  const ca = counted();
  const a = await world.installation(ca.flows);
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  // A changes X's key; the server refuses B's new key, every time.
  world.server.fault = (e) =>
    e.op === "key-package" && toHex(parseKeyPackage(e.bytes).payload.recipient) === me(b)
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const actx = ctxOf(a);
  const operation = "rotate.own";
  await new OperationJournal(actx.storage).begin({
    id: operation,
    kind: "rotate",
    createdAt: 1,
    intent: {},
  });
  const channel = await world.server.network().connect(actx.principal.signer, WORLD_URL);
  const x = await syncChain(actx.storage, channel, X);
  await rotateAfter({
    installation: { signer: actx.principal.signer, agreement: actx.principal.agreement },
    storage: actx.storage,
    secrets: actx.secrets,
    network: world.server.network(),
    now: actx.now,
    channel,
    operation,
    resource: X,
    revokedAt: x.state.seq,
  });
  channel.close();
  // B (own root) lacks the new key: each upkeep reconciles for it.
  let r0 = ca.calls.reconcileDevices ?? 0;
  await a.service.upkeep();
  await a.service.upkeep();
  expect((ca.calls.reconcileDevices ?? 0) - r0).toBe(2);
  expect(await a.service.stopTrying(operation, toHex(X))).toMatch(/^Stopped sending/);
  r0 = ca.calls.reconcileDevices ?? 0;
  await a.service.upkeep();
  await a.service.upkeep();
  expect((ca.calls.reconcileDevices ?? 0) - r0).toBe(0);
  // A forced upkeep still reconciles, and §7.1 step 3 still tries B's key.
  const from = world.server.uploads.length;
  await a.service.upkeep(true);
  expect(uploadsTo(me(b), from)).toBeGreaterThan(0);
});

// Review 418r2 R2: a transient answer to the hint write is retried; a standing one is asked
// again once the device list's authority changes.
it("R2: one RATE_LIMITED hint write, then recovery: a later upkeep writes the hint and the key comes back", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const cb = counted();
  const b = await world.installation(cb.flows);
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  const I = await b.service.identity();
  if (I === undefined) throw new Error("no device list");
  const epoch = await loseKey(b, X);
  // The server refuses B's first unit in the device list (the hint) with RATE_LIMITED.
  let refuse = true;
  world.server.fault = (e) => {
    if (refuse && e.op === "data-unit" && toHex(e.resource) === toHex(I)) {
      refuse = false;
      return { nack: "RATE_LIMITED" };
    }
    return undefined;
  };
  await b.service.upkeep();
  expect(cb.calls.setKeyHints).toBe(1);
  // Within the backoff, an ordinary upkeep does not ask again.
  await b.service.upkeep();
  expect(cb.calls.setKeyHints).toBe(1);
  // Later (past the backoff), it does, and the hint is written.
  const real = Date.now.bind(Date);
  const later = vi.spyOn(Date, "now").mockImplementation(() => real() + 2 * 60 * 60 * 1000);
  try {
    await b.service.upkeep();
  } finally {
    later.mockRestore();
  }
  expect(cb.calls.setKeyHints).toBe(2);
  expect(
    (await b.service.unfinished()).find((u) => u.kind === "key-wait")?.refusal,
  ).toBeUndefined();
  await a.service.upkeep();
  expect(hasKey(X, me(b), epoch)).toBe(true);
});

it("R2: a Read device that cannot ask asks again once the device list's authority changes", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const cc = counted();
  const c = await world.installation(cc.flows);
  const X = await a.section("Plans");
  await c.service.progress(await pair(a, c, "read"));
  await a.service.upkeep(true);
  await loseKey(c, X);
  await c.service.upkeep();
  await c.service.upkeep();
  expect(cc.calls.setKeyHints).toBe(1);
  // The device list's authority changes (a device record: its head moves). A device's own
  // access cannot be widened in place (N8: kind, mask and scope are immutable; I refuses a
  // CAPABILITY_GRANT), so the cached answer is keyed to the head, which any such change moves.
  const d = await world.installation();
  await d.service.progress(await pair(a, d, "read"));
  await c.service.upkeep();
  expect(cc.calls.setKeyHints).toBe(2);
  // Unchanged since: not asked again.
  await c.service.upkeep();
  expect(cc.calls.setKeyHints).toBe(2);
});
