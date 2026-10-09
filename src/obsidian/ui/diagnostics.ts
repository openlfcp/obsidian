// "Export diagnostics…" (LFCP-02-065): the report previewed in full before
// it leaves this window, copied or saved as a local file only when the user
// asks. Nothing is sent anywhere. Identifiers and server addresses are a
// choice in the preview, off by default. Text only.

import { type App, Modal } from "obsidian";

export interface DiagnosticsActions {
  /** The report, with identifiers and server addresses when `detailed`. */
  report(detailed: boolean): Promise<string>;
  copy(text: string): Promise<void>;
  /** Saves the report as a local file; returns where. */
  save(text: string): Promise<string>;
  /** Tells the user what happened (a notice). */
  say(text: string): void;
}

export class DiagnosticsModal extends Modal {
  #detailed = false;
  #text = "";

  constructor(
    app: App,
    private readonly actions: DiagnosticsActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("openlfcp-diagnostics");
    this.setTitle("Shared Tasks diagnostics");
    const el = this.contentEl;
    el.createEl("p", {
      text: "This report stays on this device until you copy or save it. It holds versions, states, error codes and counts; no note text, task, name, path, key or invitation.",
      cls: "setting-item-description",
    });
    const preview = el.createEl("pre", { cls: "openlfcp-share-content" });
    preview.setAttribute("tabindex", "0");
    preview.setAttribute("aria-label", "Diagnostics report preview");
    const choice = el.createEl("label", { cls: "openlfcp-diagnostics-detail" });
    const box = choice.createEl("input", { type: "checkbox" });
    choice.createSpan({
      text: " Include identifiers and server addresses (only when someone helping you asks for them)",
    });
    const refresh = async () => {
      preview.setText("Preparing the report…");
      try {
        this.#text = await this.actions.report(this.#detailed);
        preview.setText(this.#text);
      } catch (e) {
        this.#text = "";
        preview.setText(
          `The report could not be prepared (${e instanceof Error ? e.name : "error"}). Nothing was copied or saved.`,
        );
      }
    };
    box.addEventListener("change", () => {
      this.#detailed = box.checked;
      void refresh();
    });
    const buttons = el.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Copy", cls: "mod-cta" }).addEventListener("click", () => {
      if (this.#text === "") return;
      void this.actions
        .copy(this.#text)
        .then(() => this.actions.say("Diagnostics copied."))
        .catch(() =>
          this.actions.say(
            "The diagnostics could not be copied. Select the text in this window and copy it instead.",
          ),
        );
    });
    buttons.createEl("button", { text: "Save as file" }).addEventListener("click", () => {
      if (this.#text === "") return;
      void this.actions
        .save(this.#text)
        .then((where) => this.actions.say(`Diagnostics saved to ${where}.`))
        .catch((e: unknown) =>
          this.actions.say(
            `The diagnostics could not be saved (${e instanceof Error ? e.message : "unknown error"}). Copy them from this window instead.`,
          ),
        );
    });
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    void refresh();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
