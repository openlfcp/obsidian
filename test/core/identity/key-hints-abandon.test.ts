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
