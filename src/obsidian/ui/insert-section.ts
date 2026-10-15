// "Insert shared section…" (LFCP-02-052, OBSIDIAN-SHARED-SECTIONS-UX-01
// §5): which section, then exactly what would be inserted, and where.
// Inserting writes the note only; nothing is sent. The place is the note
// the insert started on, after the paragraph at the cursor, unless the user
// chooses another existing note or names a new one (LFCP-03-016).

import { type App, Modal, SuggestModal } from "obsidian";
import type {
  DestinationChoice,
  InsertDestination,
  InsertPlace,
  SectionChoice,
} from "../../core/sections/action-ports";
import type { InsertPreview } from "../../core/sections/insert";

export type { SectionChoice };

export class PickSectionModal extends SuggestModal<SectionChoice> {
  #done: (choice: SectionChoice | null) => void = () => undefined;
  #chosen: SectionChoice | null = null;
  readonly result = new Promise<SectionChoice | null>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly choices: readonly SectionChoice[],
  ) {
    super(app);
    this.setPlaceholder("Insert which shared section?");
  }

  override getSuggestions(query: string): SectionChoice[] {
    const q = query.toLowerCase();
    return this.choices.filter((c) => c.title.toLowerCase().includes(q));
  }

  override renderSuggestion(choice: SectionChoice, el: HTMLElement): void {
    el.setText(choice.title);
  }

  override onChooseSuggestion(choice: SectionChoice): void {
    this.#chosen = choice;
  }

  override onClose(): void {
    // The choice is made just after close; settle on the next tick.
    window.setTimeout(() => this.#done(this.#chosen), 0);
  }
}

export class InsertSectionModal extends Modal {
  #done: (insert: boolean) => void = () => undefined;
  #insert = false;
  readonly result = new Promise<boolean>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly preview: InsertPreview,
    private readonly place?: InsertPlace,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.#draw();
  }

  #draw(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: `Insert section "${this.preview.title}"` });
    const where = this.place?.where ?? "into this note after the paragraph at the cursor";
    const line = el.createEl("p", { text: `These lines go ${where}. Nothing is sent.` });
    const place = this.place;
    if (place !== undefined) {
      line.createEl("button", { text: "Choose another note…" }).addEventListener("click", () => {
        void place.change().then(() => {
          if (!this.#closed) this.#draw();
        });
      });
      el.createEl("p", { text: placementsText(place.placements), cls: "setting-item-description" });
    }
    if (this.preview.readOnly)
      el.createEl("p", {
        text: "You can read this section but not edit it: typing in it is not applied, and edits made to the note by other means stay on this device.",
        cls: "setting-item-description",
      });
    el.createDiv({ text: this.preview.block, cls: "openlfcp-share-content" });
    const buttons = el.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Insert", cls: "mod-cta" }).addEventListener("click", () => {
      this.#insert = true;
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  #closed = false;

  override onClose(): void {
    this.#closed = true;
    this.contentEl.empty();
    this.#done(this.#insert);
  }
}

/** The notes that already hold the section, as the insert dialogs say it (UX contract §2). */
export function placementsText(placements: readonly string[] | null): string {
  if (placements === null) return "Looking for copies in your notes…";
  if (placements.length === 0) return "Not inserted in any note yet.";
  const names = placements.map(noteName).join(", ");
  return `Already in: ${names}. Inserting adds another copy.`;
}

const noteName = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** Characters a note name cannot hold (Obsidian refuses them in file names). */
const FORBIDDEN = /[\\:*?"<>|]/;

/** The path of a new note named `query`, or null when it is not a usable name. */
export function newNotePath(query: string): string | null {
  const name = query
    .trim()
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (name === "" || FORBIDDEN.test(name) || name.split("/").some((p) => p.trim() === ""))
    return null;
  return `${name}.md`;
}

type DestinationItem = InsertDestination & { readonly label: string };

/**
 * "Choose another note…" (LFCP-03-016): the note the insert started on, any
 * other Markdown note of the vault (its end), or a new note named by what
 * was typed when no file is there. The notes that already hold the section
 * are named above the list and marked in it.
 */
export class ChooseDestinationModal extends SuggestModal<DestinationItem> {
  #done: (d: InsertDestination | null) => void = () => undefined;
  #chosen: InsertDestination | null = null;
  readonly result = new Promise<InsertDestination | null>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly choice: DestinationChoice,
  ) {
    super(app);
    this.setPlaceholder("Insert into which note? Type a new name to create one");
  }

  override onOpen(): void {
    void super.onOpen();
    // Above the input: where the section already is (UX contract §6, "show existing placements").
    const info = this.modalEl.createDiv({
      cls: "setting-item-description",
      text: `"${this.choice.title}": ${placementsText(this.choice.placements)}`,
    });
    if (typeof this.modalEl.prepend === "function") this.modalEl.prepend(info);
  }

  override getSuggestions(query: string): DestinationItem[] {
    const q = query.trim().toLowerCase();
    const current = this.choice.current;
    const has = new Set(this.choice.placements ?? []);
    const mark = (path: string) => (has.has(path) ? " · already has this section" : "");
    const out: DestinationItem[] = [];
    if (current !== null && (q === "" || current.toLowerCase().includes(q)))
      out.push({
        kind: "here",
        label: `This note, "${noteName(current)}": after the paragraph at the cursor${mark(current)}`,
      });
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === current || !f.path.toLowerCase().includes(q)) continue;
      out.push({ kind: "note", path: f.path, label: `${f.path}: at its end${mark(f.path)}` });
    }
    // A new note only where no note is, whatever its case (macOS and Windows file names ignore it).
    const path = newNotePath(query);
    const taken = (p: string) =>
      this.app.vault.getAbstractFileByPath(p) !== null ||
      this.app.vault.getMarkdownFiles().some((f) => f.path.toLowerCase() === p.toLowerCase());
    if (path !== null && !taken(path))
      out.push({ kind: "new", path, label: `Create note "${noteName(path)}"` });
    return out;
  }

  override renderSuggestion(item: DestinationItem, el: HTMLElement): void {
    el.setText(item.label);
  }

  override onChooseSuggestion(item: DestinationItem): void {
    const { label: _label, ...d } = item;
    this.#chosen = d as InsertDestination;
  }

  override onClose(): void {
    // The choice is made just after close; settle on the next tick.
    window.setTimeout(() => this.#done(this.#chosen), 0);
  }
}
