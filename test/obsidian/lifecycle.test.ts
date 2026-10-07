// The plugin lifecycle with the LFCP runtime (LFCP-059), against the
// `obsidian` mock: Obsidian's secretStorage and vault-scoped localStorage
// are the mock's, IndexedDB is fake-indexeddb, the network is offline.

import "fake-indexeddb/auto";
import { toBase64url, toHex } from "@openlfcp/core";
import {
  complete,
  createTask,
  SharedObjectsReplica,
  setDue,
  type Task,
} from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../../src/core/lfcp/runtime";
import type { VaultChange } from "../../src/core/vault/changes";
import { obsidianRuntimeEnv } from "../../src/obsidian/lfcp-env";
import OpenLfcpPlugin from "../../src/obsidian/plugin";
import * as mock from "../mocks/obsidian";
import { collaborator, storeBlocked } from "../support/blocked-units";
import { Device } from "../support/lfcp-env";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };

class TestPlugin extends OpenLfcpPlugin {
  device = new Device();
  protected override runtimeEnv(): RuntimeEnv {
    // The real Obsidian mapping, with counted timers and an offline socket.
    return {
      ...obsidianRuntimeEnv(this.app),
      timers: this.device.timers,
      webSocket: this.device.sockets.factory,
      acquireLock: (name) => this.device.acquireLock(name),
    };
  }
}

async function load(app = new mock.App(), stored?: unknown) {
  const plugin = new TestPlugin(app as never, manifest as never);
  const host = plugin as unknown as mock.Plugin;
  host.stored = stored;
  await plugin.onload();
  return { plugin, host, app };
}

const ready = async (plugin: OpenLfcpPlugin) => {
  const r = await plugin.whenRuntimeStarted();
  if (r === null || r.status.kind !== "ready") throw new Error(plugin.runtimeError ?? "not ready");
  return r.status;
};

