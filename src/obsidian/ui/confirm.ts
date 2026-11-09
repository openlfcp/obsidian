// A destructive action's confirmation: the consequences in words, the action
// as a warning button, Cancel focused (design 419: "Delete earlier identity
// data…", "Stop trying").

import { type App, Modal } from "obsidian";
import { returnsFocus } from "./focus-return";

const buttonRow = (el: HTMLElement): HTMLElement => el.createDiv({ cls: "modal-button-container" });

export interface ConfirmOptions {
  readonly title: string;
  readonly text: string;
  /** The action's button label, e.g. "Delete". */
  readonly confirm: string;
  readonly run: () => Promise<void>;
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly o: ConfirmOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.o.title);
    this.contentEl.createEl("p", { text: this.o.text });
    const buttons = buttonRow(this.contentEl);
    const go = buttons.createEl("button", { text: this.o.confirm, cls: "mod-warning" });
    go.addEventListener("click", () => {
      go.disabled = true;
      void this.o.run().finally(() => this.close());
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    cancel.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Opens the confirmation, focus given back when it closes (U03-18). */
export function confirmAction(app: App, o: ConfirmOptions): void {
  const modal = new ConfirmModal(app, o);
  returnsFocus(modal).open();
}
