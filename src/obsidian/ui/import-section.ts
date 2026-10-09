// "Share section…" on a range with 0.1 shared Tasks (LFCP-02-053, UX §3,
// MVP-0.2-COMPATIBILITY-AND-MIGRATION §6.3): the import preview. It says
// plainly that this makes new shared Tasks and that the existing
// collaborations continue on their own, shows what enters sharing for the
// first time, and asks for every choice only the user can make. Text only.

import { type App, Modal } from "obsidian";
import type { ImportChoices, LegacyBlock, LegacyPreview } from "../../core/sections/legacy";

const BLOCK_TEXT = (b: LegacyBlock): string =>
  b.code === "UNKNOWN_SOURCE"
    ? `The shared task on line ${b.line + 1} is from a collaboration this device does not hold. Remove it from the section or join that collaboration first.`
    : b.code === "DELETED_SOURCE"
      ? `The shared task on line ${b.line + 1} was deleted in its collaboration.`
      : `The shared task on line ${b.line + 1} has data this version cannot copy (${b.fields.join(", ")}). Nothing is imported rather than losing it.`;

export class ImportSectionModal extends Modal {
  #done: (choices: ImportChoices | null) => void = () => undefined;
  #result: ImportChoices | null = null;
  readonly result = new Promise<ImportChoices | null>((r) => {
    this.#done = r;
  });
  readonly #values: Record<string, Record<string, unknown>> = {};
  readonly #copies = new Set<string>();

  constructor(
    app: App,
    private readonly title: string,
    private readonly preview: LegacyPreview,
  ) {
    super(app);
  }

  override onOpen(): void {
    const p = this.preview;
    const el = this.contentEl;
    this.setTitle(`Import "${this.title}" as a new shared section`);
    el.createEl("p", {
      text: `This makes new shared tasks with new identities, copied from ${p.tasks.length === 1 ? "1 shared task" : `${p.tasks.length} shared tasks`} as they are on this device now. The existing collaborations are not changed and continue separately: later edits in one do not reach the other.`,
    });
    if (p.pendingSources.length > 0)
      el.createEl("p", {
        text: "Some source collaborations have local changes not yet sent: the copy shows this device's state, which may not be the latest.",
        cls: "setting-item-description",
      });
    if (p.newlyShared.length > 0) {
      el.createEl("p", { text: "Shared for the first time with this section:" });
      el.createDiv({ text: p.newlyShared.join("\n"), cls: "openlfcp-share-content" });
    }
    for (const a of p.assignees)
      el.createEl("p", {
        text: `Assignees are copied as names only (${a.refs.length}): they get no access to the new section until you invite them.`,
        cls: "setting-item-description",
      });
    for (const b of p.blocks)
      el.createEl("p", { text: BLOCK_TEXT(b), cls: "openlfcp-share-problem" });
    for (const c of p.choices) {
      const row = el.createDiv({ cls: "openlfcp-import-choice" });
      if (c.code === "CONFLICT") {
        row.createEl("label", {
          text: `Conflicting ${c.field} in a source task: which value should the copy have? The source keeps its conflict.`,
        });
        const select = row.createEl("select");
        select.createEl("option", { text: "Choose…", value: "" });
        c.values.forEach((v, i) => {
          select.createEl("option", { text: JSON.stringify(v), value: String(i) });
        });
        select.addEventListener("change", () => {
          const own = this.#values[c.objectId] ?? {};
          this.#values[c.objectId] = own;
          if (select.value === "") delete own[c.field];
          else own[c.field] = c.values[Number(select.value)];
          this.#update();
        });
      } else {
        const box = row.createEl("input", { type: "checkbox" });
        row.createEl("label", {
          text: `A shared task appears ${c.lines.length} times. Import each occurrence as its own new task? (Or remove the extra lines first.)`,
        });
        box.addEventListener("change", () => {
          if (box.checked) this.#copies.add(c.objectId);
          else this.#copies.delete(c.objectId);
          this.#update();
        });
      }
    }
    const buttons = el.createDiv({ cls: "modal-button-container" });
    this.#import = buttons.createEl("button", { text: "Import", cls: "mod-cta" });
    this.#import.addEventListener("click", () => {
      this.#result = this.#choices();
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    this.#update();
  }

  #import: HTMLButtonElement | null = null;

  #choices(): ImportChoices {
    return {
      values: this.#values,
      copies: [...this.#copies],
    };
  }

  #update(): void {
    if (this.#import === null) return;
    const chosen = this.#choices();
    const missing = this.preview.choices.some((c) =>
      c.code === "REPEATED"
        ? !(chosen.copies ?? []).includes(c.objectId)
        : chosen.values?.[c.objectId]?.[c.field] === undefined,
    );
    this.#import.disabled = this.preview.blocks.length > 0 || missing;
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#result);
  }
}
