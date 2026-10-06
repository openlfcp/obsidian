// The local LFCP install of one vault on one device (LFCP-059, ST-3):
// which database and secret namespace are this vault's, and whether its
// Principal may write. Obsidian-free: the adapter supplies the device-local
// key-value store, the secret slots and the storage opener.
//
// Three records must agree:
//   1. the install ID in a device-local, vault-scoped key-value store
//      (Obsidian: app.saveLocalStorage) — never inside the vault, so a
//      synced or copied vault never carries it;
//   2. the `install` meta row of the IndexedDB database `openlfcp-v1-<id>`;
//   3. the marker secret `openlfcp-<id>-marker`, which also mirrors the
//      high-water mark of every sequence counter.
// Any partial or mismatched state LOCKS the Principal: no sequence is ever
// reserved, so a restored, evicted or copied state can never reuse one. The
// user may then create a new Principal, which starts a new install ID; the
// old namespace is never reused (secretStorage has no delete, so its slots
// stay behind).

import {
  fromHex,
  LfcpError,
  type PrincipalId,
  principalId,
  secureRandom,
  toHex,
} from "@openlfcp/core";
import {
  type AgreementKeyPair,
  exportSecretKeyBytes,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  importAgreementKey,
  importSigningKey,
} from "@openlfcp/crypto";
import { type LfcpStorage, principalKeySecretRef } from "@openlfcp/storage";
import type { ReservedSequence } from "@openlfcp/storage-idb";
import { principalDescriptorFromKeys, type Signer } from "@openlfcp/wire";
import { isInstallId, markerSlotId, type SecretSlots, SlotSecretStore } from "./secrets";

