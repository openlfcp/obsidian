// The runtime's session pool: one SyncClient per endpoint, each with its
// own OutboundQueue (a queue holds one server's READY limits and the
// messages in flight on one connection), and how the runtime reacts to a
// session's events (ENGINE_TRAP → needs-restart).

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
/** The options of every OutboundQueue the runtime constructs. */
const queueOptions: unknown[] = [];
/** Each session's event listeners, to deliver events as the session would. */
const listeners: ((event: unknown) => void)[][] = [];
vi.mock("@openlfcp/client", async (original) => {
  const actual = await original<typeof import("@openlfcp/client")>();
  class RecordingSyncClient extends actual.SyncClient {
    readonly heard: ((event: unknown) => void)[] = [];
    constructor(options: ConstructorParameters<typeof actual.SyncClient>[0]) {
      queues.push(options.outbound);
      super(options);
      listeners.push(this.heard);
    }
    override on(listener: Parameters<InstanceType<typeof actual.SyncClient>["on"]>[0]) {
      this.heard.push(listener as (event: unknown) => void);
      return super.on(listener);
    }
  }
  class RecordingOutboundQueue extends actual.OutboundQueue {
    constructor(options: ConstructorParameters<typeof actual.OutboundQueue>[0]) {
      queueOptions.push(options);
      super(options);
    }
  }
  return { ...actual, SyncClient: RecordingSyncClient, OutboundQueue: RecordingOutboundQueue };
});

const { saveControlChain } = await import("@openlfcp/client");
const { LfcpRuntime, NEEDS_RESTART } = await import("../../../src/core/lfcp/runtime");

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

  it("retries an unanswered send after 4 s, doubling up to 60 s", async () => {
    queueOptions.length = 0;
    const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(r);
    const storage = r.storage as LfcpStorage;
    const a = await storeResource(storage, "wss://a.example.invalid/v1/ws");
    await r.openResource(a); // the session's queue
    await r.cutOwnObjects(a); // the storage-only queue that discards stale items
    expect(queueOptions).toHaveLength(2);
    for (const options of queueOptions)
      expect(options).toMatchObject({ requestTimeout: { baseMs: 4000, maxMs: 60_000 } });
  });

  it("a Resource's transport is what its session reported, never guessed (LFCP-03-005)", async () => {
    listeners.length = 0;
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    const storage = r.storage as LfcpStorage;
    const a = await storeResource(storage, "wss://a.example.invalid/v1/ws");
    const local = await storeResource(storage, "wss://b.example.invalid/v1/ws");
    // Not opened: no session, no evidence.
    expect(r.transport(local)).toEqual({ state: "none", cause: null });
    // Each attempt on the offline socket errors before READY: the SDK reports it DISCONNECTED.
    const failed = async () => {
      for (let i = 0; i < 50 && r.transport(a).state !== "failed"; i++)
        await new Promise((d) => setTimeout(d, 10));
      return r.transport(a);
    };
    await r.openResource(a);
    expect(await failed()).toEqual({ state: "failed", cause: null });
    // The window's "offline": a failing attempt is being offline, not a fault.
    r.networkLost();
    expect(r.transport(a)).toEqual({ state: "failed", cause: "network-offline" });
    // Focus is a reason to try again, not evidence of a network; "online" is.
    r.networkBack();
    expect(await failed()).toEqual({ state: "failed", cause: "network-offline" });
    r.networkBack(true);
    expect(await failed()).toEqual({ state: "failed", cause: null });
    // The session's own transitions, as it reports them.
    const say = (state: string) => {
      for (const l of listeners[0] ?? []) l({ type: "connection", state });
    };
    // A retry after the failure reads as the failure until it ends.
    say("CONNECTING");
    expect(r.transport(a).state).toBe("failed");
    say("READY");
    expect(r.transport(a).state).toBe("ready");
    say("DISCONNECTED");
    expect(r.transport(a)).toEqual({ state: "lost", cause: null });
    expect(r.transport(local).state).toBe("none");
  });

  it("a session's ENGINE_TRAP blocks the runtime once (needs-restart)", async () => {
    queues.length = 0;
    listeners.length = 0;
    const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(r);
    const storage = r.storage as LfcpStorage;
    const a = await storeResource(storage, "wss://a.example.invalid/v1/ws");
    const b = await storeResource(storage, "wss://b.example.invalid/v1/ws");
    for (const R of [a, b]) await r.openResource(R);
    expect(r.sessions).toBe(2);
    const heard: string[] = [];
    r.onNeedsRestart((m) => heard.push(m));
    const trap = {
      type: "error",
      code: "ENGINE_TRAP",
      message: "the profile engine trapped (unreachable executed); this process must restart",
    };
    // Session a reports the trap (as SyncClient does once it stops on one).
    for (const l of listeners[0] ?? []) l(trap);
    expect(r.status).toMatchObject({ kind: "needs-restart" });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain("unreachable executed");
    expect(r.sessions).toBe(0); // every session stopped, b included
    await expect(r.openResource(a)).rejects.toThrow(NEEDS_RESTART);
    // Reported once: a second trap event changes nothing.
    for (const l of listeners[0] ?? []) l(trap);
    expect(heard).toHaveLength(1);
  });
});
