// Installs left behind by "Create a new identity" (design 419 (b), decision
// I31): their keys and database stay on the device until the user deletes
// them. Never automatic, never exported.
//
// An install's namespace (install.ts): the IndexedDB database
// `openlfcp-v1-<id>`, the marker slot `openlfcp-<id>-marker`, and secret slots
// `openlfcp-<sha256(id\nref)[:55]>`. Obsidian's secret storage is shared by
// every vault on the device and its slot IDs are hashes, so an install's
// slots are found only by recomputing them from references its own database
// and records name; never by listing or by prefix, which would reach other
// vaults' keys. Only slots that hold a value are blanked.

import { pairingSecretRef, pendingDekRef } from "@openlfcp/client";
import { dataEpoch, fromHex, principalId, type ResourceId, toHex } from "@openlfcp/core";
import {
  dekSecretRef,
  localStateKeyRef,
  principalKeySecretRef,
  type SecretRef,
} from "@openlfcp/storage";
import {
  databaseName,
  INSTALL_KEY,
  type InstallEnv,
  type LocalKeyValue,
  type LockReason,
} from "./install";
import { isInstallId, markerSlotId, SlotSecretStore, secretSlotId } from "./secrets";

/** The device-local, vault-scoped list of retired installs (beside the install ID). */
export const RETIRED_KEY = "openlfcp-retired-installs";

export interface RetiredInstall {
  readonly installId: string;
  /** The retired install's Principal (hex), when it was known. */
  readonly principal: string | null;
  /** Why it was locked when a new identity replaced it. */
  readonly reason: LockReason | null;
  /** Milliseconds since the epoch. */
  readonly retiredAt: number;
}

const isRetired = (v: unknown): v is RetiredInstall =>
  typeof v === "object" &&
  v !== null &&
  isInstallId((v as RetiredInstall).installId) &&
  typeof (v as RetiredInstall).retiredAt === "number";

/** The installs this vault retired on this device (0.7.4 on; earlier ones were not recorded). */
export function retiredInstalls(local: LocalKeyValue): RetiredInstall[] {
  const v = local.load(RETIRED_KEY);
  return Array.isArray(v) ? v.filter(isRetired) : [];
}

/** Records `entry` before the install ID is replaced; once per install. */
export function recordRetired(local: LocalKeyValue, entry: RetiredInstall): void {
  const list = retiredInstalls(local).filter((r) => r.installId !== entry.installId);
  local.save(RETIRED_KEY, [...list, entry]);
}

/** What deleteRetiredInstall needs beyond the install environment. */
export interface RetiredEnv extends InstallEnv {
  /** Deletes an IndexedDB database by name (Obsidian: indexedDB.deleteDatabase). */
  deleteStorage?(name: string): Promise<void>;
  /** The install's writer lock: deletion holds it, so no window uses the old data. */
  acquireLock?(name: string): Promise<{ release(): void } | null>;
}

export type RetiredDeletion =
  /** The database and every secret it names are gone, and the entry removed. */
  | { readonly kind: "deleted"; readonly blanked: number }
  /**
   * Deleted what could be found: the database was already gone (its
   * references with it), or it cannot be deleted here. The entry is removed.
   */
  | { readonly kind: "partial"; readonly blanked: number }
  /** Another window holds the install's lock: nothing done. */
  | { readonly kind: "busy" };

const HEX64 = /^[0-9a-f]{64}$/;
/** Local state key generations tried at least (LFCP-02-098: one per key rotation). */
const LOCAL_STATE_GENERATIONS = 64;

/**
 * Deletes a retired install's data: every secret slot its records name
 * (principal keys, the DEKs of its stored epochs, pending rotation DEKs and
 * pairing secrets of its journal, its local state keys), its marker, and
 * its database; then removes it from the list. Refuses the current install.
 */
