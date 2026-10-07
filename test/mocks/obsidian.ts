// A minimal stand-in for the `obsidian` module, enough for the adapter
// layer's unit tests (vitest.config.ts aliases `obsidian` here). It records
// what the plugin registers instead of drawing any UI.

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
}

/** A registered event handler (Obsidian's EventRef). */
export interface EventRef {
  readonly name: string;
  readonly callback: (...args: unknown[]) => unknown;
}

export interface TAbstractFile {
  path: string;
}

export interface TFile extends TAbstractFile {}

/** The vault's files and event source: tests write files and trigger events by name. */
export class Vault {
  readonly handlers: EventRef[] = [];
  readonly files = new Map<string, string>();
  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((path) => ({ path }));
  }
  getFileByPath(path: string): TFile | null {
    return this.files.has(path) ? { path } : null;
  }
  /** The paths read with read() and with cachedRead(), in order. */
  readonly reads: string[] = [];
  readonly cachedReads: string[] = [];
  async read(file: TFile): Promise<string> {
    this.reads.push(file.path);
    return this.files.get(file.path) ?? "";
  }
  async cachedRead(file: TFile): Promise<string> {
    this.cachedReads.push(file.path);
    return this.files.get(file.path) ?? "";
  }
  /** Writes like Obsidian: the content changes, then a modify event fires. */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.files.get(file.path) ?? "");
    this.files.set(file.path, next);
    this.trigger("modify", { path: file.path });
    return next;
  }
  on(name: string, callback: (...args: unknown[]) => unknown): EventRef {
    const ref = { name, callback };
    this.handlers.push(ref);
    return ref;
  }
  offref(ref: EventRef): void {
    const i = this.handlers.indexOf(ref);
    if (i >= 0) this.handlers.splice(i, 1);
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const h of this.handlers.filter((x) => x.name === name)) h.callback(...args);
  }
}

/** Obsidian's secret ID rule, with its exact error. */
export function checkSecretId(id: string): void {
  if (!/^[a-z0-9-]{1,64}$/.test(id))
    throw new Error(
      "Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.",
    );
}

/** Obsidian's SecretStorage: IDs per checkSecretId; no delete. */
export class SecretStorage {
  readonly values = new Map<string, string>();
  setSecret(id: string, secret: string): void {
    checkSecretId(id);
    this.values.set(id, secret);
  }
  getSecret(id: string): string | null {
    checkSecretId(id);
    return this.values.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.values.keys()];
  }
}

/** An open editor on a note: its buffer may differ from the file (unsaved changes). */
export class MarkdownView {
  /** The cursor's 0-based line (LFCP-065 commands act on it). */
  cursorLine = 0;
  /** How many times save() ran. */
  saves = 0;
  constructor(
    public file: TFile | null,
    public buffer: string,
  ) {}
  /** The selection, if any: from and to positions (POST-018). */
  selection: { from: { line: number; ch: number }; to: { line: number; ch: number } } | null = null;
  readonly editor = {
    getValue: () => this.buffer,
    getCursor: (which?: "from" | "to" | "head" | "anchor") =>
      which === "from" && this.selection !== null
        ? this.selection.from
        : which === "to" && this.selection !== null
          ? this.selection.to
          : { line: this.cursorLine, ch: 0 },
    somethingSelected: () => this.selection !== null,
  };
  async save(): Promise<void> {
    this.saves += 1;
  }
}

export class Workspace {
  active: TFile | null = null;
  /** Open Markdown editors. */
  readonly views: MarkdownView[] = [];
  getActiveFile(): TFile | null {
    return this.active;
  }
  /** The focused editor view (LFCP-065). */
  activeView: MarkdownView | null = null;
  getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null {
    return this.activeView instanceof type ? (this.activeView as T) : null;
  }
  getLeavesOfType(type: string): { view: MarkdownView }[] {
    return type === "markdown" ? this.views.map((view) => ({ view })) : [];
  }
  onLayoutReady(callback: () => unknown): void {
    callback();
  }
}

/** Stands in for Obsidian's editor state field (the conflict decoration reads it). */
export const editorInfoField = {};

