// "Repair shared sections in this note" (LFCP-02-062, UX §9): each problem
// with what can be done about it. A broken boundary's end or start is picked
// by the user among exact candidate lines; a section whose base is lost shows
// both versions and asks which to keep. Nothing is applied without a choice.
// Only the section's own lines are shown. Text only.

import { type App, Modal } from "obsidian";
import type { ComparedLine, RepairItem } from "../../core/sections/repair";

export interface LostBase {
  readonly key: string;
  readonly title: string;
  readonly lines: readonly ComparedLine[];
}

export interface RepairActions {
  /** Places a missing marker after (end) or under (start) the chosen line. */
  boundary(
    item: Extract<RepairItem, { kind: "missing-end" | "missing-start" }>,
    line: number,
  ): Promise<void>;
  /** Moves the cursor to a line. */
  locate(line: number): void;
  /** Keeps the note's version: its differences are sent as this vault's edits. */
  shareMine(key: string): Promise<void>;
  /** Takes the shared version; the note's text is kept as a recovery copy first. */
  useShared(key: string): Promise<void>;
}

export class RepairModal extends Modal {
  constructor(
    app: App,
    private readonly items: readonly RepairItem[],
    private readonly lost: readonly LostBase[],
    private readonly actions: RepairActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("openlfcp-repair");
    this.setTitle("Repair shared sections in this note");
    const el = this.contentEl;
    if (this.items.length === 0 && this.lost.length === 0) {
      el.createEl("p", { text: "Nothing in this note needs repair." });
      return;
    }
    for (const item of this.items) {
      const box = el.createDiv({ cls: "openlfcp-repair-item" });
      if (item.kind === "locate") {
        box.createEl("p", { text: `Line ${item.line + 1}: ${item.message}` });
        box.createEl("button", { text: "Go to line" }).addEventListener("click", () => {
          this.close();
          this.actions.locate(item.line);
        });
        continue;
      }
      const lines =
        item.kind === "missing-end"
          ? item.candidates.map((c) => ({
              line: c.afterLine,
              text: `After line ${c.afterLine + 1}: ${c.preview}`,
            }))
          : item.candidates.map((c) => ({
              line: c.headingLine,
              text: `Under line ${c.headingLine + 1}: ${c.preview}`,
            }));
      box.createEl("p", {
        text:
          item.kind === "missing-end"
            ? `Section boundary needs repair: the section starting on line ${item.line + 1} has no end. Your text is kept locally. Where does it end?`
            : `Section boundary needs repair: the end marker on line ${item.line + 1} has no start. Your text is kept locally. Under which heading does it start?`,
      });
      if (lines.length === 0) {
        box.createEl("p", {
          text: "No safe place was found: edit the note by hand.",
          cls: "setting-item-description",
        });
        continue;
      }
      let picked: number | null = null;
      const apply = box.createEl("button", { text: "Apply", cls: "mod-cta" });
      apply.disabled = true;
      for (const c of lines) {
        const row = box.createEl("label", { cls: "openlfcp-repair-choice" });
        const radio = row.createEl("input", { type: "radio" });
        radio.name = `boundary-${item.line}`;
        row.createSpan({ text: ` ${c.text}` });
        radio.addEventListener("change", () => {
          picked = c.line;
          apply.disabled = false;
        });
      }
      box.appendChild(apply);
      apply.addEventListener("click", () => {
        if (picked === null) return;
        const line = picked;
        this.close();
        void this.actions.boundary(item, line);
      });
    }
    for (const lost of this.lost) {
      const box = el.createDiv({ cls: "openlfcp-repair-item" });
      box.createEl("p", {
        text: `"${lost.title}": local and shared versions need comparison. Nothing is sent or overwritten until you choose.`,
      });
      const diff = box.createDiv({ cls: "openlfcp-share-content" });
      for (const l of lost.lines)
        diff.createDiv({
          text: `${l.kind === "same" ? "  " : l.kind === "local" ? "− " : "+ "}${l.text}`,
          cls: `openlfcp-diff-${l.kind}`,
        });
      box.createEl("p", {
        text: "− only in this note · + only in the shared version",
        cls: "setting-item-description",
      });
      const buttons = box.createDiv({ cls: "modal-button-container" });
      buttons.createEl("button", { text: "Share my version" }).addEventListener("click", () => {
        this.close();
        void this.actions.shareMine(lost.key);
      });
      buttons
        .createEl("button", { text: "Use the shared version" })
        .addEventListener("click", () => {
          this.close();
          void this.actions.useShared(lost.key);
        });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