export async function deleteRetiredInstall(
  env: RetiredEnv,
  entry: RetiredInstall,
): Promise<RetiredDeletion> {
  if (env.local.load(INSTALL_KEY) === entry.installId)
    throw new Error("the current install is not a retired one");
  const id = entry.installId;
  const lock = env.acquireLock === undefined ? null : await env.acquireLock(`openlfcp-${id}`);
  if (env.acquireLock !== undefined && lock === null) return { kind: "busy" };
  try {
    const refs = new Set<SecretRef>();
    const principals = new Set<string>();
    if (entry.principal !== null) principals.add(entry.principal);
    const marker = env.slots.get(markerSlotId(id));
    if (marker !== null && marker !== "") {
      try {
        const m = JSON.parse(marker) as { principal?: unknown };
        if (typeof m.principal === "string") principals.add(m.principal);
      } catch {
        // An unreadable marker names nothing; it is blanked below.
      }
    }
    let databaseFound = false;
    const storage = await env.openStorage(
      databaseName(id),
      () => undefined,
      new SlotSecretStore(env.slots, id),
    );
    try {
      // The local state keyrings (LFCP-02-098): the storage's and the plugin's sealed state
      // (local-seal.ts), each with its own ID and generations, in its meta row.
      for (const row of ["local-state", "plugin-local-state"]) {
        const keyring = (await storage.meta.get(row)) as
          | { installId?: unknown; generation?: unknown }
          | undefined;
        if (keyring === undefined || keyring === null || typeof keyring.installId !== "string")
          continue;
        if (!/^[A-Za-z0-9._-]{1,190}$/.test(keyring.installId)) continue;
        const top = typeof keyring.generation === "number" ? keyring.generation : 0;
        for (let g = 0; g <= Math.max(top, LOCAL_STATE_GENERATIONS); g++)
          refs.add(localStateKeyRef(keyring.installId, g));
      }
      const meta = (await storage.meta.get("install")) as { principal?: unknown } | undefined;
      if (meta !== undefined && meta !== null) {
        databaseFound = true;
        if (typeof meta.principal === "string") principals.add(meta.principal);
      }
      for (const r of await storage.resources.list()) {
        const R = r.resourceId as ResourceId;
        for (const e of await storage.control.epochs(R)) {
          refs.add(dekSecretRef(R, dataEpoch(e.epoch)));
          if (e.dekRef !== null) refs.add(e.dekRef as SecretRef);
        }
      }
      for (const mark of await storage.localMarks.list("identity-op:")) {
        let op: { id?: unknown; phases?: unknown };
        try {
          op = JSON.parse(mark.value) as typeof op;
        } catch {
          continue;
        }
        const operation = typeof op.id === "string" ? op.id : undefined;
        const phases = Array.isArray(op.phases)
          ? (op.phases as { kind?: unknown; resource?: unknown }[])
          : [];
        for (const p of phases)
          if (
            operation !== undefined &&
            p.kind === "rotate" &&
            typeof p.resource === "string" &&
            HEX64.test(p.resource)
          )
            refs.add(pendingDekRef(fromHex(p.resource) as ResourceId, operation));
        // A pairing device's secret is named by its Principal ID wherever the operation names it.
        for (const v of mark.value.match(/[0-9a-f]{64}/g) ?? [])
          refs.add(pairingSecretRef(principalId(fromHex(v))));
      }
    } finally {
      storage.close();
    }
    for (const p of principals)
      if (HEX64.test(p)) {
        refs.add(principalKeySecretRef(principalId(fromHex(p)), "signing"));
        refs.add(principalKeySecretRef(principalId(fromHex(p)), "agreement"));
      }
    let blanked = 0;
    const blank = (slot: string) => {
      const v = env.slots.get(slot);
      if (v === null || v === "") return;
      env.slots.set(slot, "");
      blanked++;
    };
    for (const ref of refs) blank(secretSlotId(id, ref));
    blank(markerSlotId(id));
    if (env.deleteStorage !== undefined) await env.deleteStorage(databaseName(id));
    env.local.save(
      RETIRED_KEY,
      retiredInstalls(env.local).filter((r) => r.installId !== id),
    );
    return databaseFound && env.deleteStorage !== undefined
      ? { kind: "deleted", blanked }
      : { kind: "partial", blanked };
  } finally {
    lock?.release();
  }
}

/** A Principal ID (hex) of a locked install, when known. */
export const principalHex = (p: Uint8Array | null): string | null => (p === null ? null : toHex(p));
