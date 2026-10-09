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
    /** Per identity: set its local alias (a label of this device only). */
    private readonly rowActions: {
      readonly alias?: (id: string, label: string) => void;
      /** Remove this identity's access (060): the host confirms first. */
      readonly remove?: (principal: string, label: string) => void;
    } = {},
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
    const access = c.access;
    if (access !== undefined) {
      el.createEl("h4", { text: access.heading });
      el.createEl("p", { text: access.freshness, cls: "setting-item-description" });
      if (!access.unknown) {
        const ul = el.createEl("ul", { cls: "openlfcp-card-access" });
        for (const row of access.rows) {
          const li = ul.createEl("li");
          li.createSpan({ text: `${row.label} (${row.role})` });
          if (!row.you) li.createSpan({ text: ` · ${row.detail}`, cls: "openlfcp-card-identity" });
          if (!row.you && this.rowActions.alias !== undefined)
            li.createEl("button", {
              text: "Name…",
              cls: "openlfcp-card-row-action",
            }).addEventListener("click", () => this.rowActions.alias?.(row.id, row.label));
          // Offered by the validated abilities, and only while removing can be done now.
          if (row.removable && access.removeNote === null && this.rowActions.remove !== undefined)
            li.createEl("button", {
              text: "Remove access…",
              cls: "openlfcp-card-row-action mod-warning",
            }).addEventListener("click", () => this.rowActions.remove?.(row.principal, row.label));
        }
        if (access.removeNote !== null)
          el.createEl("p", { text: access.removeNote, cls: "setting-item-description" });
      }
      list(access.invitations, "openlfcp-card-invitations");
      list(access.pending, "openlfcp-card-pending");
      if (access.inviteNote !== null)
        el.createEl("p", { text: access.inviteNote, cls: "setting-item-description" });
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

/** A local name for an identity: a label of this device only, never sent or verified. */
export class AliasModal extends Modal {
  #done: (name: string | null) => void = () => undefined;
  #value: string | null = null;
  readonly result = new Promise<string | null>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly current: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Name this identity on this device");
    this.contentEl.createEl("p", {
      text: "A local label to recognise this identity. Only this device sees it; it is not a verified name. Leave it empty to remove it.",
      cls: "setting-item-description",
    });
    const input = this.contentEl.createEl("input", { type: "text", value: this.current });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const save = () => {
      this.#value = input.value;
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", save);
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    input.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#value);
  }
}

/** A yes/no question before an action that cannot be taken back. */
export class ConfirmModal extends Modal {
  #done: (yes: boolean) => void = () => undefined;
  #yes = false;
  readonly result = new Promise<boolean>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly title: string,
    private readonly question: string,
    private readonly action: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.question });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: this.action, cls: "mod-warning" })
      .addEventListener("click", () => {
        this.#yes = true;
        this.close();
      });
    // The safe choice has the focus.
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    cancel.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#yes);
  }
}
