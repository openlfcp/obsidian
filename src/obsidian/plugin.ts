// The Obsidian adapter: plugin lifecycle, commands and the settings tab.
// Only files under src/obsidian/ may import `obsidian`
// (scripts/check-boundaries.mjs); everything else lives in src/core/.
//
// Lifecycle (LFCP-059): onload registers commands, settings and the vault
// change listener, then starts the LFCP runtime in the background (local
// only: Automerge, the install, the writer lock; never the network), so
// loading never waits on a server. onunload stops every session and timer
// and closes the local state; pending outbound objects stay stored.

import { Notice, Plugin, type TAbstractFile } from "obsidian";
import { COMMANDS, notImplementedMessage } from "../core/commands";
import { LfcpRuntime, type RuntimeEnv } from "../core/lfcp/runtime";
import { ProjectionEngine, type ProjectionHost } from "../core/projection/engine";
import { MutationGuard } from "../core/projection/guard";
import { ProjectionNotices } from "../core/projection/notices";
import { applyRepair } from "../core/projection/reassociation";
import { normalizeSettings, type Settings } from "../core/settings";
import { VaultChangeHub } from "../core/vault/changes";
import { obsidianRuntimeEnv } from "./lfcp-env";
import { OpenLfcpSettingTab } from "./settings-tab";

export default class OpenLfcpPlugin extends Plugin {
  override settings: Settings = normalizeSettings(undefined);
  /** Vault-level file changes, whatever made them (§45). */
  readonly changes = new VaultChangeHub({
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  /** The plugin's own Markdown writes, skipped as echoes (path + content hash). */
  readonly guard = new MutationGuard();
  /** Markdown → Shared Object projection (LFCP-061), while the runtime can write. */
  readonly projection = new ProjectionEngine(() => this.#projectionHost(), this.guard);
  readonly notices = new ProjectionNotices();
  /** The last projection pass (for tests and diagnostics). */
  lastProjection: Promise<unknown> = Promise.resolve();
  /** The LFCP runtime once started (null before, after unload, or if it failed). */
  runtime: LfcpRuntime | null = null;
  /** Why the runtime did not start, if it failed. */
  runtimeError: string | null = null;
  #starting: Promise<LfcpRuntime | null> | null = null;
  #unloaded = false;

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    for (const command of COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: () => {
          new Notice(notImplementedMessage(command));
        },
      });
    }
    this.addCommand({
      id: "repair-moved-ref",
      name: "Repair moved shared task ref",
      callback: () => void this.repairActiveNote(),
    });
    this.addSettingTab(new OpenLfcpSettingTab(this.app, this));
    this.#listenToVault();
    this.changes.subscribe((batch) => {
      this.lastProjection = this.lastProjection.then(() => this.#project(batch));
    });
    this.#starting = this.#startRuntime();
  }

  override onunload(): void {
    this.#unloaded = true;
    this.changes.close();
    void this.stopRuntime();
  }

  /** The environment the runtime runs in (tests replace it). */
  protected runtimeEnv(): RuntimeEnv {
    return obsidianRuntimeEnv(this.app);
  }

  /** Resolves once the runtime started (or failed: null). */
  whenRuntimeStarted(): Promise<LfcpRuntime | null> {
    return this.#starting ?? Promise.resolve(null);
  }

  /** Stops the runtime (also when unload came before it finished starting). */
  async stopRuntime(): Promise<void> {
    const runtime = await this.whenRuntimeStarted();
    this.runtime = null;
    await runtime?.stop();
  }

  async #startRuntime(): Promise<LfcpRuntime | null> {
    try {
      const runtime = await LfcpRuntime.start(this.runtimeEnv());
      if (this.#unloaded) {
        await runtime.stop();
        return null;
      }
      this.runtime = runtime;
      return runtime;
    } catch (e) {
      this.runtimeError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  #projectionHost(): ProjectionHost | null {
    const r = this.runtime;
    return r !== null && r.status.kind === "ready" ? r : null;
  }

  async #project(batch: Parameters<ProjectionEngine["handleChanges"]>[0]): Promise<void> {
    for (const c of batch) if (c.kind === "rename") this.notices.rename(c.oldPath, c.path);
    try {
      const outcomes = await this.projection.handleChanges(batch, async (path) => {
        const file = this.app.vault.getFileByPath(path);
        return file === null ? null : this.app.vault.read(file);
      });
      for (const o of outcomes) for (const m of this.notices.messages(o)) new Notice(m);
    } catch (e) {
      new Notice(
        `OpenLFCP: a note could not be processed (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }

  /** ST-2: moves suspected re-associated refs of the active note back under their Task. */
  async repairActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file === null) return;
    const repairs = this.notices.repairs(file.path);
    if (repairs.length === 0) {
      new Notice("OpenLFCP: nothing to repair in this note.");
      return;
    }
    await this.app.vault.process(file, (text) => repairs.reduce((t, r) => applyRepair(t, r), text));
  }

  #listenToVault(): void {
    const vault = this.app.vault;
    for (const kind of ["create", "modify", "delete"] as const)
      this.registerEvent(
        vault.on(kind as "create", (file: TAbstractFile) =>
          this.changes.record({ kind, path: file.path }),
        ),
      );
    this.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) =>
        this.changes.record({ kind: "rename", path: file.path, oldPath }),
      ),
    );
  }

  // data.json changed outside the plugin, e.g. through vault sync.
  override async onExternalSettingsChange(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
