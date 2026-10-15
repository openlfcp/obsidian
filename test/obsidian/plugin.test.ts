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
      sectionComments: "local",
      sectionsDisabled: true,
      developerPanePrototype: false,
      dismissedHints: [],
      settingsVersion: 2,
    });
  });

  it("registers the pane prototype and its command only with the developer flag (LFCP-03-007)", async () => {
    const off = await loaded();
    // The production pane (LFCP-03-012) only.
    expect([...off.host.views.keys()]).toEqual(["shared-tasks-pane"]);
    expect(off.host.commands.map((c) => c.id)).not.toContain("open-pane-prototype");
    const on = await loaded({ developerPanePrototype: true });
    expect([...on.host.views.keys()]).toEqual(["shared-tasks-pane-prototype", "shared-tasks-pane"]);
    expect(on.host.commands.map((c) => c.id)).toContain("open-pane-prototype");
  });

  it("connects at once when the network comes back, or the app is shown or focused again", async () => {
    const { plugin, host } = await loaded();
    let calls = 0;
    let lost = 0;
    plugin.runtime = { networkBack: () => calls++, networkLost: () => lost++ } as never;
    const fire = (type: string) => {
      for (const d of host.domEvents) if (d.type === type) d.callback({});
    };
    fire("online");
    expect(calls).toBe(1);
    fire("offline");
    expect(lost).toBe(1);
    const g = globalThis as Record<string, unknown>;
    const had = g.document;
    try {
      g.document = { visibilityState: "hidden" };
      fire("visibilitychange");
      expect(calls).toBe(1);
      g.document = { visibilityState: "visible" };
      fire("visibilitychange");
      expect(calls).toBe(2);
    } finally {
      g.document = had;
    }
    // Back to Obsidian's window (soak finding #8): no wait for the backoff.
    fire("focus");
    expect(calls).toBe(3);
    plugin.runtime = null;
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
      ["Comments in shared sections", "dropdown", "sectionComments"],
      ["Default server", "text", "defaultServer"],
    ]);
  });

  it("LFCP-03-021: the tips row shows how many are hidden and brings them back", async () => {
    const stored = { refPlacement: "inline", dismissedHints: ["first-use", "a-tip-of-0-6"] };
    const { plugin, host } = await loaded(stored);
    const tab = host.settingTabs[0] as mock.PluginSettingTab;
    tab.display();
    const tips = () =>
      tab.containerEl.settings.find((x) => x.name === "Tips in the Shared Tasks pane");
    expect(tips()?.desc).toContain("1 tip is hidden in this vault");
    expect(tips()?.button?.text).toBe("Show tips again");
    expect(tips()?.button?.disabled).toBe(false);
    await tips()?.button?.onClickHandler();
    expect(plugin.settings.dismissedHints).toEqual([]);
    // Only the hidden tips changed in data.json.
    expect(host.stored).toEqual({ ...plugin.settings, refPlacement: "inline", dismissedHints: [] });
    expect(tips()?.button?.disabled).toBe(true);
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
      sectionComments: "local",
      sectionsDisabled: true,
      developerPanePrototype: false,
      dismissedHints: [],
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
      sectionComments: "local",
      sectionsDisabled: true,
      developerPanePrototype: false,
      dismissedHints: [],
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
