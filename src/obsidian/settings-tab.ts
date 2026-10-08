// The settings tab (OBSIDIAN-ARCHITECTURE-01 §51). Identity (LFCP-059),
// ref placement and the default server.
//
// The UI keeps three things apart: the default server (where new
// collaborations are offered to sync), this vault's LFCP identity (a local
// Principal, not an account), and Resource owners (whoever created each
// Resource). Neither the Principal nor its keys are shown (decision 6);
// the public Principal ID is available to later UI through runtime.status.

import { type App, PluginSettingTab, type Setting, type SettingDefinitionItem } from "obsidian";
import { isRefPlacement, isSectionComments } from "../core/settings";
import type OpenLfcpPlugin from "./plugin";

/**
 * Declarative (Obsidian 1.13+, the plugin's minAppVersion is 1.13.1): the
 * settings are searchable from Obsidian's settings search, and the tab
 * re-renders through update(), never by re-calling display().
 */
export class OpenLfcpSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OpenLfcpPlugin,
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const status = () => this.plugin.runtime?.status;
    return [
      {
        name: "Identity on this device",
        searchable: false,
        render: (setting) => this.#identity(setting),
      },
      {
        name: "Storage may be cleared",
        desc: "This device did not grant persistent storage. If it clears Shared Tasks' local data, this vault stops writing as its current identity until you create a new one.",
        visible: () => {
          const s = status();
          return s?.kind === "ready" && s.persisted !== true;
        },
      },
      {
        name: "Ref placement",
        desc: "Where new lfcp-ref markers go, for shared tasks and in shared sections: on the line after the task (recommended) or on the task line. On the task line, the marker goes before the Tasks plugin's dates and other fields, which that plugin needs to find them. Existing refs keep their placement.",
        control: {
          type: "dropdown",
          key: "refPlacement",
          options: { "child-line": "Child line", inline: "Inline" },
        },
      },
      {
        name: "Show sharing metadata",
        desc: "Show the lines that bind a shared section (its start and end markers, and the marker under each task, paragraph and item) in Live Preview. Hidden by default; Source mode always shows them.",
        control: { type: "toggle", key: "showSharingMetadata" },
      },
      {
        name: "Comments in shared sections",
        desc: "Obsidian comments (%% … %%) and HTML comments you add inside a shared section: kept on this device only (default), or shared with the section like the rest of its text.",
        control: {
          type: "dropdown",
          key: "sectionComments",
          options: { local: "Keep local", shared: "Share" },
        },
      },
      {
        name: "Default server",
        desc: "The sync server offered when you create a collaboration. It is not your identity and does not own your collaborations. Default: the OpenLFCP project server (beta). Clear it to type a server each time.",
        control: { type: "text", key: "defaultServer", placeholder: "wss://…" },
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === "refPlacement") return this.plugin.settings.refPlacement;
    if (key === "defaultServer") return this.plugin.settings.defaultServer;
    if (key === "showSharingMetadata") return this.plugin.settings.showSharingMetadata;
    if (key === "sectionComments") return this.plugin.settings.sectionComments;
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "showSharingMetadata" && typeof value === "boolean") {
      await this.plugin.setShowSharingMetadata(value);
      return;
    }
    if (key === "refPlacement" && isRefPlacement(value)) this.plugin.settings.refPlacement = value;
    else if (key === "sectionComments" && isSectionComments(value))
      this.plugin.settings.sectionComments = value;
    else if (key === "defaultServer" && typeof value === "string")
      this.plugin.settings.defaultServer = value;
    else return;
    await this.plugin.saveSettings();
  }

  /** The identity row: its state, and "Create a new identity" when it is locked. */
  #identity(identity: Setting): void {
    const runtime = this.plugin.runtime;
    const status = runtime?.status;
    if (status === undefined) {
      identity.setDesc(
        this.plugin.runtimeError === null
          ? "Starting…"
          : `Shared Tasks could not start: ${this.plugin.runtimeError}`,
      );
      return;
    }
    if (status.kind === "ready") {
      // Decision 6 (LFCP-059): the Principal itself is not shown; no account exists.
      identity.setDesc(
        "Ready. This vault has its own identity on this device: a key pair, not an account. Its private keys never leave this device.",
      );
      return;
    }
    if (status.kind === "needs-restart") {
      identity.setDesc(`${status.message}. Restart Obsidian to continue.`);
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
            this.update();
          }),
        );
    }
  }
}
