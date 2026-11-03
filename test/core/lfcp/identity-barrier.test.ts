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
  type IdentityBlockStore,
  IdentityBlocks,
  isPairingLink,
  reservedTypeOf,
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

  it("a barrier seen and the chain refused: blocked at the last validated head, kept across a restart", async () => {
    const store = memoryStore();
    const blocks = new IdentityBlocks(
      () => store,
      () => 1000,
    );
    blocks.seen(sighting);
    expect(
      await blocks.refused(R, { kind: "chain", code: "INVALID_CONTROL_CHAIN" }, "cd".repeat(32)),
    ).toBe(true);
    expect(blocks.get(R)).toEqual({
      head: "cd".repeat(32),
      recordId: "ab".repeat(32),
      seq: "7",
      entry: "device-grant",
      at: 1000,
    });
    // A later refusal keeps the first head and record.
    blocks.seen({ ...sighting, seq: 9n, recordId: "ef".repeat(32) });
    await blocks.refused(R, { kind: "chain", code: "MALFORMED_MESSAGE" }, "00".repeat(32));
    expect(blocks.get(R)?.head).toBe("cd".repeat(32));

    const restarted = new IdentityBlocks(
      () => store,
      () => 2000,
    );
    await restarted.load();
    expect(restarted.get(R)).toEqual(blocks.get(R));
  });

  it("no barrier seen, or another refusal: not blocked (the generic error stands)", async () => {
    const blocks = new IdentityBlocks(
      () => memoryStore(),
      () => 0,
    );
    expect(await blocks.refused(R, { kind: "chain", code: "INVALID_CONTROL_CHAIN" }, null)).toBe(
      false,
    );
    blocks.seen(sighting);
    expect(await blocks.refused(R, { kind: "chain", code: "TIMEOUT" }, null)).toBe(false);
    expect(await blocks.refused(R, { kind: "chain", code: "AUTHORIZATION_FAILED" }, null)).toBe(
      false,
    );
    expect(blocks.get(R)).toBeNull();
  });

  it("types 9 and 10: the SDK parser's refusal of that very type confirms (0.2.2 names no Resource)", async () => {
    expect(reservedTypeOf("Control Record type 9 is reserved for LFCP core (§14)")).toBe(9n);
    expect(reservedTypeOf("the server's Control Records do not validate (MALFORMED)")).toBeNull();
    const blocks = new IdentityBlocks(
      () => memoryStore(),
      () => 0,
    );
    blocks.seen(sighting);
    expect(await blocks.refused(R, { kind: "reserved", type: 10n }, null)).toBe(false);
    expect(await blocks.refused(R, { kind: "reserved", type: 9n }, null)).toBe(true);
    const other = toHex(generateResourceId());
    blocks.seen({ ...sighting, resource: other, entry: "genesis-device" });
    expect(await blocks.refused(other, { kind: "reserved", type: 9n }, null)).toBe(false);
  });

  it("the chain validated (LIVE): the block and its row are gone", async () => {
    const store = memoryStore();
    const blocks = new IdentityBlocks(
      () => store,
      () => 0,
    );
    blocks.seen(sighting);
    await blocks.refused(R, { kind: "chain", code: "INVALID_CONTROL_CHAIN" }, null);
    expect(store.rows.size).toBe(1);
    await blocks.validated(R);
    expect(blocks.get(R)).toBeNull();
    expect(blocks.sighting(R)).toBeNull();
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
    blocks.seen(sighting);
    expect(watch.happened()).toBe(true);
    await expect(watch.seen).resolves.toEqual(sighting);
    watch.cancel();
    const late = blocks.whenSeen(R);
    expect(late.happened()).toBe(true);
    await expect(late.seen).resolves.toEqual(sighting);
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
