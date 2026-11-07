// LFCP-04-414 (review obsidian#108 R6): the race of 1ba1f5a, made certain.
// A section's session loads its stored chain, receives a new Control Record
// (a DEVICE_GRANT, as an approval writes), and saves it with a compare-and-
// swap on the head it loaded. Here another writer (the device flow) saves
// the same chain just before that save, every time: the session's save is
// refused ("the stored Control Head moved during sync"). The runtime opens
// the session again from the stored chain: it reaches LIVE once more, with
// the same profile and the same pending change, after exactly one reopen.
// Without that reopen the section stays in CONTROL_SYNC.

import { leafPayload, loadControlChain, signChain } from "@openlfcp/client";
import { generateObjectId, toHex } from "@openlfcp/core";
import { generateAgreementKeyPair, generateSigningKeyPair } from "@openlfcp/crypto";
import type { StorageWrite } from "@openlfcp/storage";
import { principalDescriptorFromKeys, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { ScriptedServer, SCRIPTED_URL as URL } from "../../support/scripted-server";

let runtime: LfcpRuntime | undefined;
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

it("a session whose save of a pushed record loses to another writer opens again and goes LIVE", async () => {
  let records: Uint8Array[] = [];
  const server = new ScriptedServer(() => records);
  const r = await LfcpRuntime.start(
    new Device().env(new FakeLocal(), { webSocket: server.factory }),
  );
  runtime = r;
  const R = await r.createSectionResource({ name: "Plans", endpoints: [URL], coordinatorUrl: URL });
  const ctx = r.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const stored = await loadControlChain(ctx.storage, R);
  if (stored?.kind !== "linear") throw new Error("no chain");
  const signer = ctx.principal.signer;
  const root = signer.descriptor.principalId;
  // The server holds a DEVICE_GRANT past the stored head: the approval of a device.
  const device = principalDescriptorFromKeys(generateSigningKeyPair(), generateAgreementKeyPair());
  records = [
    signControlRecord(
      { resourceId: R, controlSeq: 1n, prevControlId: stored.state.head },
      {
        type: "DEVICE_GRANT",
        root,
        chain: signChain(stored.state, signer, leafPayload(root, device, 0, [1n, 2n], [])),
      },
      signer,
    ).bytes,
  ];
  // The other writer: the first save of that chain is made twice, the first time
  // as the device flow's own; the session's save then finds the head moved.
  const commit = ctx.storage.commit.bind(ctx.storage);
  let races = 0;
  ctx.storage.commit = async (writes: readonly StorageWrite[]) => {
    if (
      races === 0 &&
      writes.some((w) => w.op === "set-control-head" && w.head.controlSeq === 1n)
    ) {
      races++;
      const flow = await commit(writes);
      if (!flow.ok) throw new Error("the other writer's save failed");
    }
    return commit(writes);
  };
  const errors: string[] = [];
  r.on((e) => {
    if (e.type === "error") errors.push(e.code);
  });
  // A pending change, made before the race: it must survive the reopen as it is.
  await r.commitSection(
    R,
    [{ intent: "section.create", sectionId: generateObjectId(), title: "Plans", createdBy: root }],
    { operationId: "pending" },
  );
  const profile = r.sectionProfile(R);
  const pending = (await ctx.storage.outbound.list(R)).map((x) => [
    toHex(x.itemId),
    toHex(x.bytes),
  ]);
  expect(pending.length).toBeGreaterThan(0);
  const deadline = Date.now() + 5000;
  while (r.phase(R) !== "LIVE" && Date.now() < deadline) await sleep(10);
  await sleep(100);
  // The race happened, once, and was recovered from by exactly one reopen.
  expect(races).toBe(1);
  expect(errors).toEqual(["CONTROL_HEAD_MISMATCH"]);
  expect(r.phase(R)).toBe("LIVE");
  expect(server.received.filter((t) => t === "RESOURCE_OPEN")).toHaveLength(2);
  const head = await loadControlChain(ctx.storage, R);
  expect(head?.kind === "linear" ? head.state.seq : null).toBe(1n);
  // Nothing of the section was lost: the same profile, the same pending bytes.
  expect(r.sectionProfile(R)).toBe(profile);
  expect(
    (await ctx.storage.outbound.list(R)).map((x) => [toHex(x.itemId), toHex(x.bytes)]),
  ).toEqual(pending);
}, 15_000);
