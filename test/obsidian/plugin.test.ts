// The adapter layer against the `obsidian` mock (test/mocks/obsidian.ts):
// what Obsidian would see when it enables the plugin.

import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/core/commands";
import OpenLfcpPlugin from "../../src/main";
import * as mock from "../mocks/obsidian";

const manifest = { id: "openlfcp", name: "OpenLFCP", version: "0.0.0" };

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

  it("registers every command as a stub that shows a notice", async () => {
    const { host } = await loaded();
    expect(host.commands.map((c) => [c.id, c.name])).toEqual(COMMANDS.map((c) => [c.id, c.name]));
    for (const command of host.commands) command.callback?.();
    expect(mock.notices).toHaveLength(COMMANDS.length);
    for (const notice of mock.notices) expect(notice).toMatch(/is not implemented yet\.$/);
  });

  it("loads stored settings and normalizes them", async () => {
    const { plugin } = await loaded({ refPlacement: "inline", defaultServer: 7 });
    expect(plugin.settings).toEqual({ refPlacement: "inline", defaultServer: "" });
  });

  it("reloads settings changed outside the plugin", async () => {
    const { plugin, host } = await loaded();
    host.stored = { refPlacement: "inline" };
    await plugin.onExternalSettingsChange();
    expect(plugin.settings.refPlacement).toBe("inline");
  });

  it("settings tab edits and saves the placeholders", async () => {
    const { plugin, host } = await loaded();
    expect(host.settingTabs).toHaveLength(1);
    const tab = host.settingTabs[0] as mock.PluginSettingTab;
    tab.display();
    const [placement, server] = tab.containerEl.settings;
    expect(placement?.name).toBe("Ref placement");
    expect([...(placement?.dropdown?.options.keys() ?? [])]).toEqual(["child-line", "inline"]);
    expect(placement?.dropdown?.value).toBe("child-line");

    await placement?.dropdown?.onChangeHandler("inline");
    expect(plugin.settings.refPlacement).toBe("inline");
    expect(host.stored).toEqual({ refPlacement: "inline", defaultServer: "" });

    // A value outside the dropdown's options is ignored.
    await placement?.dropdown?.onChangeHandler("sideways");
    expect(plugin.settings.refPlacement).toBe("inline");

    await server?.text?.onChangeHandler("wss://a.example/ws");
    expect(host.stored).toEqual({ refPlacement: "inline", defaultServer: "wss://a.example/ws" });

    // Redisplaying does not duplicate controls.
    tab.display();
    expect(tab.containerEl.settings).toHaveLength(2);
  });
});
