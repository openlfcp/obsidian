// The section port on the real SDK (sdk-ts at sdk-ts.lock): an offline
// SyncClient with the Shared Sections profile, as sdk-ts's own
// conformance/shared-sections/sync-commit.test.ts sets it up. The engine
// runs on it end to end: what the user types becomes a durable commit in
// the section's replica.

import {
  type CommitBinding,
  type DataProfileHandler,
  DataUnitApplier,
  dekResolver,
  OutboundQueue,
  SyncClient,
  saveControlChain,
} from "@openlfcp/client";
import { type ControlRecordId, dataEpoch, resourceId, toBase64url } from "@openlfcp/core";
import {
  dekCommitment,
  exportSecretKeyBytes,
  importAgreementKey,
  importResourceDEK,
  importSigningKey,
} from "@openlfcp/crypto";
import {
  SECTIONS_PROFILE_ID,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import {
  dekSecretRef,
  type EpochRow,
  InMemoryLfcpStorage,
  InMemorySecretStore,
} from "@openlfcp/storage";
import {
  type ControlBody,
  principalDescriptorFromKeys,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { describe, expect, it } from "vitest";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { MemorySectionBaseStore } from "../../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { CommitRefused } from "../../../src/core/sections/port";

const bytes32 = (from: number) => Uint8Array.from({ length: 32 }, (_, i) => (from + i) & 0xff);
const OWNER_KEY = importSigningKey(bytes32(1));
const AGREEMENT = importAgreementKey(bytes32(101));
const OWNER = { key: OWNER_KEY, descriptor: principalDescriptorFromKeys(OWNER_KEY, AGREEMENT) };
const DEK0 = importResourceDEK(bytes32(150));
const id = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const SECTION = id(1);
const me = OWNER.descriptor.principalId;

/** One device with a sections Resource, offline (the client never connects). */
async function device() {
  const R = resourceId(bytes32(200));
  const records: Uint8Array[] = [];
  let head: ControlRecordId | null = null;
  const add = (body: ControlBody) => {
    const s = signControlRecord(
      { resourceId: R, controlSeq: BigInt(records.length), prevControlId: head },
      body,
      OWNER,
    );
    records.push(s.bytes);
    head = s.recordId;
  };
  add({
    type: "GENESIS",
    dataProfile: SECTIONS_PROFILE_ID,
    owner: OWNER.descriptor,
    dekCommitment: dekCommitment(R, dataEpoch(0n), DEK0),
    endpoints: [{ url: "ws://127.0.0.1:1/v1/ws", priority: 0n }],
    coordinatorUrl: "ws://127.0.0.1:1/v1/ws",
  });
  const view = validateControlChain(records);
  if (view.kind !== "linear") throw new Error(view.kind);
  const storage = new InMemoryLfcpStorage();
  const secrets = new InMemorySecretStore();
  await saveControlChain(storage, view, null);
  await secrets.put(dekSecretRef(R, dataEpoch(0n)), exportSecretKeyBytes(DEK0));
  const e0 = (await storage.control.epochs(R))[0] as EpochRow;
  await storage.commit([
    { op: "put-epoch", resourceId: R, epoch: { ...e0, dekRef: dekSecretRef(R, dataEpoch(0n)) } },
  ]);
  const profile = new SharedSectionsDataProfile(
    SectionReplica.empty({ resource: R, principal: me }),
  );
  const handler: DataProfileHandler<unknown> = {
    dataProfile: profile.dataProfile,
    codecFor: (u) => profile.codecFor(u) as never,
    apply: (u, v) => profile.apply(u, v as never),
    exclude: (ids) => profile.exclude(ids),
  };
  const sync = new SyncClient({
    url: "ws://127.0.0.1:1/v1/ws",
    signer: OWNER,
    agreement: AGREEMENT,
    storage,
    secrets,
    outbound: new OutboundQueue({ storage }),
    now: () => 0,
  });
  sync.open({
    resourceId: R,
    applier: new DataUnitApplier({
      storage,
      dek: dekResolver(storage, secrets, R),
      handlers: [handler],
    }),
    commit: profile.commitBinding(me) as CommitBinding<unknown>,
  });
  await sync.commit(
    R,
    [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me }],
    {
      operationId: "create",
    },
  );
  const port = new SdkSectionPort({
    profile: () => profile,
    commit: (r, intents, o) => sync.commit(r, intents, o),
    storage,
    canWrite: () => ({ allowed: true }),
  });
  return { R, b64: toBase64url(R), storage, profile, sync, port };
}

describe("SdkSectionPort on the real SDK", () => {
  it("reads the section's snapshot", async () => {
    const d = await device();
    const s = d.port.snapshot(d.b64, SECTION);
    expect(s).toMatchObject({ title: "Launch", ready: true, nodes: {}, problems: [] });
    expect(s?.revision).toBe(d.profile.replica.revision());
  });

  it("commits a batch with a durable receipt, finds it again, and releases it", async () => {
    const d = await device();
    const intents = [
      {
        intent: "paragraph.create" as const,
        id: id(2),
        parent: SECTION,
        after: null,
        text: "Draft",
        createdBy: me,
      },
    ];
    const r = await d.port.commit(d.b64, intents, { operationId: "op-1" });
    expect(r).toMatchObject({ operationId: "op-1", durable: true, affectedNodeIds: [id(2)] });
    expect(r.unitIds[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(d.port.snapshot(d.b64, SECTION)?.nodes[id(2)]?.text).toBe("Draft");
    // The same operation again: the same receipt, nothing new.
    expect(await d.port.commit(d.b64, intents, { operationId: "op-1" })).toEqual(r);
    expect(await d.port.receiptOf(d.b64, "op-1")).toEqual(r);
    await d.port.releaseReceipt(d.b64, "op-1");
    expect(await d.port.receiptOf(d.b64, "op-1")).toBeUndefined();
  });

  it("turns the SDK's refusals into the port's", async () => {
    const d = await device();
    const bad = d.port.commit(d.b64, [{ intent: "node.delete", id: id(9) }], {
      operationId: "op-2",
    });
    await expect(bad).rejects.toBeInstanceOf(CommitRefused);
    await expect(bad).rejects.toMatchObject({ code: "UNKNOWN_NODE" });
    const ok = [{ intent: "section.set_title" as const, title: "Launch plan" }];
    await d.port.commit(d.b64, ok, { operationId: "op-3" });
    await expect(
      d.port.commit(d.b64, [{ intent: "section.set_title", title: "Other" }], {
        operationId: "op-3",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
  });

  it("runs the section engine: typing becomes a commit in the replica", async () => {
    const d = await device();
    const S = { resourceId: d.R, sectionId: SECTION };
    const note = (body: string[]) =>
      ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join("\n");
    let n = 10;
    const engine = new SectionEngine({
      port: d.port,
      journal: new MemorySectionJournalStore(),
      bases: new MemorySectionBaseStore(),
      newNodeId: () => id(n++),
      newOperationId: () => `op-${n++}`,
      createdBy: me,
      newProjectionId: () => "projection",
      tasks: () => undefined,
      newTask: (line, taskId) => ({ id: taskId, title: line }),
    });
    const ctx: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };
    const run = async (md: string) => {
      const pass = await engine.pass("Launch.md", md, ctx);
      const out = applyChanges(md, pass.changes);
      await engine.written(pass, out);
      return out;
    };
    // First sight: the empty section seeds the base.
    expect(await run(note([]))).toBe(note([]));
    // A new paragraph: committed through the sync client, its marker written.
    const out = await run(note(["Draft contract"]));
    expect(out).toBe(note([formatNodeMarker("paragraph", id(10)), "Draft contract"]));
    expect(d.port.snapshot(d.b64, SECTION)?.nodes[id(10)]?.text).toBe("Draft contract");
    // Edited: a text.edit against the snapshot's revision, accepted by the SDK.
    const edited = await run(out.replace("Draft contract", "Draft contract v2"));
    expect(d.port.snapshot(d.b64, SECTION)?.nodes[id(10)]?.text).toBe("Draft contract v2");
    expect(await run(edited)).toBe(edited);
  });
});
