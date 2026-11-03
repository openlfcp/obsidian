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
import { decodeMessage, MESSAGE_TYPE, parseSignedObject } from "@openlfcp/wire";

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

/**
 * The barrier records a server frame carries, lowest sequence first: only
 * a CONTROL_BATCH is decoded (any other frame costs a few bytes' peek).
 */
export function barrierInFrame(frame: Uint8Array): BarrierSighting[] {
  if (frameType(frame) !== CONTROL_BATCH) return [];
  let objects: readonly Uint8Array[];
  let resource: string;
  try {
    // The SDK applies its own size limit to the same frame; here it only classifies.
    const m = decodeMessage(frame, { maxMessageBytes: frame.length });
    if (m.type !== "CONTROL_BATCH") return [];
    objects = m.body.objects;
    resource = toHex(m.body.resourceId);
  } catch {
    return [];
  }
  const out: BarrierSighting[] = [];
  for (const bytes of objects) {
    const b = barrierEntryOf(bytes);
    // A record of another Resource in this batch is the SDK's to refuse, not a barrier here.
    if (b === null || b.resource !== resource) continue;
    let recordId: string;
    try {
      recordId = toHex(parseSignedObject(bytes).id);
    } catch {
      continue;
    }
    out.push({ resource, seq: b.seq, recordId, entry: b.entry });
  }
  return out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

/** The frame's bytes as the SDK reads them (connection.js BYTES), or null for text and others. */
function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Reads each frame the SDK receives for barrier records, before the SDK
 * handles it: `seen` hears of each one. A failure here never reaches the
 * SDK's handling of the frame.
 */
export function watchBarrier(data: unknown, seen: (s: BarrierSighting) => void): void {
  const frame = frameBytes(data);
  if (frame === null) return;
  try {
    for (const s of barrierInFrame(frame)) seen(s);
  } catch {
    // Recognition is best effort; the SDK's own refusal stands either way.
  }
}

/** The chain errors a pre-identity SDK gives a barrier (§100.1) for a Resource it names. */
export const BARRIER_ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_CONTROL_CHAIN",
  "MALFORMED_MESSAGE",
]);

/**
 * How the SDK refused a chain with a barrier in it. The 0.2.2 SDK names the
 * Resource for a Genesis field 5 or a commit field 2 (MALFORMED_MESSAGE);
 * for types 9 and 10 its record parser throws before the chain is
 * validated, and the session's error names no Resource, only the type
 * ("Control Record type 9 is reserved for LFCP core (§14)", code INTERNAL).
 */
export type BarrierRefusal =
  | { readonly kind: "chain"; readonly code: string }
  | { readonly kind: "reserved"; readonly type: bigint };

/** The reserved core type an SDK error message names, or null. */
export function reservedTypeOf(message: string): bigint | null {
  const m = /Control Record type (\d+) is reserved for LFCP core/.exec(message);
  return m?.[1] === undefined ? null : BigInt(m[1]);
}

/** The Control Record type of an entry that is a type of its own (9, 10); null for the two fields. */
const ENTRY_TYPE: Readonly<Record<BarrierEntry, bigint | null>> = {
  "device-grant": TYPE_DEVICE_GRANT,
  "device-revoke": TYPE_DEVICE_REVOKE,
  "genesis-device": null,
  "transfer-device": null,
};

/** A stored IdentityBlock, or null when `value` is not one (an older or damaged row). */
export function identityBlockOf(value: unknown): IdentityBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const entries: readonly string[] = Object.keys(BARRIER_ENTRY_TEXT);
  if (
    (v.head !== null && typeof v.head !== "string") ||
    typeof v.recordId !== "string" ||
    typeof v.seq !== "string" ||
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
  /** A barrier record of the Resource arrived, now or before. */
  happened(): boolean;
  cancel(): void;
}

/**
 * The Resources past their barrier on this device (§100.1): a barrier seen
 * in a server's CONTROL_BATCH this session, confirmed by the SDK's refusal
 * of that chain, is persisted ("blocked at head H by an unsupported
 * record") so that the update message survives restarts, offline included.
 * A Resource whose session goes LIVE validated its chain: it is not blocked.
 */
export class IdentityBlocks {
  readonly #store: () => IdentityBlockStore | null;
  readonly #now: () => number;
  /** The lowest barrier record seen per Resource (hex) since the start. */
  readonly #seen = new Map<string, BarrierSighting>();
  readonly #blocks = new Map<string, IdentityBlock>();
  readonly #waiters = new Map<string, Set<(s: BarrierSighting) => void>>();

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

  /** A barrier record arrived from the server (watchBarrier). */
  seen(s: BarrierSighting): void {
    const was = this.#seen.get(s.resource);
    if (was === undefined || s.seq < was.seq) this.#seen.set(s.resource, s);
    const waiting = this.#waiters.get(s.resource);
    this.#waiters.delete(s.resource);
    for (const w of waiting ?? []) w(s);
  }

  /** The barrier record seen for `resource` since the start, or null. */
  sighting(resource: string): BarrierSighting | null {
    return this.#seen.get(resource) ?? null;
  }

  /**
   * Resolves when a barrier record of `resource` arrives (a join waiting on
   * a chain it cannot validate); `happened` says it at once; `cancel`
   * forgets the wait.
   */
  whenSeen(resource: string): BarrierWatch {
    const happened = () => this.#seen.has(resource);
    const now = this.#seen.get(resource);
    if (now !== undefined) return { seen: Promise.resolve(now), happened, cancel: () => undefined };
    let waiter: ((s: BarrierSighting) => void) | undefined;
    const seen = new Promise<BarrierSighting>((resolve) => {
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

  /**
   * The SDK refused `resource`'s chain: when that is the refusal the
   * barrier seen gets (a chain error, or the parse error of its very type),
   * the block is recorded with `head`, the last validated head this device
   * holds. A block already recorded keeps its first head and record. True
   * when blocked.
   */
  async refused(resource: string, refusal: BarrierRefusal, head: string | null): Promise<boolean> {
    const s = this.#seen.get(resource);
    const confirms =
      s !== undefined &&
      (refusal.kind === "chain"
        ? BARRIER_ERROR_CODES.has(refusal.code)
        : ENTRY_TYPE[s.entry] === refusal.type);
    if (!confirms) return this.#blocks.has(resource);
    if (this.#blocks.has(resource)) return true;
    const block: IdentityBlock = {
      head,
      recordId: s.recordId,
      seq: String(s.seq),
      entry: s.entry,
      at: this.#now(),
    };
    this.#blocks.set(resource, block);
    await this.#store()?.put(BLOCK_PREFIX + resource, block);
    return true;
  }

  /** The Resource's chain validated (its session went LIVE): not blocked. */
  async validated(resource: string): Promise<void> {
    this.#seen.delete(resource);
    if (!this.#blocks.delete(resource)) return;
    await this.#store()?.put(BLOCK_PREFIX + resource, undefined);
  }

  /** The persisted block of `resource`, or null. */
  get(resource: string): IdentityBlock | null {
    return this.#blocks.get(resource) ?? null;
  }
}
