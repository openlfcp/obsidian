// One vault on one device for the two-vault E2E (LFCP-066): its own mock
// Obsidian app (vault files, secretStorage, vault-scoped local storage),
// its own IndexedDB install, and the real plugin, driven through its
// commands and vault events. The network is the platform WebSocket, tapped
// to record every frame (and to simulate going offline). Dialogs are
// answered by a script.

import "fake-indexeddb/auto";
import type { InvitationLink, WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import type { ResourceStatus } from "../../src/core/collab";
import type { Prompter } from "../../src/core/collab/commands";
import type { RuntimeEnv } from "../../src/core/lfcp/runtime";
import { obsidianRuntimeEnv } from "../../src/obsidian/lfcp-env";
import OpenLfcpPlugin from "../../src/obsidian/plugin";
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

const manifest = { id: "openlfcp", name: "OpenLFCP", version: "0.0.0" };

class E2EPlugin extends OpenLfcpPlugin {
  network!: Network;
  scripted!: ScriptedPrompter;
  protected override runtimeEnv(): RuntimeEnv {
    return { ...obsidianRuntimeEnv(this.app), webSocket: this.network.factory, tickMs: 20 };
  }
  protected override createPrompter(): Prompter {
    return this.scripted;
  }
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

/** A vault: notes, commands and the plugin's state, for one user on one device. */
export class E2EVault {
  readonly app = new mock.App();
  readonly network = new Network();
  readonly prompter = new ScriptedPrompter();
  readonly plugin: E2EPlugin;
  readonly host: mock.Plugin;

  private constructor(readonly name: string) {
    this.plugin = new E2EPlugin(this.app as never, manifest as never);
    // Set before onload: the runtime and the commands read them from there.
    this.plugin.network = this.network;
    this.plugin.scripted = this.prompter;
    this.host = this.plugin as unknown as mock.Plugin;
  }

  static async open(name: string): Promise<E2EVault> {
    const v = new E2EVault(name);
    await v.plugin.onload();
    const runtime = await v.plugin.whenRuntimeStarted();
    if (runtime === null || runtime.status.kind !== "ready")
      throw new Error(`${name}: the runtime did not start (${v.plugin.runtimeError})`);
    return v;
  }

  get runtime() {
    const r = this.plugin.runtime;
    if (r === null) throw new Error(`${this.name}: no runtime`);
    return r;
  }

  /** Waits until queued projection work is done. */
  async settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      this.plugin.changes.flush();
      await Promise.resolve();
      await this.plugin.lastProjection;
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
    await this.write(path, text.replace(from, to));
  }

  /** Focuses `path` with the cursor on the line containing `contains`. */
  focus(path: string, contains: string): void {
    const text = this.read(path);
    const line = text.split(/\r?\n/).findIndex((l) => l.includes(contains));
    if (line < 0) throw new Error(`${this.name}/${path}: no line with "${contains}"`);
    const view = new mock.MarkdownView({ path }, text);
    view.cursorLine = line;
    this.app.workspace.activeView = view;
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
    return this.prompter.notices.at(-1) ?? "";
  }

  async close(): Promise<void> {
    this.host.unload();
    await this.plugin.stopRuntime();
  }
}
