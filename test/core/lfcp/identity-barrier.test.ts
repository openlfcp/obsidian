// LFCP-04-406 (V_notice): the four barrier entries of LFCP-WIRE-01 §100.1
// recognised from the exact bytes a server sends, without implementing
// them; the blocked state kept across restarts and cleared once the chain
// validates; a pairing link (IDENTITY-PROFILE-01 §5.2) told apart; and the
// section's status saying "update" instead of a generic chain error.

import { dataEpoch, generateResourceId, type ResourceId, toHex } from "@openlfcp/core";
import {
  dekCommitment,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
} from "@openlfcp/crypto";
import {
  createMessage,
  encodeMessage,
  objectId,
  principalDescriptorFromKeys,
  type Signer,
  signControlRecord,
  signObject,
  validateControlChain,
} from "@openlfcp/wire";
import { describe, expect, it } from "vitest";
import {
  barrierEntryOf,
  barrierInFrame,
  barrierRefusedBySdk,
  controlBatchOf,
  type IdentityBlockStore,
  IdentityBlocks,
  isPairingLink,
  SessionBarriers,
  watchBarrier,
} from "../../../src/core/lfcp/identity-barrier";

// --- deterministic CBOR, just enough to write payloads the 0.2.2 SDK cannot ---

type Cbor = bigint | Uint8Array | string | null | readonly Cbor[] | Map<bigint, Cbor>;

function head(major: number, n: bigint): number[] {
  if (n < 24n) return [(major << 5) | Number(n)];
  for (const [info, bytes] of [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ] as const)
    if (n < 1n << BigInt(bytes * 8)) {
      const out = [(major << 5) | info];
      for (let i = bytes - 1; i >= 0; i--) out.push(Number((n >> BigInt(i * 8)) & 0xffn));
      return out;
    }
  throw new Error("too large");
}

function cbor(v: Cbor): number[] {
  if (typeof v === "bigint") return head(0, v);
  if (v === null) return [0xf6];
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return [...head(3, BigInt(b.length)), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, BigInt(v.length)), ...v];
  if (v instanceof Map) {
    const keys = [...v.keys()].sort((a, b) => (a < b ? -1 : 1));
    return [
      ...head(5, BigInt(keys.length)),
      ...keys.flatMap((k) => [...cbor(k), ...cbor(v.get(k) ?? null)]),
    ];
  }
  return [...head(4, BigInt(v.length)), ...v.flatMap(cbor)];
}

const bytes = (v: Cbor) => Uint8Array.from(cbor(v));

function signer(): Signer {
  const key = generateSigningKeyPair();
  return { key, descriptor: principalDescriptorFromKeys(key, generateAgreementKeyPair()) };
}

const OWNER = signer();
const URL = "wss://offline.example.invalid/v1/ws";

/** A signed Control Record of any type and body, as a newer client writes it (§13). */
function record(
  R: ResourceId,
  seq: bigint,
  type: bigint,
  body: Map<bigint, Cbor>,
  prev: Uint8Array | null = new Uint8Array(32).fill(1),
): Uint8Array {
  const payload = new Map<bigint, Cbor>([
    [0n, R],
    [1n, seq],
    [2n, seq === 0n ? null : prev],
    [3n, type],
    [4n, OWNER.descriptor.principalId],
    [5n, body],
  ]);
  return signObject(bytes(payload), OWNER).bytes;
}

function genesis(R: ResourceId) {
  return signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: "lfcp.shared-sections.v1",
      owner: OWNER.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), generateResourceDEK()),
      endpoints: [{ url: URL, priority: 0n }],
      coordinatorUrl: URL,
    },
    OWNER,
  );
}

const body = (...keys: bigint[]) => new Map<bigint, Cbor>(keys.map((k) => [k, new Uint8Array(4)]));

