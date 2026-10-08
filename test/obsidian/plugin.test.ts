// The adapter layer against the `obsidian` mock (test/mocks/obsidian.ts):
// what Obsidian would see when it enables the plugin.

import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_SERVER } from "../../src/core/settings";
import OpenLfcpPlugin from "../../src/main";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

async function loaded(stored?: unknown) {
  const plugin = new OpenLfcpPlugin(new mock.App() as never, manifest as never);
  const host = plugin as unknown as mock.Plugin;
  host.stored = stored;
  await plugin.onload();
  return { plugin, host };
}

describe("plugin", () => {
  beforeEach(() => {
    mock.notices.length = 0;
  });

  it("loads stored settings and normalizes them", async () => {
    const { plugin } = await loaded({ refPlacement: "inline", defaultServer: 7 });
    expect(plugin.settings).toEqual({
      refPlacement: "inline",
      defaultServer: PROJECT_SERVER,
      showSharingMetadata: false,
      settingsVersion: 2,
    });
  });

  it("reloads settings changed outside the plugin", async () => {
    const { plugin, host } = await loaded();
    host.stored = { refPlacement: "inline" };
    await plugin.onExternalSettingsChange();
    expect(plugin.settings.refPlacement).toBe("inline");
  });

  it("declares its settings for Obsidian 1.13 settings search, without its own display()", async () => {
    const { host } = await loaded();
    const tab = host.settingTabs[0] as mock.PluginSettingTab;
    expect(Object.hasOwn(Object.getPrototypeOf(tab), "display")).toBe(false);
    const controls = tab
      .getSettingDefinitions()
      .filter((d) => d.control !== undefined)
      .map((d) => [d.name, d.control?.type, d.control?.key]);
    expect(controls).toEqual([
      ["Ref placement", "dropdown", "refPlacement"],
      ["Show sharing metadata", "toggle", "showSharingMetadata"],
      ["Default server", "text", "defaultServer"],
    ]);
  });

  it("settings tab edits and saves the placeholders", async () => {
    const { plugin, host } = await loaded();
    expect(host.settingTabs).toHaveLength(1);
    const tab = host.settingTabs[0] as mock.PluginSettingTab;
    tab.display();
    const named = (name: string) => tab.containerEl.settings.find((x) => x.name === name);
    const [placement, server] = [named("Ref placement"), named("Default server")];
    expect(placement?.name).toBe("Ref placement");
    expect([...(placement?.dropdown?.options.keys() ?? [])]).toEqual(["child-line", "inline"]);
    expect(placement?.dropdown?.value).toBe("child-line");

    await placement?.dropdown?.onChangeHandler("inline");
    expect(plugin.settings.refPlacement).toBe("inline");
    expect(host.stored).toEqual({
      refPlacement: "inline",
      defaultServer: PROJECT_SERVER,
      showSharingMetadata: false,
      settingsVersion: 2,
    });
    expect(server?.text?.value).toBe(PROJECT_SERVER);

    // A value outside the dropdown's options is ignored.
    await placement?.dropdown?.onChangeHandler("sideways");
    expect(plugin.settings.refPlacement).toBe("inline");

    await server?.text?.onChangeHandler("wss://a.example/ws");
    expect(host.stored).toEqual({
      refPlacement: "inline",
      defaultServer: "wss://a.example/ws",
      showSharingMetadata: false,
      settingsVersion: 2,
    });

    // Cleared, it stays cleared after a reload.
    await server?.text?.onChangeHandler("");
    const reloaded = await loaded(host.stored);
    expect(reloaded.plugin.settings.defaultServer).toBe("");

    // Redisplaying does not duplicate controls.
    const count = tab.containerEl.settings.length;
    tab.display();
    expect(tab.containerEl.settings).toHaveLength(count);
  });
});
