// The runtime's session pool: one SyncClient per endpoint, each with its
// own OutboundQueue (a queue holds one server's READY limits and the
// messages in flight on one connection).

import { dataEpoch, generateResourceId } from "@openlfcp/core";
import {
  dekCommitment,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
} from "@openlfcp/crypto";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  principalDescriptorFromKeys,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Device, FakeLocal } from "../../support/lfcp-env";

const queues: unknown[] = [];
vi.mock("@openlfcp/client", async (original) => {
  const actual = await original<typeof import("@openlfcp/client")>();
  class RecordingSyncClient extends actual.SyncClient {
    constructor(options: ConstructorParameters<typeof actual.SyncClient>[0]) {
      queues.push(options.outbound);
      super(options);
    }
  }
  return { ...actual, SyncClient: RecordingSyncClient };
});

const { saveControlChain } = await import("@openlfcp/client");
const { LfcpRuntime } = await import("../../../src/core/lfcp/runtime");

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function storeResource(storage: LfcpStorage, url: string) {
  const key = generateSigningKeyPair();
  const owner = { key, descriptor: principalDescriptorFromKeys(key, generateAgreementKeyPair()) };
  const R = generateResourceId();
  const genesis = signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: PROFILE_ID,
      owner: owner.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), generateResourceDEK()),
      endpoints: [{ url, priority: 0n }],
      coordinatorUrl: url,
    },
    owner,
  );
  const chain = validateControlChain([genesis.bytes]);
  if (chain.kind !== "linear") throw new Error(chain.kind);
  expect((await saveControlChain(storage, chain, null)).ok).toBe(true);
  await storage.commit([
    {
      op: "put-resource",
      row: { resourceId: R, dataProfile: PROFILE_ID, localPrincipal: null, labels: {} },
    },
  ]);
  return R;
}

describe("LfcpRuntime session pool", () => {
  it("gives every server session its own outbound queue", async () => {
    const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(r);
    const storage = r.storage as LfcpStorage;
    const a = await storeResource(storage, "wss://a.example.invalid/v1/ws");
    const b = await storeResource(storage, "wss://b.example.invalid/v1/ws");
    const a2 = await storeResource(storage, "wss://a.example.invalid/v1/ws");
    for (const R of [a, b, a2]) await r.openResource(R);
    expect(r.sessions).toBe(2);
    expect(queues).toHaveLength(2);
    expect(queues[0]).not.toBe(queues[1]);
  });
});
