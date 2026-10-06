// Test doubles for the LFCP runtime (LFCP-059): an in-memory stand-in for
// Obsidian's secretStorage (same ID rule and error), a vault-scoped local store,
// counted timers and a WebSocket that never connects (offline). IndexedDB is
// fake-indexeddb, so the storage itself is the real IdbLfcpStorage.

import "fake-indexeddb/auto";
import type { WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import { IdbLfcpStorage } from "@openlfcp/storage-idb";
import type { InstallStorage, LocalKeyValue } from "../../src/core/lfcp/install";
import type { HeldLock, RuntimeEnv, Timers } from "../../src/core/lfcp/runtime";
import type { SecretSlots } from "../../src/core/lfcp/secrets";
import { checkSecretId } from "../mocks/obsidian";

/** Obsidian SecretStorage semantics: IDs per checkSecretId, no delete. */
export class FakeSecretSlots implements SecretSlots {
  readonly values = new Map<string, string>();
  get(id: string): string | null {
    checkSecretId(id);
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string): void {
    checkSecretId(id);
    this.values.set(id, value);
  }
}

export class FakeLocal implements LocalKeyValue {
  readonly values = new Map<string, unknown>();
  load(key: string): unknown {
    return this.values.get(key) ?? null;
  }
  save(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
}

/** Real intervals, counted, so a test can check none is left behind. */
export class CountedTimers implements Timers {
  readonly active = new Set<ReturnType<typeof setInterval>>();
  setInterval(fn: () => void, ms: number): unknown {
    const h = setInterval(fn, ms);
    this.active.add(h);
    return h;
  }
  clearInterval(handle: unknown): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
    this.active.delete(handle as ReturnType<typeof setInterval>);
  }
  now(): number {
    return Date.now();
  }
}

/** Sockets that fail to connect, like a device without network. */
export class OfflineSockets {
  readonly opened: { url: string; socket: WebSocketLike; closed: boolean }[] = [];
  readonly factory: WebSocketFactory = (url) => {
    const entry = { url, socket: undefined as unknown as WebSocketLike, closed: false };
    const socket: WebSocketLike = {
      binaryType: "arraybuffer",
      protocol: "",
      send: () => undefined,
      close: () => {
        entry.closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    entry.socket = socket;
    this.opened.push(entry);
    queueMicrotask(() => {
      socket.onerror?.({});
      socket.onclose?.({ code: 1006, reason: "offline" });
    });
    return socket;
  };
}

/** One device: its secret slots, its vault-scoped local store, its locks. */
export class Device {
  readonly slots = new FakeSecretSlots();
  readonly locks = new Set<string>();
  readonly timers = new CountedTimers();
  readonly sockets = new OfflineSockets();
  persistResult: boolean | undefined = true;

  /** navigator.locks semantics with ifAvailable: null when already held. */
  async acquireLock(name: string): Promise<HeldLock | null> {
    if (this.locks.has(name)) return null;
    this.locks.add(name);
    return { release: () => this.locks.delete(name) };
  }

  /** The environment of one vault on this device. */
  env(local: FakeLocal, extra: Partial<RuntimeEnv> = {}): RuntimeEnv {
    return {
      local,
      slots: this.slots,
      openStorage: (name, onReserved): Promise<InstallStorage> =>
        IdbLfcpStorage.open(name, { onReserved }),
      ...(this.persistResult === undefined
        ? {}
        : { persist: async () => this.persistResult as boolean }),
      timers: this.timers,
      webSocket: this.sockets.factory,
      acquireLock: (name) => this.acquireLock(name),
      tickMs: 20,
      ...extra,
    };
  }
}

export const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
