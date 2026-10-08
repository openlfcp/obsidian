// Shared sections in the plugin (MVP 0.2), behind the `sectionsPreview`
// development flag (off by default, set in data.json only): the editor
// extension, the engine on the real SDK (the runtime's sessions, its
// install database), the notes that hold sections, and the events that
// start passes. Not reachable with the flag off: the plugin then creates
// none of this.
//
// Known gaps of the preview, each its own task: Task fields inside a
// section are not rendered or sent (the SDK has no TaskView for section
// Tasks yet), write access is not checked (contract §6), there is no sync
// status (026), and invitations to a section are not offered yet (051).

import {
  fromBase64url,
  generateObjectId,
  generateResourceId,
  type PrincipalId,
  type ResourceId,
} from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { type App, type Editor, MarkdownView, Notice, TFile } from "obsidian";
import type { Collaboration } from "../core/collab/service";
import type { LfcpRuntime } from "../core/lfcp/runtime";
import { SdkSectionPort } from "../core/lfcp/section-port";
import { newProjectionId } from "../core/sections/base";
import { type CreationEntry, type CreationResult, SectionCreation } from "../core/sections/create";
import { applyChanges, SectionEngine } from "../core/sections/engine";
import { type InsertResult, SectionInsertion } from "../core/sections/insert";
import { parseSections } from "../core/sections/parser";
import {
  preflight,
  proposeRange,
  revalidate,
  type SharePreview,
  type ShareRange,
} from "../core/sections/share";
import { KeyValueSectionBaseStore, KeyValueSectionJournalStore } from "../core/sections/stores";
import { newSectionTask } from "../core/sections/task-fields";
import type { RefPlacement, SectionComments } from "../core/settings";
import type { VaultChange } from "../core/vault/changes";
import { sectionEditorExtension } from "./section-editor";
import { InsertSectionModal, PickSectionModal, type SectionChoice } from "./ui/insert-section";
import { ShareSectionModal } from "./ui/share-section";

/** The text a note with a shared section always contains. */
const SECTION_MARK = "lfcp-section:";

export class SectionsHost {
  #engine: SectionEngine | null = null;
  #creation: SectionCreation | null = null;
  #insertion: SectionInsertion | null = null;
  #runtime: LfcpRuntime | null = null;
  /** Section Resources whose model changes start passes (hex of the ID). */
  readonly #watched = new Set<string>();
  #bases: KeyValueSectionBaseStore | null = null;
  /** Notes that hold a section, by the section's Resource (hex of its ID). */
  readonly #notes = new Map<string, Set<string>>();
  readonly editor: ReturnType<typeof sectionEditorExtension>;

  constructor(
    private readonly app: App,
    onError: (path: string, error: unknown) => void,
    /** The binding placement setting for new Task refs (§4.1). */
    private readonly refPlacement: () => RefPlacement,
    /** The section comments setting (§4.5). */
    private readonly sectionComments: () => SectionComments,
    /** The collaboration flows (hosting), null before the runtime runs. */
    private readonly collab: () => Collaboration | null,
    /** The server a new section is hosted on (the default server setting). */
    private readonly server: () => string,
  ) {
    this.editor = sectionEditorExtension({
      engine: () => this.#engine,
      files: {
        rewrite: async (path, fn) => {
          const file = this.app.vault.getFileByPath(path);
          return file === null ? null : this.app.vault.process(file, fn);
        },
      },
      onError,
    });
  }