describe("the four barrier entries (WIRE §100.1)", () => {
  const R = generateResourceId();

  it("types 9 and 10, Genesis field 5 and commit field 2, each recognised", () => {
    expect(barrierEntryOf(record(R, 3n, 9n, body(0n, 1n)))).toEqual({
      entry: "device-grant",
      resource: toHex(R),
      seq: 3n,
    });
    expect(barrierEntryOf(record(R, 4n, 10n, body(0n)))?.entry).toBe("device-revoke");
    expect(barrierEntryOf(record(R, 0n, 0n, body(0n, 1n, 2n, 3n, 4n, 5n)))?.entry).toBe(
      "genesis-device",
    );
    expect(barrierEntryOf(record(R, 5n, 6n, body(0n, 1n, 2n)))?.entry).toBe("transfer-device");
  });

  it("the records this version reads, and other core types, are not a barrier", () => {
    // A real Genesis of the 0.2.2 SDK, and the same shapes without the new fields.
    const g = genesis(R);
    expect(validateControlChain([g.bytes]).kind).toBe("linear");
    expect(barrierEntryOf(g.bytes)).toBeNull();
    expect(barrierEntryOf(record(R, 0n, 0n, body(0n, 1n, 2n, 3n, 4n)))).toBeNull();
    expect(barrierEntryOf(record(R, 5n, 6n, body(0n, 1n)))).toBeNull();
    // An unknown core type stays the generic chain error (the vector moved to 31).
    expect(barrierEntryOf(record(R, 5n, 31n, body(0n)))).toBeNull();
    expect(barrierEntryOf(record(R, 5n, 11n, body(0n)))).toBeNull();
    expect(barrierEntryOf(record(R, 5n, 33n, body(0n)))).toBeNull();
  });

  it("anything that is not a signed Control Record is no barrier, and never throws", () => {
    expect(barrierEntryOf(new Uint8Array())).toBeNull();
    expect(barrierEntryOf(Uint8Array.from([0xff, 0x00, 0x13]))).toBeNull();
    expect(barrierEntryOf(bytes([1n, 2n]))).toBeNull();
    // A signed object whose payload is not a Control Record payload.
    expect(barrierEntryOf(signObject(bytes(new Map([[0n, 1n]])), OWNER).bytes)).toBeNull();
    // A truncated length inside the payload is refused by the SDK's parser first.
    const g = record(R, 3n, 9n, body(0n));
    expect(barrierEntryOf(g.subarray(0, g.length - 3))).toBeNull();
  });
});

describe("a server frame", () => {
  const R = generateResourceId();
  const g = genesis(R);
  const grant = record(R, 1n, 9n, body(0n), g.recordId);
  const batch = (objects: Uint8Array[], resourceId: ResourceId = R) =>
    encodeMessage(createMessage("CONTROL_BATCH", { resourceId, objects }));

  it("a CONTROL_BATCH with a barrier names the Resource, the record and its sequence", () => {
    expect(barrierInFrame(batch([g.bytes, grant]))).toEqual([
      { resource: toHex(R), seq: 1n, recordId: toHex(objectId(grant)), entry: "device-grant" },
    ]);
    expect(barrierInFrame(batch([g.bytes]))).toEqual([]);
  });

  it("a record of another Resource in the batch is not this Resource's barrier", () => {
    const other = generateResourceId();
    expect(barrierInFrame(batch([record(other, 1n, 9n, body(0n))]))).toEqual([]);
  });

  it("other messages are only peeked at, and undecodable frames give nothing", () => {
    const ping = encodeMessage(createMessage("PING", { payload: new Uint8Array(8) }));
    expect(barrierInFrame(ping)).toEqual([]);
    expect(barrierInFrame(new Uint8Array([0xa5, 0x00, 0x16]))).toEqual([]);
    expect(barrierInFrame(new Uint8Array())).toEqual([]);
  });

  it("the watch reads the data as the SDK does: an ArrayBuffer or a view, not text", () => {
    const seen: unknown[] = [];
    const frame = batch([grant]);
    watchBarrier(frame.slice().buffer, (s) => seen.push(s.entry));
    watchBarrier(frame, (s) => seen.push(s.entry));
    watchBarrier("text", (s) => seen.push(s.entry));
    expect(seen).toEqual(["device-grant", "device-grant"]);
  });
});

