// Shared sections in the plugin (MVP 0.2), behind the `sectionsPreview`
// development flag (off by default, set in data.json only): the editor
// extension, the engine on the real SDK (the runtime's sessions, its
// install database), the notes that hold sections, and the events that
// start passes. Not reachable with the flag off: the plugin then creates
// none of this.
//
// Known gaps of the preview, each its own task: Task fields inside a
// section are not rendered or sent (the SDK has no TaskView for section
// Tasks yet), write access is not checked (contract §6), and there is no
// sync status (026) nor a command to share a section.

import { generateObjectId, type PrincipalId, type ResourceId } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { type App, type Editor, MarkdownView, Notice, TFile } from "obsidian";
import type { LfcpRuntime } from "../core/lfcp/runtime";
import { SdkSectionPort } from "../core/lfcp/section-port";
import { newProjectionId } from "../core/sections/base";
import { SectionEngine } from "../core/sections/engine";
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
import { ShareSectionModal } from "./ui/share-section";

/** The text a note with a shared section always contains. */
const SECTION_MARK = "lfcp-section:";

export class SectionsHost {
  #engine: SectionEngine | null = null;
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
    for (const entry of await runtime.registry())
      if (entry.profile === SECTIONS_PROFILE_ID) {
        const profile = await runtime.openSection(entry.resourceId);
        profile.onNodesChanged(() => void this.#remote(entry.resourceId));
      }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes(SECTION_MARK)) continue;
      this.#index(file.path, text);
      this.editor.remoteChanged(file.path, text);
    }
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

const toKey = (r: Uint8Array): string =>
  [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
