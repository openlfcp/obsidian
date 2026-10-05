// The Obsidian adapter: plugin lifecycle, commands and the settings tab.
// Only files under src/obsidian/ may import `obsidian`
// (scripts/check-boundaries.mjs); everything else lives in src/core/.
//
// Lifecycle (LFCP-059): onload registers commands, settings and the vault
// change listener, then starts the LFCP runtime in the background (local
// only: Automerge, the install, the writer lock; never the network), so
// loading never waits on a server. onunload stops every session and timer
// and closes the local state; pending outbound objects stay stored.
//
// Projection (LFCP-061/062): vault changes and Shared Object changes go
// through one serialized ProjectionWriter: a note's Markdown edits are sent
// first, then its bound Tasks are rendered from the shared state. Notes open
// in an editor with unsaved changes are never written (deferred to their
// next save). Conflicts show in the status bar and as an editor line
// decoration, never in the text.

import { toBase64url } from "@openlfcp/core";
import { MarkdownView, Notice, Plugin, type TAbstractFile, type TFile } from "obsidian";
import { CollabCommands, type Prompter } from "../core/collab/commands";
import { Collaboration } from "../core/collab/service";
import { COMMANDS } from "../core/commands";
import { LfcpRuntime, type RuntimeEnv } from "../core/lfcp/runtime";
import { ConflictRegistry } from "../core/projection/conflicts";
import { type BaseStore, ProjectionEngine, type ProjectionHost } from "../core/projection/engine";
import { MutationGuard } from "../core/projection/guard";
import { ProjectionNotices } from "../core/projection/notices";
import { applyRepair } from "../core/projection/reassociation";
import { type NoteIO, type NoteOutcome, ProjectionWriter } from "../core/projection/writer";
import { normalizeSettings, type Settings } from "../core/settings";
import { type VaultChange, VaultChangeHub } from "../core/vault/changes";
import { conflictDecorations } from "./conflict-decoration";
import { obsidianRuntimeEnv } from "./lfcp-env";
import { OpenLfcpSettingTab } from "./settings-tab";
import { ObsidianNotes, ObsidianPrompter } from "./ui/prompter";

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
  readonly projection = new ProjectionEngine(
    () => this.#projectionHost(),
    this.guard,
    this.#baseStore(),
  );
  /** Notes ↔ Shared Objects (LFCP-062). */
  readonly writer = new ProjectionWriter(this.projection, this.guard, this.#noteIO(), () =>
    this.#projectionHost(),
  );
  readonly notices = new ProjectionNotices();
  readonly conflicts = new ConflictRegistry();
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
    // LFCP-065: the product commands, over the collaboration flows.
    const ui = new CollabCommands({
      collab: () => this.#collaboration(),
      prompter: this.createPrompter(),
      notes: new ObsidianNotes(this.app),
      guard: this.guard,
      placement: () => this.settings.refPlacement,
      defaultServer: () => this.settings.defaultServer,
    });
    const handlers: Readonly<Record<string, () => Promise<void>>> = {
      "share-task-under-cursor": () => ui.shareTaskUnderCursor(),
      "insert-shared-object": () => ui.insertSharedObject(),
      "create-collaboration": () => ui.createCollaboration(),
      "join-collaboration": () => ui.joinCollaboration(),
      "invite-collaborator": () => ui.inviteCollaborator(),
      "resource-status": () => ui.resourceStatus(),
      "detach-shared-task": () => ui.detachSharedTask(),
      "resolve-shared-conflict": () => ui.resolveConflictUnderCursor(),
    };
    for (const command of COMMANDS) {
      const run = handlers[command.id];
      if (run === undefined) throw new Error(`no handler for ${command.id}`);
      this.addCommand({ id: command.id, name: command.name, callback: () => void run() });
    }
    this.addCommand({
      id: "repair-moved-ref",
      name: "Repair moved shared task ref",
      callback: () => void this.repairActiveNote(),
    });
    this.addSettingTab(new OpenLfcpSettingTab(this.app, this));
    this.#listenToVault();
    this.changes.subscribe((batch) => this.#enqueue(() => this.#onVaultChanges(batch)));
    const bar = this.addStatusBarItem();
    this.conflicts.onChange(() => bar.setText(this.conflicts.summary()));
    this.registerEditorExtension(conflictDecorations(this.conflicts));
    this.#starting = this.#startRuntime();
  }

  override onunload(): void {
    this.#unloaded = true;
    this.changes.close();
    void this.stopRuntime();
  }

  /** The dialogs of the LFCP-065 commands (tests replace them). */
  protected createPrompter(): Prompter {
    return new ObsidianPrompter(this.app);
  }

  #collab: { runtime: LfcpRuntime; flows: Collaboration } | null = null;

  /** The collaboration flows of the running runtime, or null before it started. */
  #collaboration(): Collaboration | null {
    const runtime = this.runtime;
    if (runtime === null) return null;
    if (this.#collab?.runtime !== runtime)
      this.#collab = { runtime, flows: new Collaboration(runtime) };
    return this.#collab.flows;
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
      this.#watchObjects(runtime);
      this.app.workspace.onLayoutReady(() => this.#enqueue(() => this.reconcile()));
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

  /** Serializes all projection work (vault changes, object changes, reconcile). */
  #enqueue(job: () => Promise<void>): void {
    this.lastProjection = this.lastProjection.then(job).catch((e: unknown) => {
      new Notice(
        `OpenLFCP: a note could not be processed (${e instanceof Error ? e.message : String(e)}).`,
      );
    });
  }

  async #onVaultChanges(batch: readonly VaultChange[]): Promise<void> {
    for (const c of batch) {
      if (c.kind === "rename") {
        this.notices.rename(c.oldPath, c.path);
        this.conflicts.rename(c.oldPath, c.path);
      }
      if (c.kind === "delete") this.conflicts.forget(c.path);
    }
    this.#report(await this.writer.handleChanges(batch));
  }

  /** Shared Object changes (local writes, remote merges, G-EP7 rebuilds) re-render their notes. */
  #watchObjects(runtime: LfcpRuntime): void {
    let keys = new Set<string>();
    let regressed = new Set<string>();
    let scheduled = false;
    runtime.onObjectChanged((resource, change) => {
      const key = `${toBase64url(resource)}#${change.objectId}`;
      keys.add(key);
      if (change.origin === "rebuild") regressed.add(key);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        const [k, r] = [keys, regressed];
        keys = new Set();
        regressed = new Set();
        scheduled = false;
        this.#enqueue(async () => this.#report(await this.writer.objectsChanged(k, r)));
      });
    });
  }

  /**
   * Startup reconciliation (§46): notes that contain refs are synced one by
   * one (their edits sent, their bound Tasks rendered field by field); notes
   * without refs are not touched.
   */
  async reconcile(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.read(file);
      if (text.includes("lfcp-ref")) this.#report([await this.writer.syncNote(file.path)]);
    }
  }

  #report(outcomes: readonly NoteOutcome[]): void {
    for (const o of outcomes) {
      if (o.projection !== undefined)
        for (const m of this.notices.messages(o.projection)) new Notice(m);
      if (o.deferred === undefined) this.conflicts.update(o.path, o.rendered);
      for (const m of this.notices.renderMessages(o.path, o.rendered)) new Notice(m);
    }
  }

  #noteIO(): NoteIO {
    const file = (path: string): TFile | null => this.app.vault.getFileByPath(path);
    return {
      read: async (path) => {
        const f = file(path);
        return f === null ? null : this.app.vault.read(f);
      },
      rewrite: async (path, fn) => {
        const f = file(path);
        if (f !== null) await this.app.vault.process(f, fn);
      },
      isBeingEdited: (path, onDisk) =>
        this.app.workspace
          .getLeavesOfType("markdown")
          .some(
            (leaf) =>
              leaf.view instanceof MarkdownView &&
              leaf.view.file?.path === path &&
              leaf.view.editor.getValue() !== onDisk,
          ),
    };
  }

  /** Projection bases persist in the install's local state (never in the vault). */
  #baseStore(): BaseStore {
    return {
      load: async (path) =>
        ((await this.runtime?.localState.get(`base:${path}`)) ?? undefined) as
          | Record<string, never>
          | undefined,
      save: async (path, bases) => {
        await this.runtime?.localState.put(`base:${path}`, bases);
      },
    };
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
