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
  getFileByPath(path: string): TFile | null {
    return this.files.has(path) ? { path } : null;
  }
  async read(file: TFile): Promise<string> {
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

/** Obsidian's SecretStorage: lowercase alphanumeric IDs with dashes; no delete. */
export class SecretStorage {
  readonly values = new Map<string, string>();
  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret ID ${id}`);
    this.values.set(id, secret);
  }
  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.values.keys()];
  }
}

export class Workspace {
  active: TFile | null = null;
  getActiveFile(): TFile | null {
    return this.active;
  }
}

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
  constructor(message: string) {
    notices.push(message);
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

export abstract class PluginSettingTab {
  readonly containerEl = new ContainerEl();
  constructor(
    readonly app: App,
    readonly plugin: Plugin,
  ) {}
  abstract display(): void;
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
