// The Obsidian side of the LFCP runtime (LFCP-059): where this vault's
// state lives on this device.
//
// - Install ID: app.saveLocalStorage (vault-scoped, device-local; never in
//   the vault, so a synced or copied vault does not carry it).
// - Secrets: app.secretStorage (device-level, shared by all vaults; the
//   SlotSecretStore namespaces them per install).
// - Storage: IndexedDB through @openlfcp/storage-idb, in the app's profile
//   directory, outside the vault (no sync provider ever sees the plaintext
//   profile checkpoints or the sequence counters).
// - Eviction: navigator.storage.persist() on first run; the result shows in
//   settings. Writer lock: navigator.locks.
// - Timers and the WebSocket are the window's.

import { IdbLfcpStorage } from "@openlfcp/storage-idb";
import type { App } from "obsidian";
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
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  const locks = nav?.locks;
  const persist = nav?.storage?.persist;
  return {
    local: {
      load: (key) => app.loadLocalStorage(key),
      save: (key, value) => app.saveLocalStorage(key, value),
    },
    slots: {
      get: (id) => app.secretStorage.getSecret(id),
      set: (id, value) => app.secretStorage.setSecret(id, value),
    },
    openStorage: (name, onReserved) => IdbLfcpStorage.open(name, { onReserved }),
    ...(persist === undefined ? {} : { persist: () => persist.call(nav?.storage) }),
    ...(locks === undefined ? {} : { acquireLock: (name) => acquireWebLock(locks, name) }),
    timers: {
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
      now: () => Date.now(),
    },
  };
}
