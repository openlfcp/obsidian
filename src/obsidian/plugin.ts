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

import { EditorView } from "@codemirror/view";
import { fromBase64url, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { PROFILE_ID as TASKS_PROFILE_ID } from "@openlfcp/shared-objects";
import {
  apiVersion,
  type Editor,
  type MarkdownFileInfo,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  type TAbstractFile,
  type TFile,
} from "obsidian";
import type { ActionId } from "../core/actions/catalog";
import { type HostFacts, INVITE_WAITS } from "../core/actions/descriptors";
import { ActionDispatcher, coreHandlers, type HostEntry } from "../core/actions/dispatcher";
import { type ActiveNote, CollabCommands, type Prompter } from "../core/collab/commands";
import type { JoinFlow } from "../core/collab/join-flow";
import { Collaboration } from "../core/collab/service";
import { rehostNotice, unnamedResource } from "../core/collab/view";
import { COMMANDS, type CommandSpec, INVITE_TO_SECTION } from "../core/commands";
import {
  type DiagnosticInput,
  DiagnosticLog,
  diagnosticReport,
  safeEvent,
} from "../core/diagnostics";
import { collectDiagnostics } from "../core/diagnostics-collect";
import { LfcpRuntime, type RuntimeEnv, startFailure } from "../core/lfcp/runtime";
import { sdkErrorClass } from "../core/lfcp/sdk-errors";
import { hideHint } from "../core/pane/hints";
import { hostPane, paneJoinOf, wiredModel } from "../core/pane/host-facts";
import { paneModel } from "../core/pane/model";
import { ConflictRegistry } from "../core/projection/conflicts";
import { type BaseStore, ProjectionEngine, type ProjectionHost } from "../core/projection/engine";
import { MutationGuard } from "../core/projection/guard";
import { ProjectionNotices } from "../core/projection/notices";
import { applyRepair } from "../core/projection/reassociation";
import { type NoteIO, type NoteOutcome, ProjectionWriter } from "../core/projection/writer";
import { readableCopy, sharedSectionText } from "../core/sections/clipboard";
import type { TargetCapture } from "../core/sections/target";
import { normalizeSettings, type Settings } from "../core/settings";
import { type VaultChange, VaultChangeHub } from "../core/vault/changes";
import { conflictDecorations } from "./conflict-decoration";
import { obsidianRuntimeEnv } from "./lfcp-env";
import { LiveRegion } from "./live-region";
import { filterUiFromCopy } from "./section-clipboard";
import { sectionPresentationExtension, setShowMetadata } from "./section-presentation";
import { captureEditor, editorMode } from "./section-target";
import { SectionsHost } from "./sections-host";
import { OpenLfcpSettingTab } from "./settings-tab";
import { DiagnosticsModal } from "./ui/diagnostics";
import { returnsFocus } from "./ui/focus-return";
import { registerPanePrototype } from "./ui/pane-prototype-view";
import {
  keepOne,
  OPEN_PANE,
  PANE_ICON,
  PANE_VIEW,
  type PaneHostPort,
  type PaneSnapshot,
  type PaneUi,
  paneOpener,
  SharedTasksView,
} from "./ui/pane-view";
import { ObsidianNotes, ObsidianPrompter } from "./ui/prompter";
import { inEveryWindow } from "./windows";

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

/**
 * The stopping of the plugin's previous instance, by app: an instance of the
 * window's App outlives a reload of the plugin (this module is evaluated
 * again; the App is not), so it is kept on it, under a private key.
 */
const STOPPING = Symbol.for("openlfcp.shared-tasks.stopping");
const stopping = {
  get: (app: object): Promise<void> | undefined =>
    (app as { [STOPPING]?: Promise<void> })[STOPPING],
  set: (app: object, p: Promise<void>): void => {
    (app as { [STOPPING]?: Promise<void> })[STOPPING] = p;
  },
};

/** What to do when another instance holds this vault's data (the writer lock). */
/** A start whose database open was blocked by a connection still closing: tried again. */
const BLOCKED = /is blocked by another connection/;
const BLOCKED_RETRIES = 20;

export const LOCK_HELD_ADVICE =
  "another Shared Tasks instance holds this vault's data. Close other windows on this vault, or restart Obsidian.";

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
  /**
   * The one dispatcher of the MVP 0.3 actions (LFCP-03-010): the palette
   * commands, the section card and the pane run their actions through it.
   */
  actions: ActionDispatcher = new ActionDispatcher({});
  /** The LFCP runtime once started (null before, after unload, or if it failed). */
  runtime: LfcpRuntime | null = null;
  /** Why the runtime did not start, if it failed. */
  runtimeError: string | null = null;
  #starting: Promise<LfcpRuntime | null> | null = null;
  #unloaded = false;

  #legacyHandlers: Readonly<Record<string, () => Promise<void>>> = {};
  readonly #registeredCommands = new Set<string>();

  #register(command: CommandSpec): void {
    if (this.#registeredCommands.has(command.id)) return;
    const run = this.#legacyHandlers[command.id];
    if (run === undefined) throw new Error(`no handler for ${command.id}`);
    this.#registeredCommands.add(command.id);
    this.addCommand({ id: command.id, name: command.name, callback: () => void run() });
  }

  /**
   * Whether this vault holds a 0.1 task collaboration (a Resource of the
   * Shared Objects profile). Tests replace it.
   */
  protected async hasLegacyData(): Promise<boolean> {
    const entries = (await this.runtime?.registry()) ?? [];
    return entries.some((e) => e.profile === TASKS_PROFILE_ID);
  }

  /**
   * Registers the 0.1 commands that wait for 0.1 data, once the registry
   * holds some. Run at start and after a join; a caller that makes 0.1 data
   * another way (the native specs, through the runtime) runs it too.
   */
  async syncLegacyCommands(): Promise<void> {
    if (this.#unloaded) return;
    const waiting = COMMANDS.filter(
      (c) => c.legacy === "when-data" && !this.#registeredCommands.has(c.id),
    );
    if (waiting.length === 0) return;
    if (!(await this.hasLegacyData().catch(() => false)) || this.#unloaded) return;
    for (const command of waiting) this.#register(command);
  }

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    // Back online, shown or focused again after a while: connect now, not at
    // the end of the reconnect backoff (up to 15 s).
    this.registerDomEvent(window, "online", () => this.runtime?.networkBack(true));
    this.registerDomEvent(window, "focus", () => this.runtime?.networkBack());
    // Gone: the sessions close now, not minutes later on a missed heartbeat.
    this.registerDomEvent(window, "offline", () => this.runtime?.networkLost());
    this.registerDomEvent(window.document, "visibilitychange", () => {
      if (window.document.visibilityState === "visible") this.runtime?.networkBack();
    });
    // LFCP-065: the product commands, over the collaboration flows.
    const ui = new CollabCommands({
      collab: () => this.#collaboration(),
      prompter: this.createPrompter(),
      notes: new ObsidianNotes(this.app),
      guard: this.guard,
      placement: () => this.settings.refPlacement,
      defaultServer: () => this.settings.defaultServer,
      sections: () => !this.settings.sectionsDisabled,
      wrote: (path, markdown) => this.#enqueue(() => this.projection.reindex(path, markdown)),
      // D9: the pane is about the section just joined, until another one is.
      joined: (R: ResourceId) => this.sectionJoined(R),
      // I4 (LFCP-03-041): the palette invites to a section only when the pane would.
      inviteRefusal: (R: ResourceId) =>
        this.sections?.inviteRefusal(R) ?? Promise.resolve(INVITE_WAITS),
      // F-05: "Resolve shared task conflict" in a section opens the section's own review.
      ...(this.settings.sectionsDisabled
        ? {}
        : {
            sectionConflicts: (note: ActiveNote) =>
              this.sections?.reviewConflictsAt(note.text, note.line),
          }),
    });
    this.#commands = ui;
    this.#joins = ui.joins;
    this.actions = new ActionDispatcher(
      coreHandlers({
        sections: () => this.sections?.actions ?? null,
        collab: ui,
        host: this.#hostEntry(),
      }),
    );
    const handlers: Readonly<Record<string, () => Promise<void>>> = {
      "share-task-under-cursor": () => ui.shareTaskUnderCursor(),
      "insert-shared-object": () => ui.insertSharedObject(),
      "share-selected-tasks": () => ui.shareSelectedTasks(),
      "insert-all-tasks": () => ui.insertAllTasks(),
      "create-collaboration": () => ui.createCollaboration(),
      // The pane's "Join with a link…" and "Invite collaborator…": one handler, one lock.
      "join-collaboration": async () => {
        // The legacy command claims a 0.1 link only; a section is joined from the pane or "Insert".
        await this.actions.run("join-with-link", { joinAccept: "legacy" });
        // A joined 0.1 collaboration brings the rest of the 0.1 commands.
        await this.syncLegacyCommands();
      },
      "invite-collaborator": () => this.actions.run("invite"),
      "resource-status": () => this.actions.run("resource-status"),
      "detach-shared-task": () => ui.detachSharedTask(),
      "resolve-shared-conflict": () => ui.resolveConflictUnderCursor(),
      "toggle-sharing-metadata": () =>
        this.setShowSharingMetadata(!this.settings.showSharingMetadata),
    };
    // UX-01 (UXD-2): the 0.1 commands are registered only for a vault that has
    // 0.1 data, except the way into an older collaboration. Obsidian cannot
    // unregister a command, so the rest is added once the registry shows such
    // a Resource (at start, or after a legacy join) and stays until a reload.
    this.#legacyHandlers = handlers;
    for (const command of COMMANDS) if (command.legacy !== "when-data") this.#register(command);
    this.addCommand({
      id: "rotate-local-encryption-key",
      name: "Rotate local encryption key",
      callback: () => void this.rotateLocalEncryptionKey(),
    });
    // LFCP-02-065: a local report, previewed, copied or saved only on request.
    this.addCommand({
      id: "export-diagnostics",
      name: "Export diagnostics…",
      callback: () => this.#openDiagnostics(),
    });
    this.addCommand({
      id: "repair-moved-ref",
      name: "Repair moved shared task ref",
      callback: () => void this.repairActiveNote(),
    });
    this.addSettingTab(new OpenLfcpSettingTab(this.app, this));
    // LFCP-03-007: the developer pane prototype, only with its data.json flag.
    if (this.settings.developerPanePrototype) registerPanePrototype(this);
    this.#listenToVault();
    this.changes.subscribe((batch) => this.#enqueue(() => this.#onVaultChanges(batch)));
    const bar = this.addStatusBarItem();
    this.#bar = bar;
    this.conflicts.onChange(() => {
      if (this.needsRestart === null) bar.setText(this.conflicts.summary());
    });
    this.registerEditorExtension(conflictDecorations(this.conflicts));
    const sections = sectionPresentationExtension(
      () => this.settings.showSharingMetadata,
      () => this.#markerRefused(),
    );
    this.#sectionViews = sections.views;
    this.registerEditorExtension(sections.extension);
    // Shared sections: on unless `sectionsDisabled` (data.json); read-only on mobile.
    if (!this.settings.sectionsDisabled) {
      // LFCP-02-064: one live region for what is said once, in the window in use.
      const live = new LiveRegion(document, () => activeDocument);
      this.register(() => live.detach());
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
        (text) => live.announce(text),
      );
      // LFCP-03-010: the card's buttons run through the same dispatcher as the palette.
      this.sections.actions.dispatchThrough((id, request, surface) =>
        this.actions.run(id, request, surface),
      );
      this.registerEditorExtension(this.sections.editor.extension);
      // A note switched to Reading view (or back) goes by its file (or its editor).
      this.registerEvent(
        this.app.workspace.on("layout-change", () => this.sections?.editor.refresh()),
      );
      // LFCP-02-058: the shared mark and sync status after each section heading.
      this.registerEditorExtension(this.sections.status.extension);
      const reading = this.sections.reading;
      this.registerMarkdownPostProcessor((el, ctx) => reading.render(el, ctx));
      this.registerInterval(window.setInterval(() => this.sections?.scheduleStatus(), 2000));
      // Typing coalescing (025): a pause commits what waits.
      this.registerInterval(window.setInterval(() => this.sections?.tick(), 500));
      // UX-02 (UXD-4): the pane's "Invite collaborator…" for the section at the cursor.
      this.addCommand({
        id: INVITE_TO_SECTION.id,
        name: INVITE_TO_SECTION.name,
        editorCallback: (editor, ctx) => void this.#runOnNote("invite", editor, ctx),
      });
      this.addCommand({
        id: "share-section",
        name: "Share section…",
        editorCallback: (editor, ctx) => void this.#runOnNote("share-section", editor, ctx),
      });
      // LFCP-02-063: no plugin UI in a copy of rendered content, in every
      // window (a popout has its own document, LFCP-03-022); the two copy commands.
      // A popout's listener goes with its window, the rest with the plugin.
      this.register(
        inEveryWindow(
          this.app.workspace,
          document,
          (ref) => this.registerEvent(ref),
          (doc) => {
            const copy = (e: ClipboardEvent) => {
              filterUiFromCopy(e, doc);
            };
            doc.addEventListener("copy", copy);
            return () => doc.removeEventListener("copy", copy);
          },
        ),
      );
      this.addCommand({
        id: "copy-readable-text",
        name: "Copy readable text (without sharing metadata)",
        editorCallback: (editor, ctx) => void this.#runOnNote("copy-readable", editor, ctx),
      });
      this.addCommand({
        id: "copy-shared-section",
        name: "Copy shared section",
        editorCallback: (editor, ctx) => void this.#runOnNote("copy-shared-section", editor, ctx),
      });
      // LFCP-02-064: every section action from the keyboard, without a Tab stop per row.
      this.addCommand({
        id: "open-section-details",
        name: "Open shared section details",
        editorCallback: (editor, ctx) => void this.#runOnNote("open-details", editor, ctx),
      });
      this.addCommand({
        id: "next-section-problem",
        name: "Go to next shared section problem",
        editorCallback: (editor, ctx) => void this.#runOnNote("go-to-problem", editor, ctx),
      });
      this.addCommand({
        id: "detach-section",
        name: "Detach this section",
        editorCallback: (editor, ctx) => void this.#runOnNote("detach-section", editor, ctx),
      });
      this.addCommand({
        id: "repair-shared-sections",
        name: "Repair shared sections in this note",
        editorCallback: (editor, ctx) => void this.#runOnNote("repair-sections", editor, ctx),
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
        editorCallback: (editor, ctx) => void this.#runOnNote("insert-into-note", editor, ctx),
      });
    }
    this.#registerPane();
    this.#starting = this.#startRuntime();
    // The pane says "still starting" until the runtime ran (or failed).
    void this.#starting.then(() => this.#nudgePane());
  }

  /**
   * Reveals the one Shared Tasks pane (LFCP-03-012): the ribbon icon, the
   * command, the section card's link and the editor menu all call this.
   */
  readonly openPane = paneOpener(() => this.app.workspace);

  /** Pane listeners told of a change no other source reports (cursor moves, the runtime started). */
  readonly #paneNudges = new Set<() => void>();

  #markerNoticeAt = 0;

  /** The user's edit of a hidden marker was refused: say why, at most once in ten seconds. */
  #markerRefused(): void {
    const now = Date.now();
    if (now - this.#markerNoticeAt < 10_000) return;
    this.#markerNoticeAt = now;
    new Notice(
      "Shared Tasks: this line keeps the section shared. Switch to Source mode to edit it.",
    );
  }

  #nudgePane(): void {
    for (const f of [...this.#paneNudges]) f();
  }

  /** The Shared Tasks pane and its entries (LFCP-03-012; F-01, F-02; U03-01, U03-20). */
  #registerPane(): void {
    const port: PaneHostPort = {
      snapshot: (view, ui) => this.#pane(this.#paneNote(view), ui),
      run: (id, request) => this.actions.run(id, request, "pane"),
      join: {
        submit: (link, name) => void this.#joins?.submit(link, name),
        dismiss: (generation) => void this.#joins?.dismiss(generation),
      },
      // LFCP-03-021: hidden tips live in this vault's settings (data.json), nowhere else.
      hints: {
        hide: (id) => this.#saveHints(hideHint(this.settings.dismissedHints, id)),
        reset: () => this.#saveHints([]),
      },
      sources: [
        (changed) => {
          const off = this.sections?.registry.onChange(() => changed());
          return () => void off?.();
        },
        // P3: a status (a revocation, offline, a refusal) and a flow disable at once, not coalesced.
        (changed) => {
          const off = this.sections?.onStatusChange(() => changed(true));
          return () => void off?.();
        },
        (changed) => {
          const off = this.sections?.actions.onFlowsChange(() => changed(true));
          return () => void off?.();
        },
        // An invitation started, moved to its link, was copied or ended (LFCP-03-014).
        (changed) => {
          const off = this.#commands?.onInvitationChange(() => changed(true));
          return () => void off?.();
        },
        // The join moved to another stage, stopped or ended (LFCP-03-015): drawn at once.
        (changed) => {
          const off = this.#joins?.onChange(() => changed(true));
          return () => void off?.();
        },
        (changed) => {
          const nudge = () => changed();
          this.#paneNudges.add(nudge);
          return () => void this.#paneNudges.delete(nudge);
        },
      ],
    };
    this.registerView(PANE_VIEW, (leaf) => new SharedTasksView(leaf, port));
    // A cursor or selection moved in an editor: the pane's context may differ (coalesced there).
    this.registerEditorExtension(
      EditorView.updateListener.of((u) => {
        if (u.selectionSet && this.#paneNudges.size > 0) this.#nudgePane();
      }),
    );
    this.addRibbonIcon(PANE_ICON, OPEN_PANE, () => void this.openPane());
    this.addCommand({
      id: "open-shared-tasks-pane",
      name: OPEN_PANE,
      callback: () => void this.openPane(),
    });
    this.sections?.actions.paneEntry(() => void this.openPane());
    const ws = this.app.workspace;
    this.registerEvent(
      ws.on("editor-menu", (menu, editor, info) => {
        const path = info.file?.path;
        const sections = this.sections;
        if (path !== undefined && sections !== null) {
          // The cursor's next step, as the pane would offer it, on the note captured now.
          const note = captureEditor(
            editor,
            path,
            editorMode(info instanceof MarkdownView ? info : null, editor),
          );
          const pane = this.#pane(note, { pinned: null, chosen: null });
          const primary = pane.model.primary;
          if (primary?.enabled === true)
            menu.addItem((item) =>
              item
                .setTitle(primary.label)
                .setIcon(PANE_ICON)
                .onClick(() => void this.actions.run(primary.id, pane.request(primary.id), "menu")),
            );
        }
        menu.addItem((item) =>
          item
            .setTitle(OPEN_PANE)
            .setIcon(PANE_ICON)
            .onClick(() => void this.openPane()),
        );
      }),
    );
    // One pane per workspace: a restored or split layout with more keeps the first.
    ws.onLayoutReady(() => {
      if (this.#unloaded) return;
      keepOne(ws);
      this.registerEvent(ws.on("layout-change", () => keepOne(ws)));
    });
  }

  /** The note in a Markdown view, read now; null without one. */
  #paneNote(view: MarkdownView | null): TargetCapture | null {
    const path = view?.file?.path;
    if (view === null || path === undefined) return null;
    return captureEditor(view.editor, path, editorMode(view, view.editor));
  }

  /** The section joined last on this device (base64url): the pane is about it until another is (D9). */
  #justJoined: string | null = null;

  /** The collaboration commands (the invitation the pane follows, LFCP-03-014); null before onload. */
  #commands: CollabCommands | null = null;
  /** The one join flow (CollabCommands.joins): the pane shows it (LFCP-03-015). */
  #joins: JoinFlow | null = null;

  /** A shared section was joined on this device (its Resource): the pane is about it now (D9). */
  sectionJoined(R: ResourceId): void {
    this.#justJoined = toBase64url(R);
    // Listed at once, as not inserted yet, without waiting for another registry event.
    this.sections?.registryChanged?.();
    this.#nudgePane();
  }

  /**
   * The pane for `note`, from the host's facts read once (L2): its model,
   * with the actions this host cannot run off, and what each button acts on.
   */
  #pane(note: TargetCapture | null, ui: PaneUi): PaneSnapshot {
    const s = this.sections;
    const base: HostFacts = s?.hostFacts() ?? {
      unavailable: null,
      starting: this.runtime === null,
      readOnly: Platform.isMobile,
      server: this.settings.defaultServer.trim() !== "",
    };
    // A runtime that failed to start is not "still starting".
    const failed = this.runtimeError;
    const host: HostFacts =
      failed === null || base.unavailable !== null
        ? base
        : { ...base, starting: false, unavailable: `Shared Tasks: ${failed}` };
    const invitation = this.#commands?.invitation() ?? null;
    const collab = this.#commands;
    const drawing = hostPane({
      note,
      registry: s?.registry.snapshot() ?? null,
      status: (key) => s?.sectionStatus(key),
      access: (key) => s?.paneAccess(key),
      ...(s === null ? {} : { policy: s.sharePolicy() }),
      invitation:
        invitation === null
          ? null
          : {
              resource: toBase64url(invitation.resource),
              stage: invitation.stage,
              confirmed: invitation.confirmed,
            },
      // LFCP-03-014: what this device's share and invitation of a section came to.
      journey: (key) => {
        const shared = s?.actions.shareResult(key);
        const at = key.indexOf("#");
        const linkCopied =
          collab?.linkCopied(fromBase64url(at < 0 ? key : key.slice(0, at)) as ResourceId) === true;
        return {
          ...(shared === undefined ? {} : { shared }),
          ...(linkCopied ? { linkCopied } : {}),
        };
      },
      recovery: (key) => s?.recoveryItems(key) ?? [],
      host,
      flows: s?.actions.flows() ?? [],
      pinned: ui.pinned,
      chosen: ui.chosen,
      justJoined: this.#justJoined,
      join: paneJoinOf(this.#joins?.state() ?? null),
    });
    // With shared sections off on this device, only joining runs from the pane.
    const model = wiredModel(
      paneModel({ ...drawing.facts, hints: { hidden: this.settings.dismissedHints } }),
      (id) => this.actions.handles(id) && (s !== null || id === "join-with-link"),
    );
    const flow = drawing.facts.context.flow;
    return {
      model,
      request: drawing.request,
      identity: drawing.identity,
      problemRequest: drawing.problemRequest,
      pinned: drawing.pinned,
      join: flow?.kind === "join" ? (flow.generation ?? null) : null,
    };
  }

  /**
   * The actions that end in Obsidian (LFCP-03-013): the editor, the
   * clipboard, the settings. Each acts on the note as the surface captured
   * it, found again by its path; nothing runs on whichever note is active.
   */
  #hostEntry(): HostEntry {
    const ws = () => this.app.workspace;
    // The active editor when it shows the note (a note open twice: the one in use), else the first.
    const viewOf = (path: string): MarkdownView | null => {
      const active = ws().getActiveViewOfType(MarkdownView);
      if (active?.file?.path === path) return active;
      for (const leaf of ws().getLeavesOfType("markdown"))
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view;
      return null;
    };
    return {
      nextProblem: (at) => {
        const view = viewOf(at.path);
        if (view !== null) this.sections?.nextProblem(view);
      },
      // T4: Reading view leaves for the editor; nothing is written on the way.
      openForEditing: async (at) => {
        for (const leaf of ws().getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (!(view instanceof MarkdownView) || view.file?.path !== at.path) continue;
          const state = leaf.getViewState();
          await leaf.setViewState({ ...state, state: { ...state.state, mode: "source" } });
          ws().setActiveLeaf(leaf, { focus: true });
          return;
        }
        const file = this.app.vault.getFileByPath(at.path);
        if (file === null) {
          new Notice("Shared Tasks: that note is no longer in the vault.");
          return;
        }
        await ws()
          .getLeaf(false)
          .openFile(file, { state: { mode: "source" }, active: true });
      },
      openSettings: () => {
        // Obsidian's settings modal is not in its typed API.
        const setting = (this.app as unknown as { setting?: Partial<Record<string, unknown>> })
          .setting;
        const open = setting?.open;
        const tab = setting?.openTabById;
        if (typeof open !== "function" || typeof tab !== "function") {
          new Notice("Shared Tasks: open Settings, then Shared Tasks, to change its settings.");
          return;
        }
        open.call(setting);
        tab.call(setting, this.manifest.id);
      },
      copyReadable: async (at) => {
        const text = readableCopy(at);
        if (text === null) {
          new Notice("Shared Tasks: select text, or put the cursor in a shared section.");
          return;
        }
        await navigator.clipboard.writeText(text);
        new Notice("Shared Tasks: copied without sharing metadata.");
      },
      // LFCP-03-019: the copy at the captured cursor, never the active editor's.
      copySharedSection: async (at) => {
        const text = sharedSectionText(at.text, at.cursorLine);
        if (text === null) {
          new Notice("Shared Tasks: put the cursor in a shared section to copy it.");
          return;
        }
        await navigator.clipboard.writeText(text);
        new Notice(
          "Shared Tasks: shared section copied. Pasted into another note, it is another copy of the same section; it gives nobody access.",
        );
      },
    };
  }

  /**
   * A palette command on the note of its editor: the action's one handler
   * (LFCP-03-010), on the note captured now (LFCP-03-009).
   */
  #runOnNote(id: ActionId, editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> {
    const path = ctx.file?.path;
    const sections = this.sections;
    if (path === undefined || sections === null) return Promise.resolve();
    return this.actions.run(id, { target: sections.capture(editor, path) }, "palette");
  }

  override onunload(): void {
    this.#unloaded = true;
    // An invite check still waiting gives up: no dialog or notice after unload.
    this.sections?.stop();
    if (this.#lockRetry !== null) window.clearTimeout(this.#lockRetry);
    this.#lockRetry = null;
    this.changes.close();
    // The next instance of the plugin in this window (a reload: disabled and
    // enabled, a BRAT update) waits for this one to stop and let go of the
    // vault's writer lock before it starts.
    stopping.set(
      this.app,
      this.stopRuntime().catch(() => undefined),
    );
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
          sections: !this.settings.sectionsDisabled,
          sectionsReadOnly: Platform.isMobile,
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
      // A previous instance of the plugin in this window still stopping.
      await stopping.get(this.app);
      const runtime = await LfcpRuntime.start(this.runtimeEnv());
      if (this.#unloaded) {
        await runtime.stop();
        return null;
      }
      this.runtime = runtime;
      this.#blockedRetries = 0;
      runtime.onNeedsRestart((message) => this.#onNeedsRestart(message));
      // Another instance holds the writer lock (another window on this
      // vault, or a previous version still stopping): said once, and tried
      // again in the background until it is free.
      if (runtime.status.kind === "locked" && runtime.status.reason === "lock-held") {
        if (!this.#lockHeldSaid) new Notice(`Shared Tasks: ${LOCK_HELD_ADVICE}`, 0);
        this.#lockHeldSaid = true;
        this.#bar?.setText("Shared Tasks: paused (another window)");
        this.sections?.unavailable(`Shared Tasks: ${LOCK_HELD_ADVICE}`);
        this.#lockRetry = window.setTimeout(() => void this.#retryStart(), this.lockRetryMs);
      } else if (this.#lockHeldSaid) {
        // Running after a wait for the lock: back to normal, no reload needed.
        this.#lockHeldSaid = false;
        this.sections?.unavailable(null);
        this.#bar?.setText(this.conflicts.summary());
      }
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
      // SPEC-PATCH-10: a checkpoint an earlier version wrote that no longer loads.
      runtime.onCheckpointRebuilt(() => {
        new Notice(
          "Shared Tasks: some saved sharing state could not be opened, so it is being rebuilt from the changes stored on this device. Changes that are not valid are left out. Your notes are unchanged.",
          0,
        );
      });
      this.#diagnostics.add(safeEvent(Date.now(), "runtime-ready", {}));
      runtime.onCheckpointRebuilt(() =>
        this.#diagnostics.add(safeEvent(Date.now(), "checkpoint-rebuilt", {})),
      );
      runtime.onNeedsRestart(() =>
        this.#diagnostics.add(safeEvent(Date.now(), "needs-restart", {})),
      );
      // A connection loss finishing (not an error): its class, for a later report.
      runtime.onLossNoise((errorClass) =>
        this.#diagnostics.add(safeEvent(Date.now(), "connection-loss", { diagnostic: errorClass })),
      );
      // A profile's change listener threw (SDK 0.2.2): which profile, and the error's class.
      runtime.onListenerError((profile, errorClass) =>
        this.#diagnostics.add(
          safeEvent(Date.now(), "listener-error", { reason: profile, diagnostic: errorClass }),
        ),
      );
      // SDK events, codes only: the frequent ones that say nothing new stay out of the bounded log.
      runtime.on((e) => {
        if (e.type === "status" || e.type === "ack") return;
        if (e.type === "unit" && e.outcome.kind === "applied") return;
        const outcome = "outcome" in e ? (e.outcome as unknown as Record<string, unknown>) : {};
        this.#diagnostics.add(
          safeEvent(Date.now(), e.type, {
            ...outcome,
            ...(e as unknown as Record<string, unknown>),
            // An SDK error's message is never kept: which known failure it is, only.
            ...(e.type === "error" ? { diagnostic: sdkErrorClass(e.message) } : {}),
          }),
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
      await this.syncLegacyCommands();
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
      // The previous version's database connection still closing (its last
      // transactions finishing after it let go of the lock): tried again
      // shortly, for a while, before anything is said.
      if (
        BLOCKED.test(failure.message) &&
        this.#blockedRetries < BLOCKED_RETRIES &&
        !this.#unloaded
      ) {
        this.#blockedRetries++;
        this.#lockRetry = window.setTimeout(() => void this.#retryStart(), this.blockedRetryMs);
        return null;
      }
      // Newer sync data (a downgrade): said once, plainly; nothing is written or deleted.
      if (failure.newerData) new Notice(`Shared Tasks: ${failure.message}`, 0);
      // Any other failure is said too (it was silent: nothing synced, every
      // section loading), once per load.
      else if (!this.#startFailureSaid)
        new Notice(
          `Shared Tasks could not start: ${failure.message}. Restart Obsidian to try again; your notes are not affected.`,
          0,
        );
      this.#startFailureSaid = true;
      return null;
    }
  }

  /** The lock-held notice was shown (once per load); the start failure notice was. */
  #lockHeldSaid = false;
  #startFailureSaid = false;
  /** The background retry of a start that found the writer lock held (or its database blocked). */
  #lockRetry: number | null = null;
  /** Starts tried again after "blocked by another connection", and how far apart (tests shorten it). */
  #blockedRetries = 0;
  protected blockedRetryMs = 500;
  /** How long after finding the writer lock held a start is tried again (tests shorten it). */
  protected lockRetryMs = 5000;

  /** The lock was held: the locked runtime stopped, a new start tried. */
  async #retryStart(): Promise<void> {
    this.#lockRetry = null;
    if (this.#unloaded) return;
    const held = this.runtime;
    this.runtime = null;
    await held?.stop();
    if (this.#unloaded) return;
    this.#starting = this.#startRuntime();
    await this.#starting;
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
          const entry = (await runtime.registry()).find((e) => toHex(e.resourceId) === key);
          const name = entry?.localName ?? unnamedResource(entry?.profile);
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
          const entry = (await runtime.registry()).find(
            (x) => toHex(x.resourceId) === toHex(e.resourceId),
          );
          new Notice(rehostNotice(entry?.localName ?? unnamedResource(entry?.profile), e.url));
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
        vault.on(kind as "create", (file: TAbstractFile) => {
          // A share or insert flow on the note writes nothing (LFCP-03-002): at once, not batched.
          if (kind === "delete") this.sections?.noteDeleted(file.path);
          this.changes.record({ kind, path: file.path });
        }),
      );
    this.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // A share or insert flow on the note follows it (LFCP-03-002): at once, not batched.
        this.sections?.noteRenamed(oldPath, file.path);
        this.changes.record({ kind: "rename", path: file.path, oldPath });
      }),
    );
  }

  // data.json changed outside the plugin, e.g. through vault sync.
  override async onExternalSettingsChange(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    // Tips hidden or shown again on another device of this vault.
    this.#nudgePane();
  }

  /**
   * Settles each join a restart interrupted. One that still cannot finish
   * is shown in the pane's join flow as unknown (LFCP-03-017, U03-10), with
   * "Check the result" and "Give up" there and in a notice: the same claim
   * from its journal, never the link again. A second one meanwhile says so
   * with Retry and Give up, as before.
   */
  async #resumeJoins(): Promise<void> {
    const collab = this.#collaboration();
    if (collab === null) return;
    for (const { resourceId, name } of await collab.pendingJoins().catch(() => [])) {
      // Unnamed (N5): what it joins is not known until it settles (LFCP-03-042).
      const what = name === null ? "with the invitation link" : `"${name}"`;
      const settle = async (notice: Notice | null) => {
        notice?.hide();
        const out = await collab.resumeJoin(resourceId).catch((e: unknown) => ({
          kind: "unavailable" as const,
          message: e instanceof Error ? e.message : String(e),
        }));
        if (out.kind === "joined") {
          new Notice(`Shared Tasks: joined ${what}. Joining had not finished before.`);
          if (out.section !== undefined) this.sectionJoined(resourceId);
        } else if (out.kind === "not-claimed")
          new Notice(
            `Shared Tasks: joining ${what} did not go through, and the invitation was not used. Join again with the same link.`,
          );
        else if (out.kind === "unavailable") ask(out.message);
        else if (out.kind === "refused")
          new Notice(`Shared Tasks: joining ${what} was refused. ${out.message}`);
      };
      const ask = (why: string) => {
        const joins = this.#joins;
        const generation = joins?.restore(resourceId, why) ?? null;
        const notice = new Notice(
          generation === null
            ? `Shared Tasks: joining ${what} didn't finish. ${why}`
            : `Shared Tasks: joining ${what} didn't finish. ${why} The Shared Tasks pane shows it.`,
          0,
        );
        const el = (notice as { messageEl?: HTMLElement }).messageEl;
        if (el === undefined) return;
        const buttons = el.createDiv({ cls: "modal-button-container" });
        buttons
          .createEl("button", {
            text: generation === null ? "Retry" : "Check the result",
            cls: "mod-cta",
          })
          .addEventListener("click", (e) => {
            e.stopPropagation();
            if (joins === null || generation === null) {
              void settle(notice);
              return;
            }
            notice.hide();
            void this.actions.run("check-result", { join: generation }, "pane").then(() => {
              const s = joins.state();
              if (s?.generation === generation && s.stage === "choose-place")
                new Notice(`Shared Tasks: joined ${what}. Joining had not finished before.`);
            });
          });
        buttons.createEl("button", { text: "Give up" }).addEventListener("click", (e) => {
          e.stopPropagation();
          notice.hide();
          if (joins !== null && generation !== null) {
            // The join flow drops the claim's journal and says so.
            void joins.dismiss(generation);
            return;
          }
          void collab.abandonJoin(resourceId).then(() => {
            new Notice(`Shared Tasks: stopped joining ${what}. Your notes are unchanged.`);
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
  /** Safe events for the diagnostics report (LFCP-02-065), in memory only. */
  readonly #diagnostics = new DiagnosticLog();

  /** The diagnostics dialog, open; Tab kept in it, focus given back (LFCP-03-022). */
  #openDiagnostics(): void {
    const modal = new DiagnosticsModal(this.app, {
      report: async (detailed) => diagnosticReport(await this.#diagnosticInput(), detailed),
      copy: (text) => navigator.clipboard.writeText(text),
      save: async (text) => {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const path = `Shared Tasks diagnostics ${stamp}.txt`;
        await this.app.vault.create(path, text);
        return `"${path}" in this vault`;
      },
      say: (text) => new Notice(`Shared Tasks: ${text}`),
    });
    returnsFocus(modal).open();
  }

  async #diagnosticInput(): Promise<DiagnosticInput> {
    return collectDiagnostics({
      runtime: this.runtime,
      collab: this.#collaboration(),
      sections: this.sections,
      events: this.#diagnostics.events,
      plugin: this.manifest.version,
      obsidian: apiVersion,
      platform: `${Platform.isMobileApp ? "mobile" : "desktop"}-${
        Platform.isMacOS
          ? "macos"
          : Platform.isWin
            ? "windows"
            : Platform.isLinux
              ? "linux"
              : Platform.isIosApp
                ? "ios"
                : Platform.isAndroidApp
                  ? "android"
                  : "other"
      }`,
      needsRestart: this.needsRestart !== null,
    });
  }

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

  /** Shared sections (null until the runtime is ready). */
  sections: SectionsHost | null = null;

  #sectionViews: ReadonlySet<EditorView> = new Set();

  /** Shows or hides the binding lines of shared sections in every open editor (M5). */
  async setShowSharingMetadata(show: boolean): Promise<void> {
    this.settings.showSharingMetadata = show;
    await this.saveSettings();
    for (const view of this.#sectionViews) view.dispatch({ effects: setShowMetadata.of(show) });
  }

  /** From the pane: a failed save says so, never rejects unhandled (the pane already shows the change). */
  #saveHints(ids: readonly string[]): void {
    this.setDismissedHints(ids).catch(() => {
      new Notice(
        "Shared Tasks: the tip setting could not be saved. It may change back after a restart.",
      );
    });
  }

  /** Hides the pane's tips `ids`, or shows them all again with none (LFCP-03-021); the pane redraws. */
  async setDismissedHints(ids: readonly string[]): Promise<void> {
    this.settings.dismissedHints = [...ids];
    this.#nudgePane();
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
