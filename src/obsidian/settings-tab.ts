// The settings tab (OBSIDIAN-ARCHITECTURE-01 §51). Placeholders only.

import { type App, PluginSettingTab, Setting } from "obsidian";
import { isRefPlacement } from "../core/settings";
import type OpenLfcpPlugin from "./plugin";

export class OpenLfcpSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OpenLfcpPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Ref placement")
      .setDesc(
        "Where new lfcp-ref markers go: on the line after the task (recommended with suffix-sensitive task plugins) or at the end of the task line. Existing refs keep their placement.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("child-line", "Child line")
          .addOption("inline", "Inline")
          .setValue(this.plugin.settings.refPlacement)
          .onChange(async (value) => {
            if (isRefPlacement(value)) {
              this.plugin.settings.refPlacement = value;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Default server")
      .setDesc("Sync server offered when creating a collaboration (not used yet).")
      .addText((text) =>
        text
          .setPlaceholder("wss://…")
          .setValue(this.plugin.settings.defaultServer)
          .onChange(async (value) => {
            this.plugin.settings.defaultServer = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
