// The Obsidian adapter: plugin lifecycle, commands and the settings tab.
// Only files under src/obsidian/ may import `obsidian`
// (scripts/check-boundaries.mjs); everything else lives in src/core/.

import { Notice, Plugin } from "obsidian";
import { COMMANDS, notImplementedMessage } from "../core/commands";
import { normalizeSettings, type Settings } from "../core/settings";
import { OpenLfcpSettingTab } from "./settings-tab";

export default class OpenLfcpPlugin extends Plugin {
  override settings: Settings = normalizeSettings(undefined);

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    for (const command of COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: () => {
          new Notice(notImplementedMessage(command));
        },
      });
    }
    this.addSettingTab(new OpenLfcpSettingTab(this.app, this));
  }

  // data.json changed outside the plugin, e.g. through vault sync.
  override async onExternalSettingsChange(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