describe("plugin lifecycle (LFCP-059)", () => {
  it("starts the runtime on load without waiting for it, and stops everything on unload (test 6)", async () => {
    const { plugin, host, app } = await load();
    const status = await ready(plugin);
    expect(status.kind).toBe("ready");
    expect(plugin.runtime).not.toBeNull();
    expect(app.vault.handlers.length).toBe(4);
    host.unload();
    await plugin.stopRuntime();
    expect(plugin.runtime).toBeNull();
    expect(plugin.device.timers.active.size).toBe(0);
    expect(app.vault.handlers.length).toBe(0);
  });

  it("stops a runtime that finishes starting after unload", async () => {
    const { plugin, host } = await load();
    host.unload(); // before the background start resolved
    expect(await plugin.whenRuntimeStarted()).toBeNull();
    expect(plugin.runtime).toBeNull();
    expect(plugin.device.timers.active.size).toBe(0);
  });

  it("keeps the identity across plugin reloads, and none of it in data.json (tests 2, 3, 11)", async () => {
    const app = new mock.App();
    const first = await load(app);
    const id = toHex((await ready(first.plugin)).principalId);
    // Default server: a setting of its own, unrelated to the identity.
    first.plugin.settings.defaultServer = "wss://sync.example/v1/ws";
    await first.plugin.saveSettings();
    first.host.unload();
    await first.plugin.stopRuntime();

    const stored = first.host.stored;
    expect(stored).toEqual({
      refPlacement: "child-line",
      defaultServer: "wss://sync.example/v1/ws",
      settingsVersion: 2,
    });
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(id);
    for (const secret of app.secretStorage.values.values())
      if (secret.startsWith("v1:")) expect(dump).not.toContain(secret.slice(3));

    const second = await load(app, stored);
    expect(toHex((await ready(second.plugin)).principalId)).toBe(id);
    expect(second.plugin.settings.defaultServer).toBe("wss://sync.example/v1/ws");
    second.host.unload();
    await second.plugin.stopRuntime();
  });

  it("gives another vault on the same device its own identity", async () => {
    const a = await load(new mock.App());
    const other = new mock.App();
    other.secretStorage = a.app.secretStorage; // device-level, shared by vaults
    const b = await load(other);
    expect(toHex((await ready(b.plugin)).principalId)).not.toBe(
      toHex((await ready(a.plugin)).principalId),
    );
    for (const p of [a, b]) {
      p.host.unload();
      await p.plugin.stopRuntime();
    }
  });

  it("forwards vault-level Markdown changes, whatever made them (test 12)", async () => {
    const { plugin, host, app } = await load();
    const seen: (readonly VaultChange[])[] = [];
    plugin.changes.subscribe((b) => seen.push(b));
    app.vault.trigger("modify", { path: "Projects/Alpha.md" });
    app.vault.trigger("create", { path: "image.png" }); // not Markdown
    app.vault.trigger("rename", { path: "Archive/Alpha.md" }, "Projects/Alpha.md");
    app.vault.trigger("delete", { path: "Old.md" });
    plugin.changes.flush();
    expect(seen).toEqual([
      [
        { kind: "modify", path: "Projects/Alpha.md" },
        { kind: "rename", path: "Archive/Alpha.md", oldPath: "Projects/Alpha.md" },
        { kind: "delete", path: "Old.md" },
      ],
    ]);
    host.unload();
    app.vault.trigger("modify", { path: "After.md" });
    plugin.changes.flush();
    expect(seen).toHaveLength(1);
    await plugin.stopRuntime();
  });

  it("settings show the identity state without the Principal or keys", async () => {
    const { plugin, host } = await load();
    const status = await ready(plugin);
    const tab = host.settingTabs[0] as mock.PluginSettingTab;
    tab.display();
    const identity = tab.containerEl.settings.find((s) => s.name === "Identity on this device");
    expect(identity?.desc).toMatch(/^Ready\./);
    expect(identity?.desc).not.toContain(toHex(status.principalId));
    host.unload();
    await plugin.stopRuntime();
  });

  it("projects vault edits of bound Tasks into the shared object, and offers the ST-2 repair (LFCP-061)", async () => {
    const { plugin, host, app } = await load();
    await ready(plugin);
    const runtime = plugin.runtime as NonNullable<typeof plugin.runtime>;
    const url = "wss://offline.example.invalid/v1/ws";
    const R = await runtime.createResource({ name: "P", endpoints: [url], coordinatorUrl: url });
    const status = runtime.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const id = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
    await runtime.writeIntent(
      R,
      createTask({ id: id as never, title: "Plan", createdBy: status.principalId }).intent,
    );
    const ref = `lfcp1:${toBase64url(R)}#task:${id}`;
    const edit = async (text: string) => {
      app.vault.files.set("n.md", text);
      app.vault.trigger("modify", { path: "n.md" });
      plugin.changes.flush();
      await plugin.lastProjection;
    };
    mock.notices.length = 0;
    await edit(`- [x] Plan with [[Secret]]\n  <!-- lfcp-ref: ${ref} -->\n`);
    const task = () => runtime.profileOf(R).then((p) => p.replica.task(id)?.task);
    expect(await task()).toMatchObject({ title: "Plan with [[Secret]]", status: "done" });
    expect(mock.notices.filter((n) => n.includes("links to notes"))).toHaveLength(1);
    await edit(`- [x] Plan with [[Secret]]\n  <!-- lfcp-ref: ${ref} -->\n\nMore text.\n`);
    expect(mock.notices.filter((n) => n.includes("links to notes"))).toHaveLength(1); // once

    // Enter after the Task: a new Task slides between it and its ref.
    await edit(`- [x] Plan with [[Secret]]\n- [ ] \n  <!-- lfcp-ref: ${ref} -->\n`);
    expect(await task()).toMatchObject({ title: "Plan with [[Secret]]", status: "done" });
    expect(mock.notices.some((n) => n.includes("Repair moved shared task ref"))).toBe(true);
    app.workspace.active = { path: "n.md" };
    await plugin.repairActiveNote();
    plugin.changes.flush();
    await plugin.lastProjection;
    expect(app.vault.files.get("n.md")).toBe(
      `- [x] Plan with [[Secret]]\n  <!-- lfcp-ref: ${ref} -->\n- [ ] \n`,
    );
    expect(await task()).toMatchObject({ title: "Plan with [[Secret]]", status: "done" });

    // The plugin's own write is not projected back.
    const own = `- [ ] Plan\n  <!-- lfcp-ref: ${ref} -->\n`;
    plugin.guard.expect("n.md", own);
    await edit(own);
    expect(await task()).toMatchObject({ title: "Plan with [[Secret]]", status: "done" });
    host.unload();
    await plugin.stopRuntime();
  });

  describe("Shared Object → Markdown in the plugin (LFCP-062)", () => {
    const url = "wss://offline.example.invalid/v1/ws";
    const id = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
    const settle = async (plugin: OpenLfcpPlugin) => {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        await plugin.lastProjection;
      }
    };
    async function withTask(app = new mock.App()) {
      const loaded = await load(app);
      await ready(loaded.plugin);
      const runtime = loaded.plugin.runtime as NonNullable<typeof loaded.plugin.runtime>;
      const R = await runtime.createResource({ name: "P", endpoints: [url], coordinatorUrl: url });
      const status = runtime.status;
      if (status.kind !== "ready") throw new Error("not ready");
      await runtime.writeIntent(
        R,
        createTask({ id: id as never, title: "Plan", createdBy: status.principalId }).intent,
      );
      const ref = `lfcp1:${toBase64url(R)}#task:${id}`;
      const unit = (g: string) => `- [${g}] Plan\n  <!-- lfcp-ref: ${ref} -->\n`;
      app.vault.files.set("n.md", `# Private\n\n${unit(" ")}\nTail.`);
      app.vault.trigger("create", { path: "n.md" });
      loaded.plugin.changes.flush();
      await settle(loaded.plugin);
      const task = async () => (await runtime.profileOf(R)).replica.task(id)?.task as never;
      return { ...loaded, runtime, R, ref, unit, task };
    }

    it("re-renders notes when the shared object changes, through the guard", async () => {
      const { plugin, host, app, runtime, R, unit, task } = await withTask();
      await runtime.writeIntent(R, complete(await task()).intent);
      await settle(plugin);
      expect(app.vault.files.get("n.md")).toBe(`# Private\n\n${unit("x")}\nTail.`);
      // The write's own vault event is skipped; nothing goes back.
      app.vault.trigger("modify", { path: "n.md" });
      plugin.changes.flush();
      await settle(plugin);
      expect(((await task()) as { status: string }).status).toBe("done");
      host.unload();
      await plugin.stopRuntime();
    });

    it("defers a note open with unsaved changes, and reconciles it at the next start", async () => {
      const app = new mock.App();
      const first = await withTask(app);
      app.workspace.views.push(new mock.MarkdownView({ path: "n.md" }, "unsaved typing"));
      await first.runtime.writeIntent(first.R, complete(await first.task()).intent);
      await settle(first.plugin);
      expect(app.vault.files.get("n.md")).toBe(`# Private\n\n${first.unit(" ")}\nTail.`);
      expect(first.plugin.writer.deferred.has("n.md")).toBe(true);
      first.host.unload();
      await first.plugin.stopRuntime();
      app.workspace.views.length = 0; // closed without saving the typing
      // Next start: the note is stale (it still shows [ ] as at its last sync), so the
      // shared completion is rendered, not reverted.
      const second = await load(app);
      await ready(second.plugin);
      await settle(second.plugin);
      expect(app.vault.files.get("n.md")).toBe(`# Private\n\n${first.unit("x")}\nTail.`);
      const runtime = second.plugin.runtime as NonNullable<typeof second.plugin.runtime>;
      expect((await runtime.profileOf(first.R)).replica.task(id)?.task?.status).toBe("done");
      second.host.unload();
      await second.plugin.stopRuntime();
    });

    it("looks at every note through the content cache at start, reads only ref notes in full", async () => {
      const app = new mock.App();
      const first = await withTask(app);
      app.vault.files.set("plain.md", "# Just notes\n\n- [ ] a local task\n");
      app.vault.files.set("other.md", "Nothing shared here.\n");
      first.host.unload();
      await first.plugin.stopRuntime();
      app.vault.reads.length = 0;
      app.vault.cachedReads.length = 0;
      const second = await load(app);
      await ready(second.plugin);
      await settle(second.plugin);
      expect([...app.vault.cachedReads].sort()).toEqual(["n.md", "other.md", "plain.md"]);
      expect(app.vault.reads.filter((p) => p !== "n.md")).toEqual([]);
      expect(app.vault.reads).toContain("n.md");
      second.host.unload();
      await second.plugin.stopRuntime();
    });

    it("shows conflicts in the status bar and an editor decoration, never in the note", async () => {
      const { plugin, host, app, runtime, R } = await withTask();
      const profile = await runtime.profileOf(R);
      const other = SharedObjectsReplica.fromChanges(profile.replica.changes(), {
        resource: R,
        principal: new Uint8Array(32).fill(9) as never,
      }).replica;
      const theirs = other.apply(setDue(other.task(id)?.task as Task, "2026-11-01").intent);
      await runtime.writeIntent(
        R,
        setDue(profile.replica.task(id)?.task as Task, "2026-11-02").intent,
      );
      profile.replica.receiveChange(theirs?.change as Uint8Array);
      app.vault.trigger("modify", { path: "n.md" });
      plugin.changes.flush();
      await settle(plugin);
      expect(host.statusBar[0]?.text).toBe("Shared Tasks: 1 shared task has a conflict");
      expect(plugin.conflicts.marks("n.md")).toMatchObject([{ fields: ["due"] }]);
      expect(host.editorExtensions).toHaveLength(1);
      expect(app.vault.files.get("n.md")).not.toMatch(/<{7}|={7}|>{7}|conflict/i);
      host.unload();
      await plugin.stopRuntime();
    });
  });

  it("an engine trap shows one restart notice and a lasting status bar; nothing repeats", async () => {
    const { plugin, host } = await load();
    const status = await ready(plugin);
    const runtime = plugin.runtime;
    if (runtime === null) throw new Error("no runtime");
    const R = await runtime.createResource({
      name: "Mine",
      endpoints: ["wss://offline.example.invalid/v1/ws"],
      coordinatorUrl: "wss://offline.example.invalid/v1/ws",
    });
    const profile = await runtime.profileOf(R);
    profile.replica.apply = () => {
      throw new WebAssembly.RuntimeError("unreachable executed"); // test hook: the engine traps
    };
    mock.notices.length = 0;
    const intent = createTask({ title: "Draft", createdBy: status.principalId }).intent;
    await expect(runtime.writeIntent(R, intent)).rejects.toThrow("needs an Obsidian restart");
    await expect(runtime.writeIntent(R, intent)).rejects.toThrow("needs an Obsidian restart");
    const restart = mock.notices.filter((n) => n.includes("Restart Obsidian"));
    expect(restart).toHaveLength(1);
    expect(host.statusBar[0]?.text).toBe("Shared Tasks: restart Obsidian");
    expect(plugin.needsRestart).not.toBeNull();
    expect(runtime.status.kind).toBe("needs-restart");
    host.unload();
    await plugin.stopRuntime();
  });

  it("notifies once per collaborator whose edits cannot be applied, also across reloads", async () => {
    const app = new mock.App();
    const first = await load(app);
    await ready(first.plugin);
    const runtime = first.plugin.runtime;
    if (runtime === null) throw new Error("no runtime");
    const R = await runtime.createResource({
      name: "Team",
      endpoints: ["wss://offline.example.invalid/v1/ws"],
      coordinatorUrl: "wss://offline.example.invalid/v1/ws",
    });
    await storeBlocked(runtime.storage as LfcpStorage, R, [
      { n: 1, who: 0x11, seq: 3n, status: "equivocation" },
      { n: 2, who: 0x11, seq: 3n, status: "equivocation" },
    ]);
    const blockedNotices = () =>
      mock.notices.filter((n) => n.includes("can't be applied") && n.includes('"Team"'));
    const settled = async (plugin: OpenLfcpPlugin) => {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 10));
        await plugin.blockedChecks;
      }
    };
    first.host.unload();
    await first.plugin.stopRuntime();
    mock.notices.length = 0;
    // The next start finds the equivocation: one notice.
    const second = await load(app, first.host.stored);
    await ready(second.plugin);
    await settled(second.plugin);
    expect(blockedNotices()).toEqual([
      `Shared Tasks: edits from ${toHex(collaborator(0x11)).slice(0, 8)} in "Team" can't be applied (ACTOR_EQUIVOCATION). See "Resource status".`,
    ]);
    second.host.unload();
    await second.plugin.stopRuntime();
    // Not again after another reload.
    const third = await load(app, second.host.stored);
    await ready(third.plugin);
    await settled(third.plugin);
    expect(blockedNotices()).toHaveLength(1);
    third.host.unload();
    await third.plugin.stopRuntime();
  });
});
