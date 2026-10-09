// One vault on one device for the two-vault E2E (LFCP-066): its own mock
// Obsidian app (vault files, secretStorage, vault-scoped local storage),
// its own IndexedDB install, and the real plugin, driven through its
// commands and vault events. The network is the platform WebSocket, tapped
// to record every frame (and to simulate going offline). Dialogs are
// answered by a script.

import "fake-indexeddb/auto";
import type { InvitationLink, WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import { vi } from "vitest";
import type { ResourceStatus } from "../../src/core/collab";
import type { Prompter } from "../../src/core/collab/commands";
import type { RuntimeEnv } from "../../src/core/lfcp/runtime";
import type OpenLfcpPlugin from "../../src/obsidian/plugin";
import * as mock from "../mocks/obsidian";

/** A frame on the wire, as this vault sent or received it. */
export interface Frame {
  readonly dir: "out" | "in";
  readonly bytes: Uint8Array;
}

type NativeSocket = {
  binaryType: string;
  readonly protocol: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

/** The platform WebSocket with every frame recorded; refuses to connect while offline. */
class Network {
  readonly frames: Frame[] = [];
  readonly #open = new Set<NativeSocket>();
  #offline = false;

  get offline(): boolean {
    return this.#offline;
  }

  set offline(value: boolean) {
    this.#offline = value;
    if (value) for (const s of [...this.#open]) s.close(4000, "offline (test)");
  }

  /** Closes every live socket (the process holding them died); the network itself stays as it is. */
  dropAll(): void {
    for (const s of [...this.#open]) s.close(4001, "process died (test)");
  }

  readonly factory: WebSocketFactory = (url, protocols) => {
    const frames = this.frames;
    const sockets = this.#open;
    if (this.#offline) return offlineSocket();
    const Ctor = (globalThis as { WebSocket?: new (u: string, p: string[]) => NativeSocket })
      .WebSocket;
    if (Ctor === undefined) throw new Error("no platform WebSocket");
    const inner = new Ctor(url, [...protocols]);
    sockets.add(inner);
    const outer: WebSocketLike = {
      get binaryType() {
        return inner.binaryType;
      },
      set binaryType(v: string) {
        inner.binaryType = v;
      },
      get protocol() {
        return inner.protocol;
      },
      send(data: Uint8Array) {
        frames.push({ dir: "out", bytes: Uint8Array.from(data) });
        inner.send(data);
      },
      close(code?: number, reason?: string) {
        inner.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    inner.onopen = (ev) => outer.onopen?.(ev);
    inner.onerror = (ev) => outer.onerror?.(ev);
    inner.onclose = (ev) => {
      sockets.delete(inner);
      outer.onclose?.(ev);
    };
    inner.onmessage = (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) frames.push({ dir: "in", bytes: new Uint8Array(data) });
      else if (ArrayBuffer.isView(data))
        frames.push({ dir: "in", bytes: new Uint8Array(data.buffer.slice(0)) });
      outer.onmessage?.(ev);
    };
    return outer;
  };
}

function offlineSocket(): WebSocketLike {
  const socket: WebSocketLike = {
    binaryType: "arraybuffer",
    protocol: "",
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  queueMicrotask(() => {
    socket.onerror?.({});
    socket.onclose?.({ code: 1006, reason: "offline (test)" });
  });
  return socket;
}

/** One scripted answer: a value, or a function choosing among the offered choices. */
export type Answer =
  | string
  | null
  | { readonly choose: (choices: readonly { label: string; value: unknown }[]) => unknown };

/** Answers dialogs in order; records notices, invitations and status views. */
export class ScriptedPrompter implements Prompter {
  readonly notices: string[] = [];
  readonly invitations: InvitationLink[] = [];
  readonly statuses: ResourceStatus[] = [];
  #script: Answer[] = [];

  script(answers: readonly Answer[]): void {
    this.#script = [...answers];
  }

  get pending(): number {
    return this.#script.length;
  }

  #next(what: string): Answer {
    if (this.#script.length === 0) throw new Error(`no scripted answer for "${what}"`);
    return this.#script.shift() as Answer;
  }

  notice(message: string): void {
    this.notices.push(message);
  }

  async text(options: { readonly title: string }): Promise<string | null> {
    const a = this.#next(options.title);
    if (a !== null && typeof a !== "string") throw new Error(`"${options.title}" wants text`);
    return a;
  }

  async choose<T>(options: {
    readonly title: string;
    readonly choices: readonly { label: string; value: T }[];
  }): Promise<T | null> {
    const a = this.#next(options.title);
    if (a === null) return null;
    if (typeof a === "string") {
      const hit = options.choices.find((c) => c.label === a);
      if (hit === undefined)
        throw new Error(
          `"${options.title}": no choice "${a}" in ${options.choices.map((c) => c.label).join(", ")}`,
        );
      return hit.value;
    }
    return a.choose(options.choices) as T;
  }

  async invitation(options: { readonly link: InvitationLink }): Promise<void> {
    this.invitations.push(options.link);
  }

  async status(status: ResourceStatus): Promise<void> {
    this.statuses.push(status);
  }

  progress(): { update(text: string): void; close(): void } {
    return { update: () => undefined, close: () => undefined };
  }
}

/**
 * With LFCP_E2E_NARRATE=1 the harness narrates what each vault does (a
 * reference transcript of the demo storyline); invitation links are never
 * printed.
 */
const NARRATE = process.env.LFCP_E2E_NARRATE === "1";
const shown = (a: Answer): string =>
  typeof a === "string"
    ? a.startsWith("lfcp://join/")
      ? "[the invitation link]"
      : JSON.stringify(a)
    : a === null
      ? "(cancel)"
      : "(choice)";
export function narrate(line: string): void {
  if (NARRATE) console.log(line);
}

export async function until<T>(
  what: string,
  f: () => T | undefined | Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Modules = {
  readonly plugin: typeof import("../../src/obsidian/plugin");
  readonly mock: typeof import("../mocks/obsidian");
  readonly env: typeof import("../../src/obsidian/lfcp-env");
};

/** The plugin's modules; `fresh` drops every module instance first (no singleton survives a restart). */
async function load(fresh: boolean): Promise<Modules> {
  if (fresh) vi.resetModules();
  const [plugin, mockModule, env] = await Promise.all([
    import("../../src/obsidian/plugin"),
    import("../mocks/obsidian"),
    import("../../src/obsidian/lfcp-env"),
  ]);
  return { plugin, mock: mockModule, env };
}

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

/** What one running plugin instance holds that a dead process would lose. */
class Instance {
  readonly intervals = new Set<ReturnType<typeof setInterval>>();
  readonly locks = new Set<() => void>();
}

/**
 * A vault: notes, commands and the plugin's state, for one user on one
 * device. Its persisted state (vault files, secretStorage, vault-scoped
 * local storage, the IndexedDB install) outlives restart().
 */
export class E2EVault {
  readonly app = new mock.App();
  readonly network = new Network();
  readonly prompter = new ScriptedPrompter();
  /** Commits that store a new Data Unit hang forever while set (a crash between apply and queue). */
  hangUnitCommits = false;
  readonly #heldLocks = new Set<string>();
  #mods!: Modules;
  #instance = new Instance();
  #plugin!: OpenLfcpPlugin;

  private constructor(readonly name: string) {}

  static async open(name: string): Promise<E2EVault> {
    const v = new E2EVault(name);
    await v.#start(false);
    return v;
  }

  async #start(fresh: boolean): Promise<void> {
    this.#mods = await load(fresh);
    this.#instance = new Instance();
    const self = this;
    const instance = this.#instance;
    const Base = this.#mods.plugin.default;
    const env = this.#mods.env;
    class Plugin extends Base {
      protected override runtimeEnv(): RuntimeEnv {
        return self.#env(env.obsidianRuntimeEnv(this.app), instance);
      }
      protected override createPrompter(): Prompter {
        return self.prompter;
      }
    }
    this.#plugin = new Plugin(this.app as never, manifest as never);
    await this.#plugin.onload();
    await this.#plugin.whenRuntimeStarted();
  }

  #env(base: RuntimeEnv, instance: Instance): RuntimeEnv {
    return {
      ...base,
      webSocket: this.network.factory,
      tickMs: 20,
      timers: {
        setInterval: (fn, ms) => {
          const h = setInterval(fn, ms);
          instance.intervals.add(h);
          return h;
        },
        clearInterval: (h) => {
          clearInterval(h as ReturnType<typeof setInterval>);
          instance.intervals.delete(h as ReturnType<typeof setInterval>);
        },
        now: () => Date.now(),
      },
      // The device's writer lock; a dead process releases it.
      acquireLock: async (lockName) => {
        if (this.#heldLocks.has(lockName)) return null;
        this.#heldLocks.add(lockName);
        const release = () => {
          this.#heldLocks.delete(lockName);
          instance.locks.delete(release);
        };
        instance.locks.add(release);
        return { release };
      },
      openStorage: async (dbName, onReserved, secrets) => {
        const storage = await base.openStorage(dbName, onReserved, secrets);
        const hangs = (writes: readonly { op: string }[]) =>
          this.hangUnitCommits && writes.some((w) => w.op === "put-data-unit");
        return {
          control: storage.control,
          dataUnits: storage.dataUnits,
          keyPackages: storage.keyPackages,
          snapshots: storage.snapshots,
          resources: storage.resources,
          outbound: storage.outbound,
          localMarks: storage.localMarks,
          profileState: storage.profileState,
          syncState: storage.syncState,
          meta: storage.meta,
          actorSequences: storage.actorSequences,
          snapshotSequences: storage.snapshotSequences,
          counters: () => storage.counters(),
          close: () => storage.close(),
          commit: (writes) =>
            hangs(writes) ? new Promise(() => undefined) : storage.commit(writes),
        };
      },
    };
  }

  /**
   * A new plugin instance over the same persisted state, from fresh module
   * instances. "clean": the plugin is disabled first (onunload, runtime
   * stop). "crash": the instance just dies: its sockets, timers, lock and
   * vault event handlers go away, nothing is stopped or flushed.
   */
  async restart(kind: "clean" | "crash"): Promise<void> {
    await this.shutdown(kind);
    await this.boot();
  }

  /** Stops ("clean") or kills ("crash") the running instance; the persisted state stays. */
  async shutdown(kind: "clean" | "crash"): Promise<void> {
    if (kind === "clean") await this.close();
    else this.#die();
  }

  /** Starts a new plugin instance from fresh modules over the persisted state. */
  async boot(): Promise<void> {
    await this.#start(true);
  }

  #die(): void {
    const host = this.host;
    for (const ref of host.events.splice(0)) this.app.vault.offref(ref as never);
    this.#plugin.changes.close();
    for (const h of this.#instance.intervals) clearInterval(h);
    this.#instance.intervals.clear();
    for (const release of [...this.#instance.locks]) release();
    this.network.dropAll();
  }

  get plugin(): OpenLfcpPlugin {
    return this.#plugin;
  }

  get host(): mock.Plugin {
    return this.#plugin as unknown as mock.Plugin;
  }

  get runtime() {
    const r = this.#plugin.runtime;
    if (r === null) throw new Error(`${this.name}: no runtime (${this.#plugin.runtimeError})`);
    return r;
  }

  /** Waits until queued projection work is done. */
  async settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      this.#plugin.changes.flush();
      await Promise.resolve();
      await this.#plugin.lastProjection;
    }
  }

  read(path: string): string {
    return this.app.vault.files.get(path) ?? "";
  }

  /** The user saves `text` to `path` (any editor): a vault create or modify event. */
  async write(path: string, text: string): Promise<void> {
    const existed = this.app.vault.files.has(path);
    this.app.vault.files.set(path, text);
    this.app.vault.trigger(existed ? "modify" : "create", { path });
    await this.settle();
  }

  /** The user edits one line of a note. */
  async editLine(path: string, from: string, to: string): Promise<void> {
    const text = this.read(path);
    if (!text.includes(from)) throw new Error(`${this.name}/${path} has no "${from}"`);
    narrate(`[${this.name}] edits ${path}: "${from}" → "${to}"`);
    await this.write(path, text.replace(from, to));
  }

  /** Focuses `path` with the cursor on the line containing `contains`. */
  focus(path: string, contains: string): void {
    const text = this.read(path);
    const line = text.split(/\r?\n/).findIndex((l) => l.includes(contains));
    if (line < 0) throw new Error(`${this.name}/${path}: no line with "${contains}"`);
    // The current module instance's class (the plugin checks instanceof against it).
    const view = new this.#mods.mock.MarkdownView({ path }, text);
    view.cursorLine = line;
    this.app.workspace.activeView = view as never;
  }

  /** Runs a command palette command with scripted answers; resolves on its final notice. */
  async command(
    id: string,
    answers: readonly Answer[] = [],
    done?: () => boolean,
  ): Promise<string> {
    const command = this.host.commands.find((c) => c.id === id);
    if (command === undefined) throw new Error(`no command ${id}`);
    this.prompter.script(answers);
    narrate(
      `[${this.name}] runs "${command.name}"${answers.length > 0 ? ` and answers ${answers.map(shown).join(", ")}` : ""}`,
    );
    const notices = this.prompter.notices.length;
    const invitations = this.prompter.invitations.length;
    command.callback?.();
    await until(
      `${this.name}: ${id} to finish`,
      () =>
        done?.() ??
        (this.prompter.notices.length > notices || this.prompter.invitations.length > invitations),
      60_000,
    );
    await this.settle();
    if (this.prompter.pending > 0)
      throw new Error(`${id}: ${this.prompter.pending} answers unused`);
    const notice = this.prompter.notices.at(-1) ?? "";
    narrate(
      `[${this.name}]   ↳ ${this.prompter.invitations.length > invitations ? "an invitation link is shown (a secret)" : notice}`,
    );
    return notice;
  }

  async close(): Promise<void> {
    this.host.unload();
    await this.#plugin.stopRuntime();
  }
}
