// Review of task 416, finding R1 (Shared Tasks 0.7.3, sdk-ts 0.5.1): a
// section whose server refuses this device's read (unhosted, read access
// revoked) does not stop the upkeep from handing on what other key changes
// still owe. The device upkeep on the SDK's own flows over the in-memory
// coordinator, run twice: Y's new key reaches another person without
// another key change; X stays owed and is reported with its refusal.

import {
  deliverKeys,
  heldDeks,
  IdentityUnavailable,
  OperationJournal,
  outstandingDeliveries,
  PackageLedger,
  rotateAfter,
  syncChain,
} from "@openlfcp/client";
import { type ControlRecordId, type ResourceId, toHex } from "@openlfcp/core";
import { parseKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, type Installation, WORLD_URL } from "../../support/device-world";

vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const ctxOf = (i: Installation) => {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  return ctx;
};
const me = (i: Installation) => toHex(ctxOf(i).principal.id);
const flowOf = (i: Installation) => {
  const ctx = ctxOf(i);
  return {
    installation: { signer: ctx.principal.signer, agreement: ctx.principal.agreement },
    storage: ctx.storage,
    secrets: ctx.secrets,
    network: world.server.network(),
    now: ctx.now,
  };
};
const hasKey = (X: ResourceId, recipient: string, epoch: bigint) =>
  world.server.packagesOf(X).some((p) => toHex(p.recipient) === recipient && p.dataEpoch === epoch);

/** `owner` grants `subject` `abilities` on R and seals R's keys to it; the grant's record ID. */
async function share(
  owner: Installation,
  R: ResourceId,
  subject: Installation,
  abilities: bigint[],
): Promise<ControlRecordId> {
  const o = ctxOf(owner);
  const channel = await world.server.network().connect(o.principal.signer, WORLD_URL);
  const x0 = await syncChain(o.storage, channel, R);
  const grant = signControlRecord(
    { resourceId: R, controlSeq: x0.state.seq + 1n, prevControlId: x0.state.head },
    {
      type: "CAPABILITY_GRANT",
      subject: ctxOf(subject).principal.signer.descriptor,
      abilities,
      delegable: [],
    },
    o.principal.signer,
  );
  expect((await channel.putControl(R, x0.state.head, grant.bytes)).kind).toBe("ack");
  const x1 = await syncChain(o.storage, channel, R);
  await deliverKeys({
    channel,
    ledger: new PackageLedger(o.storage),
    chain: x1,
    sender: o.principal.signer,
    recipients: [ctxOf(subject).principal.signer.descriptor],
    deks: await heldDeks(o.secrets, x1),
  });
  return grant.recordId;
}

/** `i` changes R's key under operation `operation`; the new key to `owed` (hex) is not sent. */
async function owedRotation(
  i: Installation,
  R: ResourceId,
  operation: string,
  owed: string,
): Promise<bigint> {
  const flow = flowOf(i);
  await new OperationJournal(flow.storage).begin({
    id: operation,
    kind: "rotate",
    createdAt: 1,
    intent: {},
  });
  world.server.fault = (e) =>
    e.op === "key-package" &&
    toHex(e.resource) === toHex(R) &&
    toHex(parseKeyPackage(e.bytes).payload.recipient) === owed
      ? "drop-request"
      : undefined;
  const channel = await flow.network.connect(flow.installation.signer, WORLD_URL);
  const chain = await syncChain(flow.storage, channel, R);
  await expect(
    rotateAfter({ ...flow, channel, operation, resource: R, revokedAt: chain.state.seq }),
  ).rejects.toThrow(IdentityUnavailable);
  world.server.fault = () => undefined;
  return world.server.chain(R).state.epoch.epoch;
}

for (const how of ["unhosted", "read access revoked"] as const)
  it(`R1: X ${how}: the upkeep still hands Y's new key to another person, and reports X`, async () => {
    world = new DeviceWorld();
    const a = await world.installation();
    const p = await world.installation(); // another person
    const z = await world.installation(); // another person who owns X when A's access is revoked
    let X: ResourceId;
    let grant: ControlRecordId | undefined;
    let xOwed: string;
    if (how === "unhosted") {
      X = await a.section("Old plans");
      await share(a, X, p, [1n, 2n]);
      xOwed = me(p);
    } else {
      X = await z.section("Their plans");
      grant = await share(z, X, a, [1n, 2n, 6n, 7n]);
      xOwed = me(z);
    }
    const Y = await a.section("Plans");
    await share(a, Y, p, [1n, 2n]);
    // X's key change first in the journal, then Y's: neither new key handed on yet.
    await owedRotation(a, X, "rotate.0-x", xOwed);
    const yEpoch = await owedRotation(a, Y, "rotate.1-y", me(p));
    const yEpochs = world.server.chain(Y).state.epochs.size;
    // X's server now refuses A's reads with a NACK.
    if (how === "unhosted") world.server.hosted.delete(toHex(X));
    else {
      const zc = ctxOf(z);
      const channel = await world.server.network().connect(zc.principal.signer, WORLD_URL);
      const x = await syncChain(zc.storage, channel, X);
      const revoke = signControlRecord(
        { resourceId: X, controlSeq: x.state.seq + 1n, prevControlId: x.state.head },
        { type: "CAPABILITY_REVOKE", grantId: grant as ControlRecordId },
        zc.principal.signer,
      );
      expect((await channel.putControl(X, x.state.head, revoke.bytes)).kind).toBe("ack");
    }
    const code = how === "unhosted" ? "RESOURCE_NOT_HOSTED" : "AUTHORIZATION_FAILED";
    for (let run = 0; run < 2; run++) {
      const r = await a.service.upkeep();
      expect(hasKey(Y, me(p), yEpoch)).toBe(true);
      expect(world.server.chain(Y).state.epochs.size).toBe(yEpochs);
      expect(r.issues).toContainEqual({ resource: toHex(X), kind: "refused", detail: code });
      expect(r.issues.filter((i) => i.resource === toHex(Y))).toEqual([]);
      const owed = await outstandingDeliveries(flowOf(a));
      expect(owed.map((o) => toHex(o.resource))).toEqual([toHex(X)]);
      expect(owed[0]?.recipients).toEqual([xOwed]);
    }
    // Y's handover is done; X's stays listed.
    const handover = (await a.service.unfinished()).filter((u) => u.kind === "handover");
    expect(handover.flatMap((u) => u.sections)).not.toContain("Plans");
    expect(handover.length).toBeGreaterThan(0);
  });
