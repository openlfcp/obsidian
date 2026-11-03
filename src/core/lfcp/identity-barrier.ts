// The herald of identity (LFCP-04-406, V_notice; LFCP-WIRE-01 §100.1,
// IDENTITY-PROFILE-01 §5.2, §11). A Resource's chain becomes identity-aware
// at its first DEVICE_GRANT (type 9), DEVICE_REVOKE (type 10), Genesis with
// field 5 or OWNER_TRANSFER_COMMIT with field 2: its barrier. This version
// does not implement those records: its SDK (0.2.2) refuses the chain as any
// pre-identity client does (INVALID_CONTROL_CHAIN for types 9 and 10,
// MALFORMED_MESSAGE for the two fields), and the Resource stays blocked.
// What this module adds is recognition: it reads the exact Control Record
// bytes the server sent, tells the four barrier entries apart from any
// other broken chain, and the runtime then says "update the plugin" instead
// of a generic chain error, and keeps saying it across restarts.
//
// Nothing here validates or applies a record. The envelope is checked by
// the SDK's own COSE parser; only the payload's type (key 3) and the keys
// of its body (key 5) are read, with a bounded reader of deterministic CBOR
// (LFCP-WIRE-01 §10) that gives up (null) on anything it does not expect.

import { toHex } from "@openlfcp/core";
import {
  decodeMessage,
  MESSAGE_TYPE,
  parseSignedObject,
  validateControlChain,
} from "@openlfcp/wire";

/** The four entries of the barrier (LFCP-WIRE-01 §100.1). */
export type BarrierEntry = "device-grant" | "device-revoke" | "genesis-device" | "transfer-device";

/** A barrier record seen in a CONTROL_BATCH from the server. */
export interface BarrierSighting {
  /** The Resource (hex). */
  readonly resource: string;
  /** Its Control Sequence. */
  readonly seq: bigint;
  /** The record ID (hex): SHA-256 of its exact bytes. */
  readonly recordId: string;
  readonly entry: BarrierEntry;
}

/**
 * The persisted blocked state (§100.1: "blocked at head H by an unsupported
 * record"): the last validated head this device holds, and the record
 * after it that this version cannot read. Codes and IDs only.
 */
export interface IdentityBlock {
  /** The stored, validated Control Head (hex), or null when none is stored yet (a join). */
  readonly head: string | null;
  /** The barrier record (hex) and its sequence (decimal). */
  readonly recordId: string;
  readonly seq: string;
  readonly entry: BarrierEntry;
  /** When this device first recorded it (ms). */
  readonly at: number;
}

/** What a section (or a 0.1 collaboration) past its barrier says (the NEEDS_NEWER_VERSION path, runtime.ts). */
export const identityBlocked = (noun = "section"): string =>
  `This ${noun} now uses a person's linked devices, which this version of Shared Tasks does not support. Update the plugin in Settings → Community plugins to keep syncing it`;

export const IDENTITY_BLOCKED = identityBlocked();

/** What the rest of the details card adds: the local copy and edits made here (§100.1). */
export const IDENTITY_BLOCKED_LOCAL =
  "Your copy stays readable on this device; edits you make here wait on this device and are not sent until you update.";

/** Resource status's Sync row past a barrier: not offline, not retrying (obsidian#105 R5). */
export const IDENTITY_SYNC = "Not syncing: this needs a newer version of Shared Tasks";

/** A pairing link pasted where an invitation link goes (IDENTITY-PROFILE-01 §5.2). */
export const PAIRING_LINK_TEXT =
  "This is a link to add a device, not an invitation. Adding devices comes in a later version of Shared Tasks: update the plugin when it is available, then use the link again. It was not used.";

/** The barrier entry's words, for Resource status and diagnostics (no secret, no content). */
export const BARRIER_ENTRY_TEXT: Readonly<Record<BarrierEntry, string>> = {
  "device-grant": "a device was added (DEVICE_GRANT)",
  "device-revoke": "a device was removed (DEVICE_REVOKE)",
  "genesis-device": "created from a person's device (Genesis with a device certificate)",
  "transfer-device": "ownership moved to a person's device (transfer with a device certificate)",
};

/**
 * Whether `text` is a pairing link (`lfcp://pair/…`, IDENTITY-PROFILE-01
 * §5.2). Only the prefix is read: the fragment holds a device's private
 * keys and is never parsed, kept or logged here.
 */
export function isPairingLink(text: string): boolean {
  return /^lfcp:\/\/pair\//i.test(text.trim());
}

