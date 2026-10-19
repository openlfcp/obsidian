// "Review conflicts…" of a shared section (LFCP-02-061, UX §9): each
// conflict with every known alternative, and an explicit choice per item.
// No "fix all", no "server wins". Applying re-reads the model first: if the
// item changed meanwhile, the new comparison is shown instead. Text only.
// Nothing is chosen for the user, not even the only option: Apply waits for
// a choice, and a choice not yet applied survives the list's re-render (after
// another item's Apply) while its item is unchanged.

import { type App, Modal } from "obsidian";
import type { RecoveryChoice, RecoveryItem } from "../../core/sections/recovery";

const FIELD: Readonly<Record<string, string>> = {
  title: "title",
  status: "status",
  due: "due date",
  scheduled: "scheduled date",
  priority: "priority",
};

/** What to ask about an item, and its options as choices. */
export function recoveryOptions(item: RecoveryItem): {
  readonly question: string;
  readonly choices: readonly { readonly label: string; readonly choice: RecoveryChoice }[];
} {
  switch (item.kind) {
    case "stale-work":
      return {
        question: `An offline edit from before an access change could not be sent: ${item.label}. Send it again, or discard it?`,
        choices: [
          { label: "Keep (send again)", choice: { keep: true } },
          { label: "Discard", choice: { keep: false } },
        ],
      };
    case "title":
      return {
        question: "The section's title was changed in two ways. Which title should it have?",
        choices: item.values.map((v) => ({ label: v, choice: { value: v } })),
      };
    case "field":
      return {
        question: `Two changes need a choice: the ${FIELD[item.field] ?? item.field} of ${item.label}.`,
        choices: item.values.map((v) => ({ label: v, choice: { value: v } })),
      };
    case "placement":
      return {
        question: `This item's location needs a choice: ${item.label} was moved to two places.`,
        choices: item.choices.map((c) => ({
          label: c.label,
          choice:
            c.after === undefined ? { parent: c.parent } : { parent: c.parent, after: c.after },
        })),
      };
    case "cycle":
      return {
        question:
          "These items were moved under each other. Which one moves out, to the section's top level?",
        choices: item.members.map((m) => ({ label: m.label, choice: { move: m.nodeId } })),
      };
    case "lifecycle":
      return {
        question: `${item.label} was deleted and restored at the same time. Keep it or delete it?`,
        choices: [
          { label: "Keep it", choice: { keep: true } },
          { label: "Delete it", choice: { keep: false } },
        ],
      };
    // The model names the node, not whether it was edited or moved (§9).
    case "retained":
      return item.ancestor === item.nodeId
        ? {
            question: `${item.label} was changed or moved while it was deleted. Restore it, or keep it deleted?`,
            choices: [
              { label: "Restore it", choice: { restore: true } },
              { label: "Keep it deleted", choice: { keep: false } },
            ],
          }
        : {
            question: `${item.label} was changed or moved while ${item.ancestorLabel}, which holds it, was deleted. Restore ${item.ancestorLabel}, or keep it deleted?`,
            choices: [
              { label: `Restore ${item.ancestorLabel}`, choice: { restore: true } },
              { label: "Keep it deleted", choice: { keep: false } },
            ],
          };
    case "reappeared":
      return {
        question: `${item.label} is in your note, but it was deleted from the shared section. Restore it or remove it from your note?`,
        choices: [
          { label: "Restore it where your note shows it", choice: { restore: true } },
          { label: "Remove it from your note", choice: { keep: false } },
        ],
      };
  }
}

let modalCount = 0;

export class RecoveryModal extends Modal {
  #items: readonly RecoveryItem[];
  #note: string | null = null;
  /** The radio groups' names: this modal's own, never another's (a group spans the document). */
  readonly #group = `openlfcp-recovery-${++modalCount}`;
  /** Choices made but not applied, by item key: kept while the item is the same. */
  readonly #pending = new Map<string, { readonly item: string; readonly index: number }>();

  constructor(
    app: App,
    private readonly title: string,
    items: readonly RecoveryItem[],
    /** Applies a choice after re-reading the model: the items as they are then, and a note. */
    private readonly apply: (
      item: RecoveryItem,
      choice: RecoveryChoice,
    ) => Promise<{ readonly items: readonly RecoveryItem[]; readonly note: string | null }>,
  ) {
    super(app);
    this.#items = items;
  }

  override onOpen(): void {
    this.modalEl.addClass("openlfcp-recovery");
    this.#render();
  }

  #render(): void {
    this.setTitle(`Conflicts in "${this.title}"`);
    const el = this.contentEl;
    el.empty();
    if (this.#note !== null) el.createEl("p", { text: this.#note, cls: "openlfcp-recovery-note" });
    if (this.#items.length === 0) {
      el.createEl("p", { text: "Nothing needs a choice now." });
      return;
    }
    el.createEl("p", {
      text: "Each choice is made on its own and becomes a new change of the section. Your note keeps its text until then.",
      cls: "setting-item-description",
    });
    // A choice for an item that is gone or changed is not carried over.
    for (const [key, p] of this.#pending)
      if (!this.#items.some((i) => i.key === key && JSON.stringify(i) === p.item))
        this.#pending.delete(key);
    for (const item of this.#items) {
      const { question, choices } = recoveryOptions(item);
      const box = el.createDiv({ cls: "openlfcp-recovery-item" });
      box.createEl("p", { text: question });
      const kept = this.#pending.get(item.key);
      let picked: RecoveryChoice | null =
        kept === undefined ? null : (choices[kept.index]?.choice ?? null);
      const list = box.createDiv();
      const apply = box.createDiv({ cls: "modal-button-container" }).createEl("button", {
        text: "Apply",
        cls: "mod-cta",
      });
      apply.disabled = picked === null;
      choices.forEach((c, k) => {
        const row = list.createEl("label", { cls: "openlfcp-recovery-choice" });
        const radio = row.createEl("input", { type: "radio" });
        radio.name = `${this.#group}:${item.key}`;
        radio.value = String(k);
        radio.checked = picked !== null && kept?.index === k;
        row.createSpan({ text: ` ${c.label}` });
        radio.addEventListener("change", () => {
          picked = c.choice;
          this.#pending.set(item.key, { item: JSON.stringify(item), index: k });
          apply.disabled = false;
        });
      });
      apply.addEventListener("click", () => {
        if (picked === null) return;
        apply.disabled = true;
        this.#pending.delete(item.key);
        void this.apply(item, picked).then((r) => {
          this.#items = r.items;
          this.#note = r.note;
          this.#render();
        });
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
