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

import type { EditorView } from "@codemirror/view";
import { type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { MarkdownView, Notice, Plugin, type TAbstractFile, type TFile } from "obsidian";
import { CollabCommands, type Prompter } from "../core/collab/commands";
import { Collaboration } from "../core/collab/service";
import { rehostNotice } from "../core/collab/view";
import { COMMANDS } from "../core/commands";
import { LfcpRuntime, type RuntimeEnv, startFailure } from "../core/lfcp/runtime";
import { ConflictRegistry } from "../core/projection/conflicts";
import { type BaseStore, ProjectionEngine, type ProjectionHost } from "../core/projection/engine";
import { MutationGuard } from "../core/projection/guard";
import { ProjectionNotices } from "../core/projection/notices";
import { applyRepair } from "../core/projection/reassociation";
import { type NoteIO, type NoteOutcome, ProjectionWriter } from "../core/projection/writer";
import { readableText, sharedSectionText } from "../core/sections/clipboard";
import { normalizeSettings, type Settings } from "../core/settings";
import { type VaultChange, VaultChangeHub } from "../core/vault/changes";
import { conflictDecorations } from "./conflict-decoration";
import { obsidianRuntimeEnv } from "./lfcp-env";
import { filterUiFromCopy } from "./section-clipboard";
import { sectionPresentationExtension, setShowMetadata } from "./section-presentation";
import { SectionsHost } from "./sections-host";
import { OpenLfcpSettingTab } from "./settings-tab";
import { ObsidianNotes, ObsidianPrompter } from "./ui/prompter";

/** Apply outcomes after which a collaborator may be blocked. */
const BLOCKING_OUTCOMES: ReadonlySet<string> = new Set([
  "profile-rejected",
  "quarantined",
  "equivocation",
  "local-failure",
  "held",
  "profile-held",
  "engine-crash",
]);

export default class OpenLfcpPlugin extends Plugin {
  override settings: Settings = normalizeSettings(undefined);
  /** Vault-level file changes, whatever made them (§45). */
  readonly changes = new VaultChangeHub({
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
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
      sections: () => this.settings.sectionsPreview,
      wrote: (path, markdown) => this.#enqueue(() => this.projection.reindex(path, markdown)),
    });
    const handlers: Readonly<Record<string, () => Promise<void>>> = {
      "share-task-under-cursor": () => ui.shareTaskUnderCursor(),
      "insert-shared-object": () => ui.insertSharedObject(),
      "share-selected-tasks": () => ui.shareSelectedTasks(),
      "insert-all-tasks": () => ui.insertAllTasks(),
      "create-collaboration": () => ui.createCollaboration(),
      "join-collaboration": () => ui.joinCollaboration(),
      "invite-collaborator": () => ui.inviteCollaborator(),
      "resource-status": () => ui.resourceStatus(),
      "detach-shared-task": () => ui.detachSharedTask(),
      "resolve-shared-conflict": () => ui.resolveConflictUnderCursor(),
      "toggle-sharing-metadata": () =>
        this.setShowSharingMetadata(!this.settings.showSharingMetadata),
    };
    for (const command of COMMANDS) {
      const run = handlers[command.id];
      if (run === undefined) throw new Error(`no handler for ${command.id}`);
      this.addCommand({ id: command.id, name: command.name, callback: () => void run() });
    }
    this.addCommand({
      id: "rotate-local-encryption-key",
      name: "Rotate local encryption key",
      callback: () => void this.rotateLocalEncryptionKey(),
    });
    this.addCommand({
      id: "repair-moved-ref",
      name: "Repair moved shared task ref",
      callback: () => void this.repairActiveNote(),
    });
    this.addSettingTab(new OpenLfcpSettingTab(this.app, this));
    this.#listenToVault();
    this.changes.subscribe((batch) => this.#enqueue(() => this.#onVaultChanges(batch)));
    const bar = this.addStatusBarItem();
    this.#bar = bar;
    this.conflicts.onChange(() => {
      if (this.needsRestart === null) bar.setText(this.conflicts.summary());
    });
    this.registerEditorExtension(conflictDecorations(this.conflicts));
    const sections = sectionPresentationExtension(() => this.settings.showSharingMetadata);
    this.#sectionViews = sections.views;
    this.registerEditorExtension(sections.extension);
    // Development preview of shared sections (data.json only, off by default).
    if (this.settings.sectionsPreview) {
      this.sections = new SectionsHost(
        this.app,
        (path, e) => {
          new Notice(
            `Shared Tasks: a shared section in ${path} could not be processed (${e instanceof Error ? e.message : String(e)}).`,
          );
        },
        () => this.settings.refPlacement,
        () => this.settings.sectionComments,
        () => this.#collaboration(),
        () => this.settings.defaultServer,
        () => ui,
      );
      this.registerEditorExtension(this.sections.editor.extension);
      // LFCP-02-058: the shared mark and sync status after each section heading.
      this.registerEditorExtension(this.sections.status.extension);
      const reading = this.sections.reading;
      this.registerMarkdownPostProcessor((el, ctx) => reading.render(el, ctx));
      this.registerInterval(window.setInterval(() => this.sections?.scheduleStatus(), 2000));
      // Typing coalescing (025): a pause commits what waits.
      this.registerInterval(window.setInterval(() => this.sections?.tick(), 500));
      this.addCommand({
        id: "share-section",
        name: "Share section…",
        editorCallback: (editor, ctx) => {
          const path = ctx.file?.path;
          if (path === undefined) return;
          void this.sections
            ?.shareSection(editor, path)
            .then((approved) =>
              approved === null
                ? undefined
                : this.sections?.createSection(path, editor.getValue(), approved),
            );
        },
      });
      // LFCP-02-063: no plugin UI in a copy of rendered content; the two copy commands.
      this.registerDomEvent(document, "copy", (e) => {
        filterUiFromCopy(e, document);
      });
      this.addCommand({
        id: "copy-readable-text",
        name: "Copy readable text (without sharing metadata)",
        editorCallback: (editor) => {
          const selected = editor.getSelection();
          const text =
            selected !== ""
              ? selected
              : (sharedSectionText(editor.getValue(), editor.getCursor().line) ?? "");
          if (text === "") {
            new Notice("Shared Tasks: select text, or put the cursor in a shared section.");
            return;
          }
          void navigator.clipboard.writeText(readableText(text)).then(() => {
            new Notice("Shared Tasks: copied without sharing metadata.");
          });
        },
      });
      this.addCommand({
        id: "copy-shared-section",
        name: "Copy shared section",
        editorCallback: (editor) => {
          const text = sharedSectionText(editor.getValue(), editor.getCursor().line);
          if (text === null) {
            new Notice("Shared Tasks: put the cursor in a shared section to copy it.");
            return;
          }
          void navigator.clipboard.writeText(text).then(() => {
            new Notice(
              "Shared Tasks: shared section copied. Pasted into another note, it is another copy of the same section; it gives nobody access.",
            );
          });
        },
      });
      this.addCommand({
        id: "repair-shared-sections",
        name: "Repair shared sections in this note",
        editorCallback: (editor, ctx) => {
          const path = ctx.file?.path;
          if (path !== undefined) void this.sections?.repairNote(editor, path);
        },
      });
      this.addCommand({
        id: "restore-section-import",
        name: "Restore note before section import",
        editorCallback: (_editor, ctx) => {
          const path = ctx.file?.path;
          if (path !== undefined) void this.sections?.restoreImport(path);
        },
      });
      this.addCommand({
        id: "insert-section",
        name: "Insert shared section…",
        editorCallback: (editor, ctx) => {
          const path = ctx.file?.path;
          if (path !== undefined) void this.sections?.insertSection(editor, path);
        },
      });
    }
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
      this.#collab = {
        runtime,
        flows: new Collaboration(runtime, {
          sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
          sections: this.settings.sectionsPreview,
        }),
      };
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
    // Waiting typing is committed while the sessions still run (025).
    await this.sections?.flushTyping();
    this.runtime = null;
    await runtime?.stop();
  }

  #bar: { setText(text: string): void } | null = null;

  /** Set once the sync engine trapped: OpenLFCP is blocked until Obsidian restarts. */
  needsRestart: string | null = null;

  /** The engine trapped: one notice, a lasting status bar, no further projection work. */
  #onNeedsRestart(message: string): void {
    if (this.needsRestart !== null) return;
    this.needsRestart = message;
    new Notice(`${message}. Restart Obsidian to continue; your notes are not affected.`, 0);
    this.#bar?.setText("Shared Tasks: restart Obsidian");
  }

  async #startRuntime(): Promise<LfcpRuntime | null> {
    try {
      const runtime = await LfcpRuntime.start(this.runtimeEnv());
      if (this.#unloaded) {
        await runtime.stop();
        return null;
      }
      this.runtime = runtime;
      runtime.onNeedsRestart((message) => this.#onNeedsRestart(message));
      // LFCP-02-055: local data of a plugin before 0.4 was upgraded now; said once.
      if (runtime.upgradedLocalData)
        new Notice(
          "Shared Tasks upgraded its local data. Going back to a version before 0.4 will not open it; your notes are unchanged.",
          0,
        );
      // LFCP-02-098 §7: rows sealed under a lost key read as absent; said once.
      runtime.onLocalStateUnreadable(() => {
        new Notice(
          "Shared Tasks: some local recovery copies could not be read, because this device's local encryption key is missing. Your notes are unchanged; shared tasks and sections check their state with the server again.",
          0,
        );
      });
      this.#watchBlocked(runtime);
      this.#watchRefused(runtime);
      this.#watchObjects(runtime);
      // Pending changes go out and remote ones come in without waiting for a
      // command: every stored Resource is opened (one pooled session per server).
      if (runtime.status.kind === "ready")
        // A collaboration of another Data Profile is never opened (it needs a newer plugin).
        for (const entry of await runtime.registry())
          if (entry.state !== "unsupported")
            void runtime.openResource(entry.resourceId).catch(() => undefined);
      this.app.workspace.onLayoutReady(() => this.#enqueue(() => this.reconcile()));
      // LFCP-02-110: a join whose claim went unanswered finishes, or asks.
      if (runtime.status.kind === "ready") void this.#resumeJoins();
      const status = runtime.status;
      if (this.sections !== null && status.kind === "ready")
        this.app.workspace.onLayoutReady(
          () => void this.sections?.start(runtime, status.principalId).catch(() => undefined),
        );
      return runtime;
    } catch (e) {
      const failure = startFailure(e);
      this.runtimeError = failure.message;
      // Newer sync data (a downgrade): said once, plainly; nothing is written or deleted.
      if (failure.newerData) new Notice(`Shared Tasks: ${failure.message}`, 0);
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
        `Shared Tasks: a note could not be processed (${e instanceof Error ? e.message : String(e)}).`,
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
      if (this.sections !== null) await this.sections.vaultChange(c);
    }
    this.#report(await this.writer.handleChanges(batch));
  }

  /** Objects whose edits could not be sent (e.g. no key yet for a new epoch): retried when LIVE. */
  readonly #unsent = new Set<string>();

  /**
   * Shared Object changes (local writes, remote merges, G-EP7 rebuilds)
   * re-render their notes. After a rebuild, own changes a Key Epoch cut off
   * are first re-applied from the notes (G-EP5), not rendered away.
   */
  /** Resolves when the blocked-collaborator checks queued so far are done (tests). */
  blockedChecks: Promise<void> = Promise.resolve();

  /**
   * One notice per Resource and collaborator when that collaborator's edits
   * first cannot be applied here (rejected, quarantined, equivocating or
   * held too long); the details are in "Resource status". Checked at start
   * and after the session events that change a unit's fate.
   */
  #watchBlocked(runtime: LfcpRuntime): void {
    const queued = new Set<string>();
    const check = (R: ResourceId) => {
      const key = toHex(R);
      if (queued.has(key)) return;
      queued.add(key);
      this.blockedChecks = this.blockedChecks.then(async () => {
        queued.delete(key);
        if (runtime.status.kind !== "ready") return;
        try {
          const fresh = await runtime.newlyBlocked(R);
          if (fresh.length === 0) return;
          const name =
            (await runtime.registry()).find((e) => toHex(e.resourceId) === key)?.localName ??
            "a collaboration";
          for (const b of fresh)
            new Notice(
              `Shared Tasks: edits from ${b.principal.slice(0, 8)} in "${name}" can't be applied (${b.reasons.join(", ")}). See "Resource status".`,
            );
        } catch {
          // Reported again on the next event; never a reason to fail sync.
        }
      });
    };
    runtime.on((e) => {
      if (
        (e.type === "unit" && BLOCKING_OUTCOMES.has(e.outcome.kind)) ||
        e.type === "replayed" ||
        e.type === "epoch-reconciled" ||
        (e.type === "resource-state" && e.state === "LIVE")
      )
        check(e.resourceId);
    });
    void runtime
      .registry()
      .then((entries) => {
        for (const e of entries) check(e.resourceId);
      })
      .catch(() => undefined);
  }

  /**
   * One notice per collaboration when its server refuses it for good
   * (POST-017: e.g. RESOURCE_NOT_HOSTED after a purge or a server restore,
   * AUTHORIZATION_FAILED after a revocation). The SDK does not ask again,
   * so there is no reconnect storm; "Resource status" keeps the state.
   */
  #watchRefused(runtime: LfcpRuntime): void {
    runtime.on((e) => {
      // ADR 0008 (sdk-ts 0.1.3): the server had lost the collaboration and the
      // client hosted it again; a refusal comes as resource-refused below.
      if (e.type === "rehost" && e.outcome === "hosted") {
        this.blockedChecks = this.blockedChecks.then(async () => {
          const name = (await runtime.registry()).find(
            (x) => toHex(x.resourceId) === toHex(e.resourceId),
          )?.localName;
          new Notice(rehostNotice(name ?? "a collaboration", e.url));
        });
        return;
      }
      if (e.type !== "resource-refused") return;
      this.blockedChecks = this.blockedChecks.then(async () => {
        if (runtime.status.kind !== "ready") return;
        try {
          const text = await this.#collaboration()?.refusalNotice(e.resourceId);
          if (text !== null && text !== undefined) new Notice(text);
        } catch {
          // The state stays in "Resource status"; never a reason to fail sync.
        }
      });
    });
  }

  #watchObjects(runtime: LfcpRuntime): void {
    let keys = new Set<string>();
    let regressed = new Set<string>();
    let rebuilt = new Map<string, ResourceId>();
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        const [k, r, b] = [keys, regressed, rebuilt];
        keys = new Set();
        regressed = new Set();
        rebuilt = new Map();
        scheduled = false;
        this.#enqueue(async () => {
          const reapply = new Set<string>();
          for (const [prefix, R] of b)
            for (const id of await runtime.cutOwnObjects(R)) reapply.add(`${prefix}#${id}`);
          await this.writer.reapply(reapply);
          for (const key of reapply) {
            k.add(key);
            r.delete(key);
          }
          this.#report(await this.writer.objectsChanged(k, r));
        });
      });
    };
    runtime.onObjectChanged((resource, change) => {
      const prefix = toBase64url(resource);
      const key = `${prefix}#${change.objectId}`;
      keys.add(key);
      if (change.origin === "rebuild") {
        regressed.add(key);
        rebuilt.set(prefix, resource);
      }
      schedule();
    });
    runtime.on((e) => {
      if (e.type !== "resource-state" || e.state !== "LIVE" || this.#unsent.size === 0) return;
      for (const key of this.#unsent) keys.add(key);
      this.#unsent.clear();
      schedule();
    });
  }

  /**
   * Startup reconciliation (§46): notes that contain refs are synced one by
   * one (their edits sent, their bound Tasks rendered field by field); notes
   * without refs are not touched.
   *
   * Every Markdown note is looked at, locally, for an `lfcp-` marker: a note
   * may have gained or changed refs while the plugin was off (vault sync,
   * another editor), which a stored index of ref notes would miss. The look
   * uses `cachedRead` (Obsidian's content cache, no disk read for files it
   * holds); only a note with a ref is then read in full and synced.
   */
  async reconcile(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      // Any LFCP marker (refs, section boundaries, node markers), not only refs (OP-14).
      if (text.includes("lfcp-")) this.#report([await this.writer.syncNote(file.path)]);
    }
  }

  #report(outcomes: readonly NoteOutcome[]): void {
    for (const o of outcomes) {
      for (const d of o.projection?.diagnostics ?? [])
        if (d.code === "WRITE_FAILED") this.#unsent.add(`${d.resource}#${d.objectId}`);
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
      new Notice("Shared Tasks: nothing to repair in this note.");
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

  /** Settles each join a restart interrupted; one that still cannot finish says so, with Retry and Give up. */
  async #resumeJoins(): Promise<void> {
    const collab = this.#collaboration();
    if (collab === null) return;
    for (const { resourceId, name } of await collab.pendingJoins().catch(() => [])) {
      const settle = async (notice: Notice | null) => {
        notice?.hide();
        const out = await collab.resumeJoin(resourceId).catch((e: unknown) => ({
          kind: "unavailable" as const,
          message: e instanceof Error ? e.message : String(e),
        }));
        if (out.kind === "joined")
          new Notice(`Shared Tasks: joined "${name}". Joining had not finished before.`);
        else if (out.kind === "not-claimed")
          new Notice(
            `Shared Tasks: joining "${name}" did not go through, and the invitation was not used. Join again with the same link.`,
          );
        else if (out.kind === "unavailable") ask(out.message);
        else if (out.kind === "refused")
          new Notice(`Shared Tasks: joining "${name}" was refused. ${out.message}`);
      };
      const ask = (why: string) => {
        const body = createFragment();
        body.createDiv({ text: `Shared Tasks: joining "${name}" didn't finish. ${why}` });
        const buttons = body.createDiv({ cls: "modal-button-container" });
        const notice = new Notice(body, 0);
        buttons
          .createEl("button", { text: "Retry", cls: "mod-cta" })
          .addEventListener("click", () => {
            void settle(notice);
          });
        buttons.createEl("button", { text: "Give up" }).addEventListener("click", () => {
          notice.hide();
          void collab.abandonJoin(resourceId).then(() => {
            new Notice(`Shared Tasks: stopped joining "${name}". Your notes are unchanged.`);
          });
        });
      };
      await settle(null);
    }
  }

  /**
   * LFCP-02-098 §8: new local state keys for this vault on this device, every
   * stored row sealed again. Says how it went, with the status line.
   */
  async rotateLocalEncryptionKey(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) {
      new Notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    try {
      await runtime.rotateLocalStateKey();
      const line = runtime.localStateSummary(await runtime.localStateDiagnostics());
      new Notice(`Shared Tasks: local encryption key rotated. ${line}`);
    } catch (e) {
      new Notice(
        `Shared Tasks: the local encryption key could not be rotated (${e instanceof Error ? e.message : String(e)}). It continues on the next start.`,
      );
    }
  }

  /** The shared sections preview (null unless `sectionsPreview` is on). */
  sections: SectionsHost | null = null;

  #sectionViews: ReadonlySet<EditorView> = new Set();

  /** Shows or hides the binding lines of shared sections in every open editor (M5). */
  async setShowSharingMetadata(show: boolean): Promise<void> {
    this.settings.showSharingMetadata = show;
    await this.saveSettings();
    for (const view of this.#sectionViews) view.dispatch({ effects: setShowMetadata.of(show) });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