const TYPE_GENESIS = 0n;
const TYPE_TRANSFER_COMMIT = 6n;
const TYPE_DEVICE_GRANT = 9n;
const TYPE_DEVICE_REVOKE = 10n;
const CONTROL_BATCH = MESSAGE_TYPE.CONTROL_BATCH;

/** A bounded reader of deterministic CBOR (no indefinite lengths): null when out of bounds or unexpected. */
class Cbor {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  /** The next item's major type and argument; null at the end or for a reserved length. */
  head(): { readonly major: number; readonly arg: bigint } | null {
    const first = this.b[this.pos];
    if (first === undefined) return null;
    this.pos += 1;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, arg: BigInt(info) };
    if (info > 27) return null; // 28–30 reserved, 31 indefinite: not deterministic CBOR
    const n = 1 << (info - 24);
    if (this.pos + n > this.b.length) return null;
    let arg = 0n;
    for (let i = 0; i < n; i++) arg = (arg << 8n) | BigInt(this.b[this.pos + i] ?? 0);
    this.pos += n;
    return { major, arg };
  }

  /** Skips one item, nested at most `depth` deep; false when it cannot. */
  skip(depth = 16): boolean {
    const h = this.head();
    if (h === null || depth === 0) return false;
    switch (h.major) {
      case 0:
      case 1:
      case 7:
        return true;
      case 2:
      case 3: {
        if (h.arg > BigInt(this.b.length - this.pos)) return false;
        this.pos += Number(h.arg);
        return true;
      }
      case 4:
        for (let i = 0n; i < h.arg; i++) if (!this.skip(depth - 1)) return false;
        return true;
      case 5:
        for (let i = 0n; i < h.arg * 2n; i++) if (!this.skip(depth - 1)) return false;
        return true;
      case 6:
        return this.skip(depth - 1);
      default:
        return false;
    }
  }

  /** The unsigned integer keys of the map here and the position of each value; null if not such a map. */
  mapKeys(): Map<bigint, number> | null {
    const h = this.head();
    if (h === null || h.major !== 5 || h.arg > 64n) return null;
    const keys = new Map<bigint, number>();
    for (let i = 0n; i < h.arg; i++) {
      const k = this.head();
      if (k === null || k.major !== 0) return null;
      keys.set(k.arg, this.pos);
      if (!this.skip()) return null;
    }
    return keys;
  }

  at(pos: number): this {
    this.pos = pos;
    return this;
  }
}

/** The payload's resource ID, sequence, type and body keys; null when it is not a Control Record payload. */
function payloadOf(payload: Uint8Array): {
  readonly resource: string;
  readonly seq: bigint;
  readonly type: bigint;
  readonly bodyKeys: ReadonlySet<bigint>;
} | null {
  const r = new Cbor(payload);
  const keys = r.mapKeys();
  if (keys === null) return null;
  const pos = (k: bigint) => keys.get(k);
  const ridAt = pos(0n);
  const seqAt = pos(1n);
  const typeAt = pos(3n);
  const bodyAt = pos(5n);
  if (ridAt === undefined || seqAt === undefined || typeAt === undefined || bodyAt === undefined)
    return null;
  const rid = r.at(ridAt).head();
  if (rid === null || rid.major !== 2 || rid.arg !== 32n) return null;
  const resource = toHex(payload.subarray(r.pos, r.pos + 32));
  const seq = r.at(seqAt).head();
  const type = r.at(typeAt).head();
  if (seq === null || seq.major !== 0 || type === null || type.major !== 0) return null;
  const body = r.at(bodyAt).mapKeys();
  return {
    resource,
    seq: seq.arg,
    type: type.arg,
    bodyKeys: new Set(body === null ? [] : body.keys()),
  };
}

/**
 * The barrier entry `record` is (LFCP-WIRE-01 §100.1), or null when it is
 * none of the four, or not a signed Control Record at all.
 */
export function barrierEntryOf(
  record: Uint8Array,
): { readonly entry: BarrierEntry; readonly resource: string; readonly seq: bigint } | null {
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = parseSignedObject(record).payloadBytes;
  } catch {
    return null;
  }
  const p = payloadOf(payloadBytes);
  if (p === null) return null;
  const entry: BarrierEntry | null =
    p.type === TYPE_DEVICE_GRANT
      ? "device-grant"
      : p.type === TYPE_DEVICE_REVOKE
        ? "device-revoke"
        : p.type === TYPE_GENESIS && p.bodyKeys.has(5n)
          ? "genesis-device"
          : p.type === TYPE_TRANSFER_COMMIT && p.bodyKeys.has(2n)
            ? "transfer-device"
            : null;
  return entry === null ? null : { entry, resource: p.resource, seq: p.seq };
}

