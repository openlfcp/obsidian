// The Obsidian side of the LFCP-065 commands: dialogs (Modal, SuggestModal),
// notices, and the active note. Deliberately plain: v0.1 is Markdown first,
// not a project-management sidebar.
//
// Secrets: the join field is a password input; the invitation dialog shows
// the link only when the user asks ("Show link") and copies it with
// "Copy link". Nothing here logs.

import type { InvitationLink } from "@openlfcp/client";
import { type App, MarkdownView, Modal, Notice, SuggestModal } from "obsidian";
import type { ActiveNote, Choice, NoteAccess, Prompter } from "../../core/collab/commands";
import type { Hint } from "../../core/collab/server-notice";
import type { ResourceStatus } from "../../core/collab/service";
import { statusView } from "../../core/collab/view";

/** One-line text input. */
class TextModal extends Modal {
  #done: (value: string | null) => void = () => undefined;
  #value: string | null = null;
  readonly result = new Promise<string | null>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    readonly o: {
      readonly title: string;
      readonly description?: string;
      readonly placeholder?: string;
      readonly value?: string;
      readonly masked?: boolean;
      readonly hint?: (value: string) => Hint | null;
    },
  ) {
    super(app);
  }

  override onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: this.o.title });
    if (this.o.description !== undefined) el.createEl("p", { text: this.o.description });
    const input = el.createEl("input", {
      type: this.o.masked === true ? "password" : "text",
      placeholder: this.o.placeholder ?? "",
      value: this.o.value ?? "",
    });
    if (this.o.value !== undefined) input.value = this.o.value;
    const hint = this.o.hint;
    if (hint !== undefined) {
      // A line under the field for its current value: shown, updated or
      // removed as the user types. Never blocks; links open in the browser.
      const line = el.createEl("p", { cls: "setting-item-description" });
      const show = () => {
        line.empty();
        const h = hint(input.value);
        if (h === null) return;
        line.createSpan({ text: `${h.text} ` });
        h.links.forEach((link, i) => {
          if (i > 0) line.createSpan({ text: " · " });
          line.createEl("a", { text: link.label, href: link.url });
        });
      };
      show();
      input.addEventListener("input", show);
    }
    const submit = () => {
      this.#value = input.value;
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent | undefined)?.key === "Enter") submit();
    });
    const buttons = el.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "OK", cls: "mod-cta" }).addEventListener("click", submit);
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    input.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done(this.#value);
  }
}

/** A pick from a list (fuzzy filtered by Obsidian). */
class ChoiceModal<T> extends SuggestModal<Choice<T>> {
  #done: (value: T | null) => void = () => undefined;
  readonly result = new Promise<T | null>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    readonly title: string,
    readonly choices: readonly Choice<T>[],
  ) {
    super(app);
    this.setPlaceholder(title);
  }

  getSuggestions(query: string): Choice<T>[] {
    const q = query.toLowerCase();
    return this.choices.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q),
    );
  }

  renderSuggestion(choice: Choice<T>, el: HTMLElement): void {
    el.createEl("div", { text: choice.label });
    if (choice.description !== undefined) el.createEl("small", { text: choice.description });
  }

  onChooseSuggestion(choice: Choice<T>): void {
    this.#done(choice.value);
  }

  override onClose(): void {
    // Obsidian closes the modal before reporting the choice: settle "cancelled" afterwards.
    setTimeout(() => this.#done(null), 0);
  }
}

