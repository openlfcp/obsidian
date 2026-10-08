// "Insert shared section…" (LFCP-02-052, OBSIDIAN-SHARED-SECTIONS-UX-01
// §5): which section, then exactly what would be inserted. Inserting
// writes the note only; nothing is sent.

import { type App, Modal, SuggestModal } from "obsidian";
import type { InsertPreview } from "../../core/sections/insert";

export interface SectionChoice {
  readonly resource: Uint8Array;
  readonly sectionId: string;
  readonly title: string;
}

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
  ) {
    super(app);
  }

  override onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: `Insert section "${this.preview.title}"` });
    el.createEl("p", {
      text: "These lines go into this note after the paragraph at the cursor. Nothing is sent.",
    });
    if (this.preview.readOnly)
      el.createEl("p", {
        text: "You can read this section but not edit it: changes you make here stay on this device.",
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

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#insert);
  }
}