/**
 * The message type of a frame, read from its envelope's first key (§32:
 * a deterministic map, so key 0 comes first) without decoding the rest.
 */
function frameType(frame: Uint8Array): bigint | null {
  const r = new Cbor(frame);
  const m = r.head();
  if (m === null || m.major !== 5 || m.arg === 0n) return null;
  const k = r.head();
  if (k === null || k.major !== 0 || k.arg !== 0n) return null;
  const t = r.head();
  return t === null || t.major !== 0 ? null : t.arg;
}

/** One Control Record of a CONTROL_BATCH: its exact bytes, place and barrier entry (null: none). */
export interface BatchRecord {
  readonly bytes: Uint8Array;
  readonly seq: bigint;
  readonly recordId: string;
  readonly entry: BarrierEntry | null;
  /** Its Control Record type, when the payload could be read. */
  readonly type: bigint | null;
}

/** A CONTROL_BATCH a server sent: its Resource (hex) and that Resource's records in it. */
export interface ControlBatch {
  readonly resource: string;
  readonly records: readonly BatchRecord[];
}

/**
 * The CONTROL_BATCH a server frame is, with each record of its Resource
 * read for the barrier, or null for any other frame (which costs a few
 * bytes' peek). A record of another Resource in the batch is the SDK's to
 * refuse, never a barrier here.
 */
export function controlBatchOf(frame: Uint8Array): ControlBatch | null {
  if (frameType(frame) !== CONTROL_BATCH) return null;
  let objects: readonly Uint8Array[];
  let resource: string;
  try {
    // The SDK applies its own size limit to the same frame; here it only classifies.
    const m = decodeMessage(frame, { maxMessageBytes: frame.length });
    if (m.type !== "CONTROL_BATCH") return null;
    objects = m.body.objects;
    resource = toHex(m.body.resourceId);
  } catch {
    return null;
  }
  const records: BatchRecord[] = [];
  for (const bytes of objects) {
    let signed: ReturnType<typeof parseSignedObject>;
    try {
      signed = parseSignedObject(bytes);
    } catch {
      continue;
    }
    const p = payloadOf(signed.payloadBytes);
    if (p === null || p.resource !== resource) continue;
    records.push({
      bytes: signed.bytes,
      seq: p.seq,
      recordId: toHex(signed.id),
      entry: barrierEntryOf(bytes)?.entry ?? null,
      type: p.type,
    });
  }
  return { resource, records };
}

const bySeq = <T extends { readonly seq: bigint }>(a: T, b: T) =>
  a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;

/** The barrier records a server frame carries, lowest sequence first. */
export function barrierInFrame(frame: Uint8Array): BarrierSighting[] {
  const batch = controlBatchOf(frame);
  if (batch === null) return [];
  return batch.records
    .flatMap((r) =>
      r.entry === null
        ? []
        : [{ resource: batch.resource, seq: r.seq, recordId: r.recordId, entry: r.entry }],
    )
    .sort(bySeq);
}

/** The frame's bytes as the SDK reads them (connection.js BYTES), or null for text and others. */
function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Reads a frame the SDK receives, before the SDK handles it: `batch`
 * hears of a CONTROL_BATCH. A failure here never reaches the SDK's
 * handling of the frame.
 */
export function watchControlBatch(data: unknown, batch: (b: ControlBatch) => void): void {
  const frame = frameBytes(data);
  if (frame === null) return;
  try {
    const b = controlBatchOf(frame);
    if (b !== null && b.records.length > 0) batch(b);
  } catch {
    // Recognition is best effort; the SDK's own refusal stands either way.
  }
}

/** watchControlBatch for the barrier records only. */
export function watchBarrier(data: unknown, seen: (s: BarrierSighting) => void): void {
  watchControlBatch(data, (b) => {
    for (const r of b.records)
      if (r.entry !== null)
        seen({ resource: b.resource, seq: r.seq, recordId: r.recordId, entry: r.entry });
  });
}

/** The chain errors a pre-identity SDK gives a barrier (§100.1) for a Resource it names. */
export const BARRIER_ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_CONTROL_CHAIN",
  "MALFORMED_MESSAGE",
]);

/** The reserved core type an SDK error message names, or null. */
export function reservedTypeOf(message: string): bigint | null {
  const m = /Control Record type (\d+) is reserved for LFCP core/.exec(message);
  return m?.[1] === undefined ? null : BigInt(m[1]);
}

