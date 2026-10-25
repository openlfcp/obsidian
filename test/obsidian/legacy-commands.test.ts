// UX-01 (UXD-2): the palette lists the 0.1 task commands only on a vault
// that holds a 0.1 collaboration; "Legacy: Join task collaboration" is
// always there, as the way into an older collaboration.

import "fake-indexeddb/auto";
import { PROFILE_ID as TASKS_PROFILE_ID } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../src/core/commands";
import type { RuntimeEnv } from "../../src/core/lfcp/runtime";
import { obsidianRuntimeEnv } from "../../src/obsidian/lfcp-env";
import OpenLfcpPlugin from "../../src/obsidian/plugin";
import * as mock from "../mocks/obsidian";
import { storeForeign } from "../support/foreign-resource";
import { Device } from "../support/lfcp-env";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };
const plugins: OpenLfcpPlugin[] = [];

class TestPlugin extends OpenLfcpPlugin {
  constructor(app: never, device: Device) {
    super(app, manifest as never);
    this.device = device;
  }
  device: Device;
  protected override runtimeEnv(): RuntimeEnv {
    return {
      ...obsidianRuntimeEnv(this.app),
      timers: this.device.timers,
      webSocket: this.device.sockets.factory,
      acquireLock: (name) => this.device.acquireLock(name),
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of plugins.splice(0)) await p.stopRuntime();
});

async function load(device = new Device(), app = new mock.App()) {
  const plugin = new TestPlugin(app as never, device);
  plugins.push(plugin);
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  const names = new Map((plugin as unknown as mock.Plugin).commands.map((c) => [c.id, c.name]));
  return { plugin, device, app, names };
}

const LEGACY = COMMANDS.filter((c) => c.legacy !== undefined);

describe("the 0.1 commands (UX-01)", () => {
  it("a vault with no 0.1 collaboration has only the join, named Legacy", async () => {
    const { names } = await load();
    expect(LEGACY.filter((c) => names.has(c.id)).map((c) => [c.id, names.get(c.id)])).toEqual([
      ["join-collaboration", "Legacy: Join task collaboration"],
    ]);
    // The commands that are not 0.1 commands are all there, with their names.
    for (const c of COMMANDS.filter((x) => x.legacy === undefined))
      expect(names.get(c.id)).toBe(c.name);
  });

  it("a vault with a 0.1 collaboration has every 0.1 command, each named Legacy: …", async () => {
    const first = await load();
    await storeForeign(first.plugin.runtime as never, TASKS_PROFILE_ID, "Team");
    await first.plugin.stopRuntime();
    const { names } = await load(first.device, first.app);
    for (const c of LEGACY) {
      expect(names.get(c.id), c.id).toBe(c.name);
      expect(c.name.startsWith("Legacy: ")).toBe(true);
    }
  });

  it("a vault with only a shared section (another profile) has no 0.1 command but the join", async () => {
    const first = await load();
    await storeForeign(first.plugin.runtime as never, undefined, "Launch");
    await first.plugin.stopRuntime();
    const { names } = await load(first.device, first.app);
    expect(LEGACY.filter((c) => names.has(c.id)).map((c) => c.id)).toEqual(["join-collaboration"]);
  });
});
