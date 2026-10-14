// The section actions (LFCP-03-008, F-C03, F-C08, U03-07): share, import,
// insert, detach, repair and the section card, Obsidian-free. An editor
// adapter supplies the ports of action-ports.ts; this executor decides what
// to ask, checks again before each side effect, and calls the section cores
// (share, create, insert, rules, repair, recovery). The palette and the
// card call it now; the menu and pane entries (LFCP-03-010, 012) call the
// same methods, so every surface shares one handler, one guard and one
// reservation per note.
//
// Behaviour is that of 0.4.0's SectionsHost, moved: the texts, the order of
// the dialogs and the checks are unchanged.

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import { type Flow, InFlight } from "../in-flight";
import { SECTIONS_READ_ONLY } from "../lfcp/runtime";
import { type NoteTarget, NoteTargets } from "../note-targets";
import { scanRefs } from "../refs";
import type {
  SectionDialog,
  SectionEditor,
  SectionNotes,
  SectionPrompter,
  SectionServices,
} from "./action-ports";
import type { CreationEntry, CreationResult } from "./create";
import { type InsertResult, insertRefusalMessage } from "./insert";
import { type LegacySource, legacyPreflight } from "./legacy";
import { preflight, proposeRange, revalidate, type SharePreview, type ShareRange } from "./share";

export interface SectionActionEnv {
  readonly prompter: SectionPrompter;
  readonly notes: SectionNotes;
  readonly services: SectionServices;
}

export class SectionActions {
  /** Share, import and insert flows, one per note at a time (F-03, F-C04), keyed by its held identity. */
  readonly #flows = new InFlight();
  /** The notes those flows act on, followed across renames (LFCP-03-002). */
  readonly #targets = new NoteTargets();

  constructor(private readonly env: SectionActionEnv) {}

  /** The vault renamed a note (its event, as it happens): a flow on it follows it. */
  noteRenamed(oldPath: string, path: string): void {
    this.#targets.renamed(oldPath, path);
  }

  /** The vault deleted a note: a flow on it writes nothing. */
  noteDeleted(path: string): void {
    this.#targets.deleted(path);
  }