/**
 * Whether the SDK in use refuses `resource`'s `stored` chain (validated,
 * Genesis first) extended by `received` because of a barrier record, and if so the
 * barrier: the first barrier record past the stored head. The SDK's own
 * validateControlChain decides: its first problem must be a record it
 * cannot read (UNSUPPORTED_TYPE, MALFORMED) that is one of the barrier
 * records. Null otherwise (nothing past the head, a valid extension, or a
 * chain broken for another reason).
 */
export function barrierRefusedBySdk(
  resource: string,
  stored: readonly Uint8Array[],
  received: readonly BatchRecord[],
): BarrierSighting | null {
  const next = BigInt(stored.length);
  const unique = new Map<string, BatchRecord>();
  for (const r of received) if (r.seq >= next) unique.set(r.recordId, r);
  const past = [...unique.values()].sort(bySeq);
  const barrier = past.find((r) => r.entry !== null);
  if (barrier === undefined || barrier.entry === null) return null;
  const result = validateControlChain([...stored, ...past.map((r) => r.bytes)]);
  if (result.kind !== "invalid") return null;
  if (result.problem !== "UNSUPPORTED_TYPE" && result.problem !== "MALFORMED") return null;
  const flagged = result.recordId === null ? null : toHex(result.recordId);
  if (!past.some((r) => r.entry !== null && r.recordId === flagged)) return null;
  return { resource, seq: barrier.seq, recordId: barrier.recordId, entry: barrier.entry };
}

/**
 * One session's view of the barrier (LFCP-04-406): the Control Records it
 * brought for the Resources it has open, and the batches with a barrier
 * record whose refusal by the SDK is still to come, in arrival order. The
 * SDK handles a session's messages one at a time in that order, and
 * refuses a batch it reads with a record of type 9 or 10 by an error that
 * names only the type: the oldest pending batch with that type is the one.
 * A batch for a Resource the session has not open is ignored by the SDK,
 * and here.
 */
export class SessionBarriers {
  readonly #isOpen: (resource: string) => boolean;
  /** Records received per Resource (hex), by record ID. */
  readonly #received = new Map<string, Map<string, BatchRecord>>();
  readonly #pending: { readonly resource: string; readonly types: ReadonlySet<bigint> }[] = [];

  constructor(isOpen: (resource: string) => boolean) {
    this.#isOpen = isOpen;
  }

  /** A frame the SDK is about to handle. */
  frame(data: unknown): void {
    watchControlBatch(data, (b) => this.batch(b));
  }

  batch(b: ControlBatch): void {
    if (!this.#isOpen(b.resource)) return;
    const pool = this.#received.get(b.resource) ?? new Map<string, BatchRecord>();
    for (const r of b.records) pool.set(r.recordId, r);
    this.#received.set(b.resource, pool);
    if (b.records.some((r) => r.entry !== null))
      this.#pending.push({
        resource: b.resource,
        types: new Set(b.records.flatMap((r) => (r.type === null ? [] : [r.type]))),
      });
  }

  /**
   * The SDK reported an error on this session: the Resources (hex) whose
   * pending barrier batch it refuses. A chain error names its Resource; a
   * reserved type error names none, and takes the oldest pending batch
   * that has a record of that type.
   */
  refused(e: { readonly code: string; readonly message: string; readonly resource?: string }) {
    if (e.resource !== undefined) {
      if (!BARRIER_ERROR_CODES.has(e.code)) return [];
      const before = this.#pending.length;
      this.#drop((p) => p.resource === e.resource);
      return this.#pending.length < before ? [e.resource] : [];
    }
    const type = reservedTypeOf(e.message);
    if (type === null) return [];
    const at = this.#pending.findIndex((p) => p.types.has(type));
    const hit = this.#pending[at];
    if (hit === undefined) return [];
    this.#pending.splice(at, 1);
    return [hit.resource];
  }

  /** The records received for `resource`. */
  received(resource: string): BatchRecord[] {
    return [...(this.#received.get(resource)?.values() ?? [])];
  }

  /** The Resource's chain is validated up to `seq`: what it covers is forgotten. */
  validated(resource: string, seq: bigint): void {
    const pool = this.#received.get(resource);
    for (const [id, r] of pool ?? []) if (r.seq <= seq) pool?.delete(id);
  }

  #drop(match: (p: { readonly resource: string }) => boolean): void {
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const p = this.#pending[i];
      if (p !== undefined && match(p)) this.#pending.splice(i, 1);
    }
  }
}