/** The device-local, vault-scoped key-value store (never synced with the vault). */
export interface LocalKeyValue {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

/** LfcpStorage plus what the install needs from @openlfcp/storage-idb. */
export interface InstallStorage extends LfcpStorage {
  readonly meta: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
  counters(): Promise<ReadonlyMap<string, bigint>>;
  close(): void;
}

export interface InstallEnv {
  readonly local: LocalKeyValue;
  readonly slots: SecretSlots;
  /** Opens the install's database; `onReserved` runs after each durable reservation. */
  openStorage(name: string, onReserved: (r: ReservedSequence) => void): Promise<InstallStorage>;
  /** Asks the runtime to keep the storage from eviction (navigator.storage.persist). */
  persist?(): Promise<boolean>;
}

export const INSTALL_KEY = "openlfcp-install";
export const databaseName = (installId: string): string => `openlfcp-v1-${installId}`;

export type LockReason =
  /** No install records at all where an install ID exists. */
  | "state-missing"
  /** The database lost its install row (wiped or evicted). */
  | "database-missing"
  /** The marker secret is gone (secret store reset, another device). */
  | "marker-missing"
  /** The records name different installs or Principals. */
  | "mismatch"
  /** The Principal's private keys are missing or do not match it. */
  | "keys-missing"
  /** A sequence counter is below its mirrored high-water mark (a restored or rolled-back database). */
  | "database-behind"
  /** Another instance holds this install's writer lock. */
  | "lock-held";

export const LOCK_MESSAGES: Readonly<Record<LockReason, string>> = {
  "state-missing": "This vault's local Shared Tasks state is missing.",
  "database-missing":
    "This vault's local Shared Tasks database was cleared or evicted, so its write sequences are lost.",
  "marker-missing": "This device's Shared Tasks secrets for this vault are missing.",
  mismatch: "This vault's local Shared Tasks records do not belong together.",
  "keys-missing": "This vault's Shared Tasks private keys are missing.",
  "database-behind":
    "This vault's local Shared Tasks database is older than the writes it already made (restored from a backup?).",
  "lock-held": "Another Shared Tasks instance is using this vault's local state.",
};

/** The local Principal: public identity plus its keys (never shown or exported). */
export interface LocalPrincipal {
  readonly id: PrincipalId;
  readonly signer: Signer;
  readonly agreement: AgreementKeyPair;
}

export type Install =
  | {
      readonly kind: "ready";
      readonly installId: string;
      readonly principal: LocalPrincipal;
      readonly storage: InstallStorage;
      readonly secrets: SlotSecretStore;
      /** Whether the runtime promised not to evict the storage (null: unknown). */
      readonly persisted: boolean | null;
    }
  | {
      readonly kind: "locked";
      readonly installId: string;
      readonly reason: LockReason;
      /** The Principal the records name, when known (public). */
      readonly principalId: PrincipalId | null;
      /** Opened read-only in spirit: every sequence reservation is refused. */
      readonly storage: InstallStorage | null;
    };

interface Marker {
  readonly v: 1;
  readonly installId: string;
  readonly principal: string;
  /** Counter key -> high-water mark (decimal). */
  readonly hw: Record<string, string>;
}

interface Meta {
  readonly v: 1;
  readonly installId: string;
  readonly principal: string;
  readonly persisted?: boolean | null;
}

/** Thrown by every sequence reservation of a locked install. */
export class InstallLockedError extends LfcpError {
  constructor(reason: LockReason) {
    super("UNSUPPORTED_VALUE", `Shared Tasks is locked for writing: ${LOCK_MESSAGES[reason]}`);
  }
}

const readMarker = (slots: SecretSlots, installId: string): Marker | undefined => {
  const raw = slots.get(markerSlotId(installId));
  if (raw === null || raw === "") return undefined;
  try {
    const m = JSON.parse(raw) as Marker;
    return m.v === 1 && typeof m.principal === "string" && typeof m.hw === "object" ? m : undefined;
  } catch {
    return undefined;
  }
};

const isMeta = (v: unknown): v is Meta =>
  typeof v === "object" &&
  v !== null &&
  (v as Meta).v === 1 &&
  typeof (v as Meta).installId === "string" &&
  typeof (v as Meta).principal === "string";

/** A storage whose reservations always fail (a locked install); everything else delegates. */
function lockedStorage(storage: InstallStorage, reason: LockReason): InstallStorage {
  const refuse = () => Promise.reject(new InstallLockedError(reason));
  return {
    control: storage.control,
    dataUnits: storage.dataUnits,
    keyPackages: storage.keyPackages,
    snapshots: storage.snapshots,
    resources: storage.resources,
    outbound: storage.outbound,
    profileState: storage.profileState,
    syncState: storage.syncState,
    localMarks: storage.localMarks,
    meta: storage.meta,
    actorSequences: { reserveNext: refuse },
    snapshotSequences: { reserveNext: refuse },
    commit: (writes) => storage.commit(writes),
    counters: () => storage.counters(),
    close: () => storage.close(),
  };
}

/** Mirrors each durable reservation into the marker before it is used. */
function mirror(slots: SlotsRef): (r: ReservedSequence) => void {
  return (r) => {
    const m = slots.marker;
    if (m === undefined) throw new InstallLockedError("marker-missing");
    const next: Marker = { ...m, hw: { ...m.hw, [r.key]: r.value.toString() } };
    slots.slots.set(markerSlotId(m.installId), JSON.stringify(next));
    slots.marker = next;
  };
}

interface SlotsRef {
  readonly slots: SecretSlots;
  marker: Marker | undefined;
}

async function loadPrincipal(
  secrets: SlotSecretStore,
  id: PrincipalId,
): Promise<LocalPrincipal | undefined> {
  const signingBytes = await secrets.get(principalKeySecretRef(id, "signing"));
  const agreementBytes = await secrets.get(principalKeySecretRef(id, "agreement"));
  if (signingBytes === undefined || agreementBytes === undefined) return undefined;
  const key = importSigningKey(signingBytes);
  const agreement = importAgreementKey(agreementBytes);
  signingBytes.fill(0);
  agreementBytes.fill(0);
  const descriptor = principalDescriptorFromKeys(key, agreement);
  if (toHex(descriptor.principalId) !== toHex(id)) return undefined;
  return { id, signer: { key, descriptor }, agreement };
}

/**
 * Opens this vault's install, creating one (and a new Principal) when the
 * device has none for this vault. Local only: never touches the network.
 */
export async function openInstall(env: InstallEnv): Promise<Install> {
  const installId = env.local.load(INSTALL_KEY);
  if (!isInstallId(installId)) return createInstall(env);

  const ref: SlotsRef = { slots: env.slots, marker: undefined };
  const storage = await env.openStorage(databaseName(installId), mirror(ref));
  const meta = await storage.meta.get("install");
  const marker = readMarker(env.slots, installId);
  const locked = (reason: LockReason, principal: string | undefined): Install => ({
    kind: "locked",
    installId,
    reason,
    principalId: principal === undefined ? null : principalId(fromHex(principal)),
    storage: lockedStorage(storage, reason),
  });

  if (!isMeta(meta) && marker === undefined) return locked("state-missing", undefined);
  if (!isMeta(meta)) return locked("database-missing", marker?.principal);
  if (marker === undefined) return locked("marker-missing", meta.principal);
  if (
    meta.installId !== installId ||
    marker.installId !== installId ||
    meta.principal !== marker.principal
  )
    return locked("mismatch", meta.principal);

  const secrets = new SlotSecretStore(env.slots, installId);
  const principal = await loadPrincipal(secrets, principalId(fromHex(meta.principal)));
  if (principal === undefined) return locked("keys-missing", meta.principal);

  const counters = await storage.counters();
  for (const [key, hw] of Object.entries(marker.hw))
    if ((counters.get(key) ?? 0n) < BigInt(hw)) return locked("database-behind", meta.principal);

  ref.marker = marker;
  return {
    kind: "ready",
    installId,
    principal,
    storage,
    secrets,
    persisted: meta.persisted ?? null,
  };
}

/**
 * A new install with a new Principal. Order: the keys, then the marker, then
 * the database row, and the install ID last, so a crash part way leaves an
 * unused namespace behind, never a half-made install.
 */
export async function createInstall(env: InstallEnv): Promise<Install> {
  const installId = toHex(secureRandom(16));
  const ref: SlotsRef = { slots: env.slots, marker: undefined };
  const storage = await env.openStorage(databaseName(installId), mirror(ref));
  const secrets = new SlotSecretStore(env.slots, installId);
  const signing = generateSigningKeyPair();
  const agreement = generateAgreementKeyPair();
  const descriptor = principalDescriptorFromKeys(signing, agreement);
  const id = descriptor.principalId;
  await secrets.put(principalKeySecretRef(id, "signing"), exportSecretKeyBytes(signing));
  await secrets.put(principalKeySecretRef(id, "agreement"), exportSecretKeyBytes(agreement));
  const marker: Marker = { v: 1, installId, principal: toHex(id), hw: {} };
  env.slots.set(markerSlotId(installId), JSON.stringify(marker));
  const persisted = env.persist === undefined ? null : await env.persist().catch(() => false);
  await storage.meta.put("install", {
    v: 1,
    installId,
    principal: toHex(id),
    persisted,
  } satisfies Meta);
  env.local.save(INSTALL_KEY, installId);
  ref.marker = marker;
  return {
    kind: "ready",
    installId,
    principal: { id, signer: { key: signing, descriptor }, agreement },
    storage,
    secrets,
    persisted,
  };
}
