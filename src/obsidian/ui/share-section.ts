// "Share section…" (LFCP-02-049, OBSIDIAN-SHARED-SECTIONS-UX-01 §3): the
// preview of exactly what would be shared, in one scrollable dialog (no
// confirmation per Task). The words come from the core (shareMessages);
// Share is unavailable while a problem is listed.

import { type App, Modal } from "obsidian";
import { type SharePreview, shareMessages } from "../../core/sections/share";

export class ShareSectionModal extends Modal {
  #done: (share: boolean) => void = () => undefined;
  #share = false;
  readonly result = new Promise<boolean>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    private readonly preview: SharePreview,
    /** A line above the preview, e.g. after the note changed while it was open. */
    private readonly note?: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = shareMessages(this.preview);
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: m.heading });
    if (this.note !== undefined) el.createEl("p", { text: this.note });
    el.createEl("p", { text: m.scope });
    el.createEl("p", { text: m.counts, cls: "setting-item-description" });
    el.createDiv({ text: this.preview.content, cls: "openlfcp-share-content" });
    if (this.preview.privateTail !== null) {
      el.createEl("p", { text: "Stays private on this device:", cls: "setting-item-description" });
      el.createDiv({ text: this.preview.privateTail, cls: "openlfcp-share-content" });
    }
    for (const w of m.warnings) el.createEl("p", { text: w, cls: "setting-item-description" });
    for (const p of m.problems) el.createEl("p", { text: p, cls: "openlfcp-share-problem" });
    const buttons = el.createDiv({ cls: "modal-button-container" });
    const share = buttons.createEl("button", { text: "Share", cls: "mod-cta" });
    share.disabled = m.problems.length > 0;
    share.addEventListener("click", () => {
      this.#share = true;
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#share);
  }
}