export class App {
  readonly vault = new Vault();
  readonly workspace = new Workspace();
  /** Device-level, shared by every vault (as in Obsidian). */
  secretStorage = new SecretStorage();
  /** Vault-scoped localStorage. */
  readonly local = new Map<string, unknown>();
  loadLocalStorage(key: string): unknown {
    return this.local.get(key) ?? null;
  }
  saveLocalStorage(key: string, data: unknown): void {
    if (data === null) this.local.delete(key);
    else this.local.set(key, structuredClone(data));
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
}

/** Every Notice shown, oldest first. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string, _timeout?: number) {
    notices.push(message);
  }
  setMessage(message: string): this {
    notices.push(message);
    return this;
  }
  hide(): void {}
}

/** A DOM element as the plugin's modals use it (createEl, text, inputs, clicks). */
export class FakeElement {
  text = "";
  value = "";
  type = "";
  placeholder = "";
  cls = "";
  href = "";
  readOnly = false;
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event?: unknown) => unknown)[]>();
  constructor(readonly tag: string) {}
  createEl(
    tag: string,
    o: {
      text?: string;
      cls?: string;
      type?: string;
      placeholder?: string;
      value?: string;
      href?: string;
    } = {},
  ): FakeElement {
    const el = new FakeElement(tag);
    el.text = o.text ?? "";
    el.href = o.href ?? "";
    el.cls = o.cls ?? "";
    el.type = o.type ?? "";
    el.placeholder = o.placeholder ?? "";
    el.value = o.value ?? "";
    this.children.push(el);
    return el;
  }
  createDiv(o: { text?: string; cls?: string } = {}): FakeElement {
    return this.createEl("div", o);
  }
  createSpan(o: { text?: string; cls?: string } = {}): FakeElement {
    return this.createEl("span", o);
  }
  empty(): void {
    this.children.length = 0;
    this.text = "";
  }
  setText(text: string): void {
    this.text = text;
  }
  addClass(cls: string): void {
    this.cls = `${this.cls} ${cls}`.trim();
  }
  addEventListener(type: string, fn: (event?: unknown) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  trigger(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  click(): void {
    this.trigger("click");
  }
  focus(): void {}
  select(): void {}
  /** Every text in the subtree, as a reader of the rendered view would see it (input values included). */
  get textContent(): string {
    return [this.text, this.value, ...this.children.map((c) => c.textContent)]
      .filter((t) => t !== "")
      .join("\n");
  }
  /** Descendants matching `tag`, in document order. */
  findAll(tag: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.findAll(tag)]);
  }
}

/** Every modal opened, oldest first. */
export const modals: Modal[] = [];

export class Modal {
  readonly contentEl = new FakeElement("div");
  readonly titleEl = new FakeElement("div");
  isOpen = false;
  constructor(readonly app: App) {}
  open(): void {
    this.isOpen = true;
    modals.push(this);
    void this.onOpen();
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
  onOpen(): Promise<void> | void {}
  onClose(): void {}
}

export abstract class SuggestModal<T> extends Modal {
  readonly inputEl = new FakeElement("input");
  placeholder = "";
  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: FakeElement): void;
  abstract onChooseSuggestion(item: T, evt: unknown): void;
  /** What a user picking the suggestion does: Obsidian closes the modal first, then reports the choice. */
  async pick(match: (rendered: string) => boolean): Promise<void> {
    for (const item of await this.getSuggestions("")) {
      const el = new FakeElement("div");
      this.renderSuggestion(item, el);
      if (match(el.textContent)) {
        this.close();
        this.onChooseSuggestion(item, {});
        return;
      }
    }
    throw new Error("no matching suggestion");
  }
}