  /** The runtime is ready: the engine on the real SDK, section Resources opened, their notes reconciled. */
  async start(runtime: LfcpRuntime, principal: PrincipalId): Promise<void> {
    const storage = runtime.storage as LfcpStorage;
    const port = new SdkSectionPort({
      profile: (r) => runtime.sectionProfile(r),
      commit: (r, intents, o) => runtime.commitSection(r, intents, o),
      storage,
      // Preview only: the Control-state check of contract §6 is not wired yet.
      canWrite: () => ({ allowed: true }),
    });
    this.#bases = new KeyValueSectionBaseStore(runtime.localState);
    this.#engine = new SectionEngine({
      port,
      journal: new KeyValueSectionJournalStore(runtime.localState),
      bases: this.#bases,
      newNodeId: () => generateObjectId(),
      newOperationId: () => crypto.randomUUID(),
      createdBy: principal,
      newProjectionId,
      // No TaskView for section Tasks in the SDK yet: their fields are left alone.
      tasks: () => undefined,
      newTask: (line, id) => newSectionTask(line, principal, id),
      refPlacement: this.refPlacement,
      sectionComments: this.sectionComments,
    });
    this.#runtime = runtime;
    this.#creation = new SectionCreation({
      host: {
        createSectionResource: (o) => runtime.createSectionResource(o),
        openSection: (R) => runtime.openSection(R),
        host: async (R) => {
          const flows = this.collab();
          if (flows === null)
            return { kind: "pending", reason: "Shared Tasks is not running yet." };
          const h = await flows.host(R);
          return h.kind === "hosted" ? { kind: "hosted" } : h;
        },
      },
      port,
      edit: (path, fn) => this.#edit(path, fn),
      journal: runtime.localState,
      createdBy: principal,
      server: this.server,
      newResourceId: () => generateResourceId(),
      newNodeId: () => generateObjectId(),
      newOperationId: () => crypto.randomUUID(),
      newTask: (line, id) => newSectionTask(line, principal, id),
      refPlacement: this.refPlacement,
    });
    this.#insertion = new SectionInsertion({
      port,
      bases: this.#bases,
      journal: runtime.localState,
      loaded: (r) => (runtime.sectionProfile(fromKey(r))?.heldUnits().length ?? 1) === 0,
      task: (r, taskId) => port.task(r, taskId),
      edit: (path, fn) => this.#edit(path, fn),
      newInsertionId: newProjectionId,
      refPlacement: this.refPlacement,
    });
    for (const entry of await runtime.registry())
      if (entry.profile === SECTIONS_PROFILE_ID) await this.#watch(entry.resourceId);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes(SECTION_MARK)) continue;
      this.#index(file.path, text);
      this.editor.remoteChanged(file.path, text);
    }
    // Creations a restart interrupted go on from their journal (SSP §12.2).
    for (const entry of await this.#creation.unfinished())
      void this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * Creates the shared section of an approved preview (LFCP-02-050): the
   * creation is journaled first, then runs; an interrupted one goes on
   * at the next start.
   */
  async createSection(path: string, markdown: string, preview: SharePreview): Promise<void> {
    const creation = this.#creation;
    if (creation === null) {
      new Notice("Shared Tasks: still starting. Share the section again in a moment.");
      return;
    }
    if (this.server().trim() === "") {
      new Notice("Shared Tasks: set a default sync server in the settings to share a section.");
      return;
    }
    const entry = await creation.prepare(path, markdown, preview);
    await this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * "Insert shared section…" (LFCP-02-052): a ready, fully loaded section
   * of this vault, previewed, then written after the block at the cursor
   * as one complete projection.
   */
  async insertSection(editor: Editor, path: string): Promise<void> {
    const runtime = this.#runtime;
    const insertion = this.#insertion;
    if (runtime === null || insertion === null) {
      new Notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    const choices: SectionChoice[] = [];
    for (const entry of await runtime.registry()) {
      if (entry.profile !== SECTIONS_PROFILE_ID) continue;
      const replica = runtime.sectionProfile(entry.resourceId)?.replica;
      const snap = replica?.snapshot();
      const sectionId = (replica?.toJSON() as { section?: { id?: unknown } } | undefined)?.section
        ?.id;
      if (snap === undefined || typeof sectionId !== "string") continue;
      choices.push({ resource: entry.resourceId, sectionId, title: snap.title.value ?? "" });
    }
    if (choices.length === 0) {
      new Notice("Shared Tasks: no shared section on this device yet.");
      return;
    }
    const pick = new PickSectionModal(this.app, choices);
    pick.open();
    const choice = await pick.result;
    if (choice === null) return;
    const preview = insertion.preview(choice.resource as ResourceId, choice.sectionId);
    if ("refused" in preview) {
      new Notice(
        preview.refused === "importing"
          ? "Shared Tasks: this section is still being imported. Try again when it is ready."
          : preview.refused === "not-loaded"
            ? "Shared Tasks: this section has not fully arrived yet. Try again in a moment."
            : "Shared Tasks: this section cannot be shown here yet (it has a problem to resolve).",
      );
      return;
    }
    const modal = new InsertSectionModal(this.app, preview);
    modal.open();
    if (!(await modal.result)) return;
    const entry = await insertion.prepare(
      path,
      editor.getValue(),
      editor.getCursor().line,
      preview,
    );
    const result = await insertion.run(entry);
    notifyInsertion(result);
    if (result.kind === "inserted") {
      this.#index(path, editor.getValue());
      this.editor.remoteChanged(path);
    }
  }

  async #finish(entry: CreationEntry): Promise<CreationResult> {
    const creation = this.#creation as SectionCreation;
    const result = await creation.run(entry);
    if (result.kind === "stale") await creation.cancel(result.entry);
    if (result.kind === "hosted" || result.kind === "local") {
      await this.#watch(fromKey(entry.resource));
      const file = this.app.vault.getFileByPath(entry.path);
      const open = this.#openEditor(entry.path);
      const text = open?.getValue() ?? (file === null ? null : await this.app.vault.read(file));
      if (text !== null) {
        this.#index(entry.path, text);
        if (open !== null) this.editor.remoteChanged(entry.path);
        else this.editor.remoteChanged(entry.path, text);
      }
    }
    return result;
  }

  async #watch(resource: ResourceId): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === null || this.#watched.has(toKey(resource))) return;
    this.#watched.add(toKey(resource));
    const profile = await runtime.openSection(resource);
    profile.onNodesChanged(() => void this.#remote(resource));
  }

  #openEditor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path)
        return leaf.view.editor;
    return null;
  }

  /** The changes `fn` computes, on the open editor's text, else on the file's. */
  async #edit(
    path: string,
    fn: (current: string) => readonly { from: number; to: number; insert: string }[] | null,
  ): Promise<void> {
    const editor = this.#openEditor(path);
    if (editor !== null) {
      const changes = fn(editor.getValue());
      if (changes === null || changes.length === 0) return;
      editor.transaction({
        changes: changes.map((c) => ({
          from: editor.offsetToPos(c.from),
          to: editor.offsetToPos(c.to),
          text: c.insert,
        })),
      });
      return;
    }
    const file = this.app.vault.getFileByPath(path);
    if (file === null) return;
    await this.app.vault.process(file, (text) => {
      const changes = fn(text);
      return changes === null ? text : applyChanges(text, changes);
    });
  }

  /**
   * "Share section…" (LFCP-02-049): the heading at or above the cursor
   * proposes the range; the preview shows exactly what would be shared. An
   * approved preview is revalidated against the note as it is then (UX02):
   * a changed range is shown again. Returns the approved preview, or null.
   */
  async shareSection(editor: Editor): Promise<SharePreview | null> {
    const md = editor.getValue();
    let line = editor.getCursor().line;
    let range: ShareRange | null = null;
    for (; line >= 0 && range === null; line--) range = proposeRange(md, line);
    if (range === null) {
      new Notice("Shared Tasks: put the cursor on or under a heading to share its section.");
      return null;
    }
    let preview = preflight(md, range);
    let note: string | undefined;
    for (;;) {
      const modal = new ShareSectionModal(this.app, preview, note);
      modal.open();
      if (!(await modal.result)) return null;
      const now = revalidate(editor.getValue(), preview);
      if (now.kind !== "changed") return now.preview;
      if (now.preview === null) {
        new Notice("Shared Tasks: the section's heading is gone. Nothing was shared.");
        return null;
      }
      preview = now.preview;
      note = "The note changed while the preview was open. Review the section again.";
    }
  }

  /** The vault changed: notes with sections are indexed and reconciled when closed. */
  async vaultChange(c: VaultChange): Promise<void> {
    if (c.kind === "delete") {
      this.#unindex(c.path);
      this.editor.deleted(c.path);
      return;
    }
    if (c.kind === "rename") {
      for (const paths of this.#notes.values()) if (paths.delete(c.oldPath)) paths.add(c.path);
      this.editor.renamed(c.oldPath, c.path);
      await this.#bases?.rename(c.oldPath, c.path);
    }
    const file = this.app.vault.getFileByPath(c.path);
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const text = await this.app.vault.read(file);
    const known = [...this.#notes.values()].some((p) => p.has(c.path));
    if (!known && !text.includes(SECTION_MARK)) return;
    this.#index(c.path, text);
    this.editor.fileChanged(c.path, text);
  }

  #index(path: string, text: string): void {
    this.#unindex(path);
    for (const s of parseSections(text).sections) {
      const key = toKey(s.ref.resourceId);
      this.#notes.set(key, (this.#notes.get(key) ?? new Set()).add(path));
    }
  }

  #unindex(path: string): void {
    for (const paths of this.#notes.values()) paths.delete(path);
  }

  /** A section's model changed: a pass on each note that holds it. */
  async #remote(resource: ResourceId): Promise<void> {
    for (const path of this.#notes.get(toKey(resource)) ?? []) {
      const open = this.app.workspace
        .getLeavesOfType("markdown")
        .some((l) => l.view instanceof MarkdownView && l.view.file?.path === path);
      if (open) this.editor.remoteChanged(path);
      else {
        const file = this.app.vault.getFileByPath(path);
        if (file !== null) this.editor.remoteChanged(path, await this.app.vault.read(file));
      }
    }
  }
}