/** The plugin's local state, in memory: `undefined` removes a key (sealed store semantics). */
function memoryStore(): IdentityBlockStore & { readonly rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async (k) => rows.get(k),
    put: async (k, v) => {
      if (v === undefined) rows.delete(k);
      else rows.set(k, v);
    },
    keys: async (prefix) => [...rows.keys()].filter((k) => k.startsWith(prefix)),
  };
}

describe("the blocked state (WIRE §100.1: persisted, survives restarts)", () => {
  const R = toHex(generateResourceId());
  const sighting = {
    resource: R,
    seq: 7n,
    recordId: "ab".repeat(32),
    entry: "device-grant" as const,
  };

  it("blocked at the last validated head, the first block kept, read back after a restart", async () => {
    const store = memoryStore();
    const blocks = new IdentityBlocks(
      () => store,
      () => 1000,
    );
    await blocks.block(R, sighting, "cd".repeat(32));
    expect(blocks.get(R)).toEqual({
      head: "cd".repeat(32),
      recordId: "ab".repeat(32),
      seq: "7",
      entry: "device-grant",
      at: 1000,
    });
    await blocks.block(R, { ...sighting, seq: 9n, recordId: "ef".repeat(32) }, "00".repeat(32));
    expect(blocks.get(R)?.head).toBe("cd".repeat(32));
    const restarted = new IdentityBlocks(
      () => store,
      () => 2000,
    );
    await restarted.load();
    expect(restarted.get(R)).toEqual(blocks.get(R));
  });

  it("lifted only once the validated chain reaches the barrier's sequence (R2)", async () => {
    const store = memoryStore();
    const blocks = new IdentityBlocks(
      () => store,
      () => 0,
    );
    await blocks.block(R, sighting, null);
    await blocks.validated(R, 6n);
    expect(blocks.get(R)).not.toBeNull();
    expect(store.rows.size).toBe(1);
    await blocks.validated(R, 7n);
    expect(blocks.get(R)).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("a damaged row is ignored at load", async () => {
    const store = memoryStore();
    await store.put(`identity-block:${R}`, { head: 3, entry: "device-grant" });
    await store.put(`identity-block:${toHex(generateResourceId())}`, {
      ...sighting,
      seq: "1",
      at: 0,
      head: null,
      entry: "nope",
    });
    await store.put(`identity-block:${toHex(generateResourceId())}`, {
      ...sighting,
      seq: "x1",
      at: 0,
      head: null,
    });
    const blocks = new IdentityBlocks(
      () => store,
      () => 0,
    );
    await blocks.load();
    expect(blocks.get(R)).toBeNull();
  });

  it("a join waiting on the chain hears of the barrier at once", async () => {
    const blocks = new IdentityBlocks(
      () => null,
      () => 0,
    );
    const watch = blocks.whenSeen(R);
    expect(watch.happened()).toBe(false);
    blocks.joinSeen(R);
    expect(watch.happened()).toBe(true);
    await expect(watch.seen).resolves.toBeUndefined();
    watch.cancel();
    expect(blocks.whenSeen(R).happened()).toBe(true);
  });
});

describe("which refusal is whose (one session, SDK order)", () => {
  const A = generateResourceId();
  const B = generateResourceId();
  const batch = (R: ResourceId, ...objects: Uint8Array[]) =>
    controlBatchOf(encodeMessage(createMessage("CONTROL_BATCH", { resourceId: R, objects })));
  const grant = (R: ResourceId) => record(R, 1n, 9n, body(0n));
  const commit = (R: ResourceId) => record(R, 1n, 6n, body(0n, 1n, 2n));
  const reserved = (type: number) => ({
    code: "INTERNAL",
    message: `Control Record type ${type} is reserved for LFCP core (§14)`,
  });

  const frame = (R: ResourceId, ...objects: Uint8Array[]) =>
    encodeMessage(createMessage("CONTROL_BATCH", { resourceId: R, objects }));
  const opened = (R: ResourceId) =>
    encodeMessage(createMessage("RESOURCE_OPENED", { resourceId: R, heads: [], haves: [] }));
  const whose = (r: readonly { readonly resource: string }[]) => r.map((x) => x.resource);

  it("a batch for a Resource not open on the session is ignored (R3)", () => {
    const s = new SessionBarriers((r) => r === toHex(B));
    for (const f of [opened(A), opened(B), frame(A, grant(A)), frame(B, grant(B))]) s.frame(f);
    expect(s.received(toHex(A))).toEqual([]);
    expect(whose(s.refused(reserved(9)))).toEqual([toHex(B)]);
    expect(s.refused(reserved(9))).toEqual([]);
  });

  it("a batch before the Resource's RESOURCE_OPENED (still OPENING) is ignored, as the SDK ignores it (B1)", () => {
    const s = new SessionBarriers(() => true);
    for (const f of [frame(A, grant(A)), opened(B), frame(B, grant(B))]) s.frame(f);
    expect(whose(s.refused(reserved(9)))).toEqual([toHex(B)]);
    expect(s.refused(reserved(9))).toEqual([]);
    // A RESOURCE_OPENED again (a reopen) starts the Resource over.
    s.frame(frame(B, grant(B)));
    s.frame(opened(B));
    expect(s.received(toHex(B))).toEqual([]);
  });

  it("a new connection starts over; a refusal keeps the records it came with (B2)", () => {
    const s = new SessionBarriers(() => true);
    for (const f of [opened(A), frame(A, grant(A))]) s.frame(f);
    const [refused] = s.refused(reserved(9));
    s.connection();
    expect(refused?.received.map((r) => r.entry)).toEqual(["device-grant"]);
    expect(s.received(toHex(A))).toEqual([]);
    s.frame(frame(A, grant(A)));
    expect(s.refused(reserved(9))).toEqual([]);
  });

  it("a reserved type error takes the oldest pending batch with that type; a chain error names its own", () => {
    const s = new SessionBarriers(() => true);
    for (const f of [opened(A), opened(B), frame(A, commit(A)), frame(B, grant(B))]) s.frame(f);
    expect(s.refused(reserved(10))).toEqual([]);
    expect(whose(s.refused(reserved(9)))).toEqual([toHex(B)]);
    expect(s.refused({ code: "TIMEOUT", message: "x", resource: toHex(A) })).toEqual([]);
    expect(
      whose(s.refused({ code: "MALFORMED_MESSAGE", message: "x", resource: toHex(A) })),
    ).toEqual([toHex(A)]);
  });

  it("the SDK itself decides: only a chain it cannot get past because of a barrier record (R1)", () => {
    const R = generateResourceId();
    const g = genesis(R);
    const c = record(R, 1n, 6n, body(0n, 1n, 2n), g.recordId);
    const d = record(R, 2n, 9n, body(0n), objectId(c));
    const received = batch(R, c, d)?.records ?? [];
    // Mixed: a commit with field 2, then a DEVICE_GRANT; the barrier is the first of them.
    expect(barrierRefusedBySdk(toHex(R), [g.bytes], received)).toMatchObject({
      seq: 1n,
      entry: "transfer-device",
    });
    // Nothing past the stored head, or no barrier record: no block.
    expect(barrierRefusedBySdk(toHex(R), [g.bytes], [])).toBeNull();
    const plain = batch(R, record(R, 1n, 31n, body(0n), g.recordId))?.records ?? [];
    expect(barrierRefusedBySdk(toHex(R), [g.bytes], plain)).toBeNull();
    // A join: nothing stored, a Genesis with field 5.
    const g5 = batch(R, record(R, 0n, 0n, body(0n, 1n, 2n, 3n, 4n, 5n)))?.records ?? [];
    expect(barrierRefusedBySdk(toHex(R), [], g5)?.entry).toBe("genesis-device");
  });
});

describe("a pairing link (IDENTITY-PROFILE-01 §5.2)", () => {
  it("is recognised by its prefix only", () => {
    expect(isPairingLink("lfcp://pair/abc?endpoint=x&device=y#secret=z")).toBe(true);
    expect(isPairingLink("  LFCP://PAIR/abc ")).toBe(true);
    expect(isPairingLink("lfcp://join/abc#secret=z")).toBe(false);
    expect(isPairingLink("https://example.org/lfcp://pair/")).toBe(false);
  });
});
