// The details card of a shared section (LFCP-02-059, OBSIDIAN-SYNC-INDICATORS-01
// §8): a named dialog outside the note's content (Obsidian's modal layer, so
// a selection or a copy of the note never includes it), Escape to close,
// focus back where it was. Every string goes in as text, never as markup.
// It redraws while open when the section's status changes.

import { type App, Modal } from "obsidian";
import type { SectionCard } from "../../core/status/card";

export interface CardAction {
  readonly label: string;
  /** Runs after the card closes; the host revalidates the section first. */
  readonly run: () => void;
}

export class SectionCardModal extends Modal {
  #card: SectionCard;
  readonly #returnFocus: Element | null;

  constructor(
    app: App,
    card: SectionCard,
    private readonly actions: readonly CardAction[],
    private readonly onClosed: () => void = () => undefined,
  ) {
    super(app);
    this.#card = card;
    this.#returnFocus = activeDocument.activeElement;
  }

  /** New facts while the card is open. */
  update(card: SectionCard): void {
    this.#card = card;
    this.#render();
  }

  override onOpen(): void {
    this.modalEl.addClass("openlfcp-section-card");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-label", this.#card.heading);
    this.#render();
  }

  #render(): void {
    const c = this.#card;
    this.setTitle(c.heading);
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: c.status, cls: "openlfcp-card-status" });
    const list = (items: readonly string[], cls: string) => {
      if (items.length === 0) return;
      const ul = el.createEl("ul", { cls });
      for (const t of items) ul.createEl("li", { text: t });
    };
    list(c.problems, "openlfcp-card-problems");
    list(c.facts, "openlfcp-card-facts");
    el.createEl("h4", { text: "What is shared" });
    list(c.shared, "openlfcp-card-shared");
    if (c.participants.length > 0) {
      el.createEl("h4", { text: "People" });
      list(c.participants, "openlfcp-card-people");
    }
    const details = el.createEl("details", { cls: "openlfcp-card-technical" });
    details.createEl("summary", { text: "Technical details" });
    const ul = details.createEl("ul");
    for (const t of c.technical) ul.createEl("li", { text: t });
    if (this.actions.length > 0) {
      const buttons = el.createDiv({ cls: "modal-button-container" });
      for (const a of this.actions)
        buttons.createEl("button", { text: a.label }).addEventListener("click", () => {
          this.close();
          a.run();
        });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onClosed();
    if (this.#returnFocus instanceof HTMLElement && this.#returnFocus.isConnected)
      this.#returnFocus.focus();
  }
}