/** What became of a creation, in a notice (UX §3). */
function notifyCreation(entry: CreationEntry, r: CreationResult): void {
  const title = entry.preview.title;
  if (r.kind === "hosted") new Notice(`Shared Tasks: section "${title}" is shared.`);
  else if (r.kind === "local")
    new Notice(
      `Shared Tasks: section "${title}" was created on this device; invitation is not ready yet. ${r.reason}`,
    );
  else if (r.kind === "stale")
    new Notice(
      `Shared Tasks: section "${title}" changed since the preview. Nothing was bound; share it again.`,
    );
  else if (r.kind === "failed")
    new Notice(`Shared Tasks: section "${title}" could not be created (${r.reason}).`);
}

function notifyInsertion(r: InsertResult): void {
  if (r.kind === "stale")
    new Notice("Shared Tasks: the note changed where the section would go. Insert it again.");
  else if (r.kind === "inserted" && (r.entry.warnings ?? []).length > 0)
    new Notice(
      "Shared Tasks: section inserted. The private text after it, up to the next heading, stays private but moves with its heading.",
    );
}

const notifyFailure = (entry: CreationEntry) => (e: unknown) => {
  new Notice(
    `Shared Tasks: creating section "${entry.preview.title}" stopped (${e instanceof Error ? e.message : String(e)}). It goes on at the next start.`,
  );
};

const fromKey = (b64: string): ResourceId => fromBase64url(b64) as ResourceId;

const toKey = (r: Uint8Array): string =>
  [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