/** A stored IdentityBlock, or null when `value` is not one (an older or damaged row). */
export function identityBlockOf(value: unknown): IdentityBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const entries: readonly string[] = Object.keys(BARRIER_ENTRY_TEXT);
  if (
    (v.head !== null && typeof v.head !== "string") ||
    typeof v.recordId !== "string" ||
    typeof v.seq !== "string" ||
    !/^\d+$/.test(v.seq) ||
    typeof v.entry !== "string" ||
    !entries.includes(v.entry) ||
    typeof v.at !== "number"
  )
    return null;
  return {
    head: v.head,
    recordId: v.recordId,
    seq: v.seq,
    entry: v.entry as BarrierEntry,
    at: v.at,
  };
}

/** The plugin's local state the blocks live in (LfcpRuntime.localState). */
export interface IdentityBlockStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

const BLOCK_PREFIX = "identity-block:";

/** A wait for a barrier record of one Resource (IdentityBlocks.whenSeen). */
export interface BarrierWatch {
  readonly seen: Promise<unknown>;
  /** A barrier the SDK cannot get past arrived for the Resource, now or before. */
  happened(): boolean;
  cancel(): void;
}

/**
 * The Resources past their barrier on this device (§100.1), persisted
 * ("blocked at head H by an unsupported record") so that the update
 * message survives restarts, offline included. A block is lifted only
 * when the Resource's validated chain reaches the barrier's sequence, never
 * because a session went LIVE on an older head.
 */
export class IdentityBlocks {
  readonly #store: () => IdentityBlockStore | null;
  readonly #now: () => number;
  readonly #blocks = new Map<string, IdentityBlock>();
  /** Resources (hex) a join's connection brought a barrier for. */
  readonly #joinSeen = new Set<string>();
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(store: () => IdentityBlockStore | null, now: () => number) {
    this.#store = store;
    this.#now = now;
  }

  /** Reads the persisted blocks (at the start). */
  async load(): Promise<void> {
    const store = this.#store();
    if (store === null) return;
    for (const key of await store.keys(BLOCK_PREFIX)) {
      const block = identityBlockOf(await store.get(key));
      if (block !== null) this.#blocks.set(key.slice(BLOCK_PREFIX.length), block);
    }
  }

  /**
   * `resource` is blocked at `head` by `barrier`, which the SDK refused. A
   * block already recorded keeps its first head and record.
   */
  async block(resource: string, barrier: BarrierSighting, head: string | null): Promise<void> {
    if (this.#blocks.has(resource)) return;
    const block: IdentityBlock = {
      head,
      recordId: barrier.recordId,
      seq: String(barrier.seq),
      entry: barrier.entry,
      at: this.#now(),
    };
    this.#blocks.set(resource, block);
    await this.#store()?.put(BLOCK_PREFIX + resource, block);
  }

  /**
   * The Resource's chain is validated up to `seq`: past its barrier's
   * sequence (an update read it), the block is lifted; below, it stays.
   */
  async validated(resource: string, seq: bigint): Promise<void> {
    const block = this.#blocks.get(resource);
    if (block === undefined || seq < BigInt(block.seq)) return;
    this.#blocks.delete(resource);
    await this.#store()?.put(BLOCK_PREFIX + resource, undefined);
  }

  /** The persisted block of `resource`, or null. */
  get(resource: string): IdentityBlock | null {
    return this.#blocks.get(resource) ?? null;
  }

  /** A join's connection brought a barrier of `resource` that the SDK cannot get past. */
  joinSeen(resource: string): void {
    this.#joinSeen.add(resource);
    const waiting = this.#waiters.get(resource);
    this.#waiters.delete(resource);
    for (const w of waiting ?? []) w();
  }

  /**
   * Resolves when a join's connection brings such a barrier of `resource`;
   * `happened` says it at once; `cancel` forgets the wait.
   */
  whenSeen(resource: string): BarrierWatch {
    const happened = () => this.#joinSeen.has(resource);
    if (happened()) return { seen: Promise.resolve(), happened, cancel: () => undefined };
    let waiter: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
      waiter = resolve;
    });
    const set = this.#waiters.get(resource) ?? new Set();
    if (waiter !== undefined) set.add(waiter);
    this.#waiters.set(resource, set);
    return {
      seen,
      happened,
      cancel: () => {
        if (waiter !== undefined) set.delete(waiter);
        if (set.size === 0 && this.#waiters.get(resource) === set) this.#waiters.delete(resource);
      },
    };
  }
}
