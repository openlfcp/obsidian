// The Obsidian side of the LFCP runtime (LFCP-059): where this vault's
// state lives on this device.
//
// - Install ID: app.saveLocalStorage (vault-scoped, device-local; never in
//   the vault, so a synced or copied vault does not carry it).
// - Secrets: app.secretStorage (device-level, shared by all vaults; the
//   SlotSecretStore namespaces them per install).
// - Storage: IndexedDB through @openlfcp/storage-idb, in the app's profile
//   directory, outside the vault (no sync provider ever sees it). Profile
//   checkpoints are sealed with the install's local state key, kept in
//   app.secretStorage (LFCP-02-098).
// - Eviction: navigator.storage.persist() on first run; the result shows in
//   settings. Writer lock: navigator.locks.
// - Timers and the WebSocket are the window's.

import { localStateCipher } from "@openlfcp/crypto";
import { IdbLfcpStorage } from "@openlfcp/storage-idb";
import { type App, Platform } from "obsidian";
import type { HeldLock, RuntimeEnv } from "../core/lfcp/runtime";

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>;
}

interface NavigatorLike {
  readonly storage?: { persist?(): Promise<boolean> };
  readonly locks?: LockManagerLike;
}

/** Whether `storage` offers navigator.storage.persist(). */
const canPersist = (
  storage: NavigatorLike["storage"],
): storage is { persist(): Promise<boolean> } => typeof storage?.persist === "function";

/** Holds a Web Lock until released; null when another holder has it. */
async function acquireWebLock(locks: LockManagerLike, name: string): Promise<HeldLock | null> {
  return new Promise((resolve) => {
    let release: () => void = () => undefined;
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolve(null);
        return undefined;
      }
      return new Promise<void>((done) => {
        release = done;
        resolve({ release: () => release() });
      });
    });
  });
}

export function obsidianRuntimeEnv(app: App): RuntimeEnv {
  const nav: NavigatorLike | undefined = window.navigator;
  const locks = nav?.locks;
  const storage = nav?.storage;
  return {
    local: {
      load: (key): unknown => {
        const value: unknown = app.loadLocalStorage(key);
        return value;
      },
      save: (key, value) => app.saveLocalStorage(key, value),
    },
    slots: {
      get: (id) => app.secretStorage.getSecret(id),
      set: (id, value) => app.secretStorage.setSecret(id, value),
    },
    openStorage: (name, onReserved, secrets) =>
      IdbLfcpStorage.open(name, { onReserved, localState: { secrets, cipher: localStateCipher } }),
    ...(canPersist(storage) ? { persist: () => storage.persist() } : {}),
    ...(locks === undefined ? {} : { acquireLock: (name) => acquireWebLock(locks, name) }),
    // LFCP-02-095 (V3): shared sections are read-only on Obsidian mobile.
    sectionsReadOnly: Platform.isMobile,
    timers: {
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (h) => window.clearInterval(h as number),
      now: () => Date.now(),
    },
  };
}
