// The settings tab (OBSIDIAN-ARCHITECTURE-01 §51). Identity (LFCP-059),
// ref placement and the default server.
//
// The UI keeps three things apart: the default server (where new
// collaborations are offered to sync), this vault's LFCP identity (a local
// Principal, not an account), and Resource owners (whoever created each
// Resource). Neither the Principal nor its keys are shown (decision 6);
// the public Principal ID is available to later UI through runtime.status.

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
    this.#identity(containerEl);

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
      .setDesc(
        "The sync server offered when you create a collaboration. It is not your identity and does not own your collaborations.",
      )
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

  #identity(containerEl: ContainerLike): void {
    const runtime = this.plugin.runtime;
    const status = runtime?.status;
    const identity = new Setting(containerEl).setName("Identity on this device");
    if (status === undefined) {
      identity.setDesc(
        this.plugin.runtimeError === null
          ? "Starting…"
          : `OpenLFCP could not start: ${this.plugin.runtimeError}`,
      );
      return;
    }
    if (status.kind === "ready") {
      // Decision 6 (LFCP-059): the Principal itself is not shown; no account exists.
      identity.setDesc(
        "Ready. This vault has its own identity on this device: a key pair, not an account. Its private keys never leave this device.",
      );
      if (status.persisted !== true)
        new Setting(containerEl)
          .setName("Storage may be cleared")
          .setDesc(
            "This device did not grant persistent storage. If it clears OpenLFCP's local data, this vault stops writing as its current identity until you create a new one.",
          );
      return;
    }
    if (status.kind === "locked") {
      identity.setDesc(
        `Writing is paused. ${status.message} To keep collaborating from this vault, create a new identity; collaborators then need to invite it again.`,
      );
      if (status.reason !== "lock-held")
        identity.addButton((button) =>
          button.setButtonText("Create a new identity").onClick(async () => {
            await runtime?.createNewPrincipal();
            this.display();
          }),
        );
    }
  }
}

type ContainerLike = PluginSettingTab["containerEl"];
