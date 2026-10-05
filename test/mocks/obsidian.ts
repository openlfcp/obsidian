// A minimal stand-in for the `obsidian` module, enough for the adapter
// layer's unit tests (vitest.config.ts aliases `obsidian` here). It records
// what the plugin registers instead of drawing any UI.

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
}

export class App {}

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

  async onload(): Promise<void> {}

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

export class Setting {
  name = "";
  desc = "";
  dropdown?: DropdownComponent;
  text?: TextComponent;

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
  addText(build: (text: TextComponent) => unknown): this {
    this.text = new TextComponent();
    build(this.text);
    return this;
  }
}