export class Plugin {
  settings?: unknown;
  readonly commands: Command[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  /** What saveData stored; what loadData returns. */
  stored: unknown;

  constructor(
    readonly app: App,
    readonly manifest: PluginManifest,
  ) {}

  /** Event refs registered for unload (detached by unload()). */
  readonly events: EventRef[] = [];

  async onload(): Promise<void> {}

  onunload(): void {}

  registerEvent(ref: EventRef): void {
    this.events.push(ref);
  }

  /** Status bar items, with their current text. */
  readonly statusBar: { text: string; setText(t: string): void }[] = [];
  addStatusBarItem(): { text: string; setText(t: string): void } {
    const item = {
      text: "",
      setText(t: string) {
        item.text = t;
      },
    };
    this.statusBar.push(item);
    return item;
  }

  readonly editorExtensions: unknown[] = [];
  registerEditorExtension(extension: unknown): void {
    this.editorExtensions.push(extension);
  }

  /** What Obsidian does on disable: detach registered events, then onunload. */
  unload(): void {
    for (const ref of this.events.splice(0)) (this.app as App).vault.offref(ref);
    this.onunload();
  }

  onExternalSettingsChange?(): unknown;

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  async loadData(): Promise<unknown> {
    return this.stored;
  }

  async saveData(data: unknown): Promise<void> {
    this.stored = structuredClone(data);
  }
}

/** The controls a settings tab created, in order. */
export class ContainerEl {
  readonly settings: Setting[] = [];
  empty(): void {
    this.settings.length = 0;
  }
}

/** The declarative settings of Obsidian 1.13 that the plugin uses. */
interface Definition {
  name: string;
  desc?: string;
  visible?: boolean | (() => boolean);
  searchable?: boolean | (() => boolean);
  render?: (setting: Setting) => unknown;
  control?: {
    type: "dropdown" | "text";
    key: string;
    options?: Record<string, string>;
    placeholder?: string;
  };
}

/** Renders getSettingDefinitions() like Obsidian 1.13 (display() and update()). */
export abstract class PluginSettingTab {
  readonly containerEl = new ContainerEl();
  constructor(
    readonly app: App,
    readonly plugin: Plugin,
  ) {}
  getSettingDefinitions(): Definition[] {
    return [];
  }
  getControlValue(_key: string): unknown {
    return undefined;
  }
  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
  display(): void {
    this.update();
  }
  update(): void {
    this.containerEl.empty();
    for (const d of this.getSettingDefinitions()) {
      const visible = typeof d.visible === "function" ? d.visible() : (d.visible ?? true);
      if (!visible) continue;
      const setting = new Setting(this.containerEl).setName(d.name);
      if (d.desc !== undefined) setting.setDesc(d.desc);
      d.render?.(setting);
      const c = d.control;
      if (c?.type === "dropdown")
        setting.addDropdown((dropdown) => {
          for (const [value, label] of Object.entries(c.options ?? {}))
            dropdown.addOption(value, label);
          dropdown.setValue(String(this.getControlValue(c.key) ?? ""));
          dropdown.onChange((value) => this.setControlValue(c.key, value));
        });
      if (c?.type === "text")
        setting.addText((text) => {
          text.setPlaceholder(c.placeholder ?? "");
          text.setValue(String(this.getControlValue(c.key) ?? ""));
          text.onChange((value) => this.setControlValue(c.key, value));
        });
    }
  }
}

type Change = (value: string) => unknown;

export class DropdownComponent {
  readonly options = new Map<string, string>();
  value = "";
  onChangeHandler: Change = () => undefined;
  addOption(value: string, display: string): this {
    this.options.set(value, display);
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(handler: Change): this {
    this.onChangeHandler = handler;
    return this;
  }
}

export class TextComponent {
  value = "";
  placeholder = "";
  onChangeHandler: Change = () => undefined;
  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(handler: Change): this {
    this.onChangeHandler = handler;
    return this;
  }
}

export class ButtonComponent {
  text = "";
  onClickHandler: () => unknown = () => undefined;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  onClick(handler: () => unknown): this {
    this.onClickHandler = handler;
    return this;
  }
}

export class Setting {
  name = "";
  desc = "";
  dropdown?: DropdownComponent;
  text?: TextComponent;
  button?: ButtonComponent;

  constructor(container: ContainerEl) {
    container.settings.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  addDropdown(build: (dropdown: DropdownComponent) => unknown): this {
    this.dropdown = new DropdownComponent();
    build(this.dropdown);
    return this;
  }
  addButton(build: (button: ButtonComponent) => unknown): this {
    this.button = new ButtonComponent();
    build(this.button);
    return this;
  }
  addText(build: (text: TextComponent) => unknown): this {
    this.text = new TextComponent();
    build(this.text);
    return this;
  }
}