  /**
   * "Share section…" as one flow per note (F-03): the preview, then the
   * creation of what was approved. A second start on the same note while
   * one runs (its preview open, or its section being created) opens no
   * second preview and creates nothing: it brings the open preview forward,
   * or says where the running flow stands (LFCP-03-002). Every entry path
   * (palette, hotkey, and the menu, card and pane entries to come) calls
   * this method, so they share the one reservation.
   */
  share(editor: SectionEditor, path: string): Promise<void> {
    return this.#oneFlow(path, "share", async (target, flow) => {
      const approved = await this.shareSection(editor, path, flow, target);
      if (approved === null) return;
      // The note as it is now: renamed meanwhile, its new path; deleted, nothing.
      if (target.path === null) {
        this.env.prompter.notice(
          "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
        );
        return;
      }
      flow.stage = `section "${approved.title}" is being shared from this note. Its result shows when it is done.`;
      await this.createSection(target.path, editor.text(), approved, target);
    });
  }

  /**
   * One share, import or insert per note at a time (F-03, F-C04), reserved
   * before any preview or allocation. The key is the note's held identity,
   * so a rename meanwhile keeps the reservation (LFCP-03-002). A repeated
   * start reveals the running flow: its open dialog, else where it stands.
   */
  async #oneFlow(
    path: string,
    kind: "share" | "insert",
    body: (target: NoteTarget, flow: Flow) => Promise<void>,
  ): Promise<void> {
    const held = this.#targets.hold(path);
    try {
      await this.#flows.run(
        `note:${held.target.id}`,
        (running) => this.#revealFlow(running),
        (flow) => body(held.target, flow),
        kind === "share"
          ? "a section of this note is being shared."
          : "a section is being inserted into this note.",
      );
    } finally {
      held.release();
    }
  }

  /** A repeated start of a running flow: its open dialog brought forward, else where it stands. */
  #revealFlow(running: Flow): void {
    if (running.reveal()) return;
    const text = `Shared Tasks: ${running.stage}`;
    this.env.prompter.notice(text);
    this.env.prompter.announce(text);
  }

  /** While `dialog` is open, a repeated start of `flow` brings it forward and says so. */
  #showing(flow: Flow | undefined, dialog: SectionDialog<unknown>, what: string): void {
    flow?.showing(() => {
      dialog.bringForward();
      this.env.prompter.announce(`Shared Tasks: ${what} is open. Finish or cancel it first.`);
    });
  }

  /**
   * "Insert shared section…" (LFCP-02-052): a ready, fully loaded section
   * of this vault, previewed, then written after the block at the cursor
   * as one complete projection.
   */
  insertSection(editor: SectionEditor, path: string): Promise<void> {
    return this.#oneFlow(path, "insert", (target, flow) =>
      this.#insertSection(editor, target, flow),
    );
  }

  async #insertSection(editor: SectionEditor, target: NoteTarget, flow: Flow): Promise<void> {
    const { prompter, services } = this.env;
    const insertion = services.insertion();
    const choices = insertion === null ? null : await services.sectionChoices();
    if (insertion === null || choices === null) {
      prompter.notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    if (choices.length === 0) {
      prompter.notice("Shared Tasks: no shared section on this device yet.");
      return;
    }
    const pick = prompter.pickSection(choices);
    this.#showing(flow, pick, "the choice of a section to insert");
    const choice = await pick.result;
    flow.showing(null);
    if (choice === null) return;
    const preview = await insertion.preview(choice.resource as ResourceId, choice.sectionId);
    if ("refused" in preview) {
      prompter.notice(insertRefusalMessage(preview.refused));
      return;
    }
    await services.watch(choice.resource as ResourceId);
    const dialog = prompter.insertPreview(preview);
    this.#showing(flow, dialog, "the insert preview");
    const approved = await dialog.result;
    flow.showing(null);
    if (!approved) return;
    const path = target.path;
    if (path === null) {
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
      );
      return;
    }
    const entry = await insertion.prepare(path, editor.text(), editor.cursorLine(), preview);
    const result = await insertion.run(entry);
    this.#notifyInsertion(result);
    if (result.kind === "inserted") {
      services.indexed(path, editor.text());
      services.pass(path);
    }
  }

  /** What became of an insertion, when there is something to say. */
  #notifyInsertion(r: InsertResult): void {
    if (r.kind === "stale")
      this.env.prompter.notice(
        "Shared Tasks: the note changed where the section would go. Insert it again.",
      );
    else if (r.kind === "inserted" && (r.entry.warnings ?? []).length > 0)
      this.env.prompter.notice(
        "Shared Tasks: section inserted. The private text after it, up to the next heading, stays private but moves with its heading.",
      );
  }

  /**
   * Creates the shared section of an approved preview (LFCP-02-050): the
   * creation is journaled first, then runs; an interrupted one goes on
   * at the next start.
   */
  async createSection(
    path: string,
    markdown: string,
    preview: SharePreview,
    /** The note held by the flow: a rename before the note is bound is followed (LFCP-03-002). */
    target?: NoteTarget,
  ): Promise<void> {
    const { prompter, services } = this.env;
    const creation = services.creation();
    if (creation === null) {
      prompter.notice("Shared Tasks: still starting. Share the section again in a moment.");
      return;
    }
    if (services.server().trim() === "") {
      prompter.notice(
        "Shared Tasks: set a default sync server in the settings to share a section.",
      );
      return;
    }
    const entry = await creation.prepare(path, markdown, preview);
    await this.#finish(entry, target).then(
      (r) => this.#notifyCreation(entry, r),
      this.#notifyFailure(entry),
    );
  }

  /** A creation a restart interrupted goes on from its journal (SSP §12.2), its result said. */
  resumeCreation(entry: CreationEntry): Promise<void> {
    return this.#finish(entry).then(
      (r) => this.#notifyCreation(entry, r),
      this.#notifyFailure(entry),
    );
  }

  /** Runs a creation; with the flow's held note, at that note's path at each write. */
  async #finish(entry: CreationEntry, target?: NoteTarget): Promise<CreationResult> {
    const { notes, services } = this.env;
    const creation = services.creation();
    if (creation === null) throw new Error("the section creation is not running");
    const result = await creation.run(entry, target === undefined ? undefined : () => target.path);
    if (result.kind === "stale") await creation.cancel(result.entry);
    // LFCP-03-011: a Resource created, or discarded with its stale creation.
    services.registryChanged();
    if (result.kind === "hosted" || result.kind === "local") {
      await services.watch(fromKey(entry.resource));
      // Where the creation bound it: the renamed note's path, if it moved.
      const path = result.entry.path;
      const open = notes.openEditor(path);
      const text = open?.text() ?? (await notes.read(path));
      if (text !== null) {
        services.indexed(path, text);
        if (open !== null) services.pass(path);
        else services.pass(path, text);
      }
    }
    return result;
  }

  /**
   * "Share section…" (LFCP-02-049): the heading at or above the cursor
   * proposes the range; the preview shows exactly what would be shared. An
   * approved preview is revalidated against the note as it is then (UX02):
   * a changed range is shown again. Returns the approved preview, or null.
   */
  async shareSection(
    editor: SectionEditor,
    path: string,
    flow?: Flow,
    target?: NoteTarget,
  ): Promise<SharePreview | null> {
    const { prompter, services } = this.env;
    // V3: no new shared section from a device where sections are read-only.
    if (services.readOnly()) {
      prompter.notice(`Shared Tasks: ${SECTIONS_READ_ONLY}.`);
      return null;
    }
    const md = editor.text();
    let line = editor.cursorLine();
    let range: ShareRange | null = null;
    for (; line >= 0 && range === null; line--) range = proposeRange(md, line);
    if (range === null) {
      prompter.notice("Shared Tasks: put the cursor on or under a heading to share its section.");
      return null;
    }
    let preview = preflight(md, range);
    // 0.1 shared Tasks in the range, and nothing else in the way: the explicit import (053).
    if (
      preview.problems.length > 0 &&
      preview.problems.every((p) => p.code === "LEGACY_SHARED_TASKS")
    ) {
      await this.#importFlow(editor, target ?? { id: 0, path }, range, preview.title, flow);
      return null;
    }
    let note: string | undefined;
    for (;;) {
      const dialog = prompter.sharePreview(preview, note);
      this.#showing(flow, dialog, `the share preview of "${preview.title}"`);
      const approved = await dialog.result;
      flow?.showing(null);
      if (!approved) return null;
      const now = revalidate(editor.text(), preview);
      if (now.kind !== "changed") return now.preview;
      if (now.preview === null) {
        prompter.notice("Shared Tasks: the section's heading is gone. Nothing was shared.");
        return null;
      }
      preview = now.preview;
      note = "The note changed while the preview was open. Review the section again.";
    }
  }

  /**
   * Imports a range with 0.1 shared Tasks into a new shared section (053,
   * 054): the preview and the user's choices first, then the journaled
   * creation; the note's refs are replaced only once the copy is durable.
   */
  async #importFlow(
    editor: SectionEditor,
    target: NoteTarget,
    range: ShareRange,
    title: string,
    flow?: Flow,
  ): Promise<void> {
    const { prompter, services } = this.env;
    const creation = services.creation();
    if (creation === null) {
      prompter.notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    const md = editor.text();
    // The sources as this device holds them now (0.1 collaborations).
    const sources = new Map<string, LegacySource>();
    for (const p of scanRefs(md).projections) {
      if (p.taskLine <= range.headingLine || p.taskLine > range.lastLine) continue;
      const key = `${toBase64url(p.resourceId)}#${p.objectId}`;
      if (sources.has(key)) continue;
      try {
        const found = await services.legacySource(p.resourceId as ResourceId, p.objectId);
        if (found !== undefined) sources.set(key, found);
      } catch {
        // Not on this device, or another profile: the preflight blocks it.
      }
    }
    const source = (resource: string, objectId: string) => sources.get(`${resource}#${objectId}`);
    const preview = legacyPreflight(md, range, source);
    const dialog = prompter.importPreview(title, preview);
    this.#showing(flow, dialog, `the import preview of "${title}"`);
    const chosen = await dialog.result;
    flow?.showing(null);
    if (chosen === null) return;
    const path = target.path;
    if (path === null) {
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was imported.",
      );
      return;
    }
    if (flow !== undefined) flow.stage = `section "${title}" is being imported from this note.`;
    if (services.server().trim() === "") {
      prompter.notice(
        "Shared Tasks: set a default sync server in the settings to share a section.",
      );
      return;
    }
    let entry: CreationEntry;
    try {
      entry = await creation.prepareImport(path, editor.text(), range, source, chosen);
    } catch (e) {
      prompter.notice(
        `Shared Tasks: the import cannot start (${e instanceof Error ? e.message : String(e)}). Nothing changed.`,
      );
      return;
    }
    await this.#finish(entry, target).then(
      (r) => this.#notifyCreation(entry, r),
      this.#notifyFailure(entry),
    );
  }

  /** What became of a creation, in a notice (UX §3). */
  #notifyCreation(entry: CreationEntry, r: CreationResult): void {
    const notice = (m: string) => this.env.prompter.notice(m);
    const title = entry.preview.title;
    if (r.kind === "hosted") notice(`Shared Tasks: section "${title}" is shared.`);
    else if (r.kind === "local")
      notice(
        `Shared Tasks: section "${title}" was created on this device; invitation is not ready yet. ${r.reason}`,
      );
    else if (r.kind === "stale")
      notice(
        `Shared Tasks: section "${title}" changed since the preview. Nothing was bound; share it again.`,
      );
    else if (r.kind === "failed")
      notice(`Shared Tasks: section "${title}" could not be created (${r.reason}).`);
  }

  /** A creation that threw: its outcome is unknown, so it is left to its journal. */
  #notifyFailure(entry: CreationEntry): (e: unknown) => void {
    return (e) =>
      this.env.prompter.notice(
        `Shared Tasks: creating section "${entry.preview.title}" stopped (${e instanceof Error ? e.message : String(e)}). It goes on at the next start.`,
      );
  }
}

const fromKey = (b64: string): ResourceId => fromBase64url(b64) as ResourceId;