/** A new invitation: copy it, or reveal it on request. */
class InvitationModal extends Modal {
  #done: () => void = () => undefined;
  readonly result = new Promise<void>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    readonly o: {
      readonly link: InvitationLink;
      readonly preset: string;
      readonly confirmed: boolean;
    },
    readonly copy: (text: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: `Invitation (${this.o.preset})` });
    el.createEl("p", {
      text: "Send this link to one person over a channel you trust. It works once and grants access to this collaboration: treat it like a password.",
    });
    el.createEl("p", {
      text: this.o.confirmed
        ? "The server has the invitation: the link works now."
        : "The server has not confirmed the invitation yet (offline?). The link works once this device has synced.",
    });
    const shown = el.createEl("input", { type: "password", value: "" });
    shown.readOnly = true;
    const buttons = el.createDiv({ cls: "modal-button-container" });
    const copy = buttons.createEl("button", { text: "Copy link", cls: "mod-cta" });
    copy.addEventListener("click", () => {
      void this.copy(this.o.link.reveal()).then(
        () => new Notice("Shared Tasks: invitation link copied."),
        () => new Notice("Shared Tasks: could not copy; use Show link."),
      );
    });
    buttons.createEl("button", { text: "Show link" }).addEventListener("click", () => {
      shown.type = "text";
      shown.value = this.o.link.reveal();
      shown.select();
    });
    buttons.createEl("button", { text: "Done" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done();
  }
}

/** The Resource status view, with its actions. */
class StatusModal extends Modal {
  #done: () => void = () => undefined;
  readonly result = new Promise<void>((r) => {
    this.#done = r;
  });

  constructor(
    app: App,
    readonly status: ResourceStatus,
    readonly actions: readonly Choice<() => Promise<void>>[],
  ) {
    super(app);
  }

  override onOpen(): void {
    const el = this.contentEl;
    el.empty();
    const view = statusView(this.status);
    el.createEl("h3", { text: view.title });
    if (view.banner !== null) el.createDiv({ text: view.banner, cls: "openlfcp-blocked" });
    const table = el.createEl("table");
    for (const row of view.rows) {
      const tr = table.createEl("tr");
      tr.createEl("th", { text: row.label });
      tr.createEl("td", { text: row.value });
    }
    const buttons = el.createDiv({ cls: "modal-button-container" });
    for (const action of this.actions)
      buttons.createEl("button", { text: action.label }).addEventListener("click", () => {
        this.close();
        void action.value();
      });
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.#done();
  }
}

const clipboard = async (text: string): Promise<void> => {
  const nav = (
    globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }
  ).navigator;
  if (nav?.clipboard === undefined) throw new Error("no clipboard");
  await nav.clipboard.writeText(text);
};

export class ObsidianPrompter implements Prompter {
  constructor(
    readonly app: App,
    readonly copy: (text: string) => Promise<void> = clipboard,
  ) {}

  notice(message: string): void {
    new Notice(message);
  }

  text(o: Parameters<Prompter["text"]>[0]): Promise<string | null> {
    const m = new TextModal(this.app, o);
    m.open();
    return m.result;
  }

  choose<T>(o: {
    readonly title: string;
    readonly choices: readonly Choice<T>[];
  }): Promise<T | null> {
    const m = new ChoiceModal(this.app, o.title, o.choices);
    m.open();
    return m.result;
  }

  invitation(o: Parameters<Prompter["invitation"]>[0]): Promise<void> {
    const m = new InvitationModal(this.app, o, this.copy);
    m.open();
    return m.result;
  }

  status(status: ResourceStatus, actions: readonly Choice<() => Promise<void>>[]): Promise<void> {
    const m = new StatusModal(this.app, status, actions);
    m.open();
    return m.result;
  }

  progress(title: string): { update(text: string): void; close(): void } {
    const n = new Notice(`Shared Tasks: ${title}…`, 0);
    return {
      update: (text) => n.setMessage(`Shared Tasks: ${text}`),
      close: () => n.hide(),
    };
  }
}

/** The active Markdown note and atomic writes through the vault. */
export class ObsidianNotes implements NoteAccess {
  constructor(readonly app: App) {}

  active(): ActiveNote | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (view === null || file === null || file === undefined) return null;
    return { path: file.path, line: view.editor.getCursor().line, text: view.editor.getValue() };
  }

  async rewrite(path: string, fn: (data: string) => string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error("The note is gone.");
    // Unsaved editor changes first, so the atomic write starts from what the user sees.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === path) await view.save();
    await this.app.vault.process(file, fn);
  }
}
