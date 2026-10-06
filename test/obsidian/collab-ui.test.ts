// LFCP-065 through the plugin: the registered commands, their Obsidian
// dialogs (against the `obsidian` mock) and what the user can see, over a
// real runtime on an offline device.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../src/core/commands";
import type { RuntimeEnv } from "../../src/core/lfcp/runtime";
import { scanRefs } from "../../src/core/refs";
import { obsidianRuntimeEnv } from "../../src/obsidian/lfcp-env";
import OpenLfcpPlugin from "../../src/obsidian/plugin";
import { ObsidianNotes, ObsidianPrompter } from "../../src/obsidian/ui/prompter";
import * as mock from "../mocks/obsidian";
import { Device } from "../support/lfcp-env";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };
const SERVER = "wss://offline.example.invalid/v1/ws";
const plugins: OpenLfcpPlugin[] = [];
const copied: string[] = [];

class TestPlugin extends OpenLfcpPlugin {
  device = new Device();
  protected override runtimeEnv(): RuntimeEnv {
    return {
      ...obsidianRuntimeEnv(this.app),
      timers: this.device.timers,
      webSocket: this.device.sockets.factory,
      acquireLock: (name) => this.device.acquireLock(name),
    };
  }
  protected override createPrompter() {
    return new ObsidianPrompter(this.app, async (text) => {
      copied.push(text);
    });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of plugins.splice(0)) await p.stopRuntime();
  mock.modals.length = 0;
  mock.notices.length = 0;
  copied.length = 0;
});

async function load() {
  const app = new mock.App();
  const plugin = new TestPlugin(app as never, manifest as never);
  plugins.push(plugin);
  const host = plugin as unknown as mock.Plugin;
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  return { plugin, host, app };
}

const run = (host: mock.Plugin, id: string) => {
  const command = host.commands.find((c) => c.id === id);
  if (command?.callback === undefined) throw new Error(`no command ${id}`);
  command.callback();
};

/** The next modal the plugin opens. */
async function next<T extends mock.Modal>(seen: number): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const m = mock.modals[seen];
    if (m !== undefined) return m as T;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no modal opened");
}

const input = (m: mock.Modal) => m.contentEl.findAll("input")[0] as mock.FakeElement;
const button = (m: mock.Modal, text: string) => {
  const b = m.contentEl.findAll("button").find((x) => x.text === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const answer = async (seen: number, value: string) => {
  const m = await next(seen);
  input(m).value = value;
  button(m, "OK").click();
};
const pick = async (seen: number, label: string) =>
  (await next<mock.SuggestModal<unknown>>(seen)).pick((t) => t.startsWith(label));

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

async function createTeam(host: mock.Plugin) {
  const seen = mock.modals.length;
  run(host, "create-collaboration");
  await answer(seen, "Team");
  const server = await next(seen + 1);
  // The default server is offered, and explained as not being an identity.
  expect(server.contentEl.textContent).toContain("It is not your identity");
  input(server).value = SERVER;
  button(server, "OK").click();
  await settle(() => mock.notices.some((n) => n.includes('"Team" created')));
}

describe("LFCP-065 in the plugin", () => {
  it("reads the editor selection as whole lines (POST-018)", () => {
    const app = new mock.App();
    const view = new mock.MarkdownView({ path: "a.md" } as never, "- [ ] A\n- [ ] B\n- [ ] C\n");
    app.workspace.activeView = view;
    const notes = new ObsidianNotes(app as never);
    view.cursorLine = 1;
    expect(notes.active()?.selection).toBeUndefined();
    view.selection = { from: { line: 0, ch: 3 }, to: { line: 1, ch: 2 } };
    expect(notes.active()?.selection).toEqual({ from: 0, to: 1 });
    // Ending at the start of a line does not take that line.
    view.selection = { from: { line: 0, ch: 0 }, to: { line: 2, ch: 0 } };
    expect(notes.active()?.selection).toEqual({ from: 0, to: 1 });
  });

  it("offers the project server with its notice, updated as the server is edited", async () => {
    const { host } = await load();
    const seen = mock.modals.length;
    run(host, "create-collaboration");
    await answer(seen, "Team");
    const server = await next(seen + 1);
    expect(input(server).value).toBe("wss://sync.openlfcp.org/v1/ws");
    const links = () => server.contentEl.findAll("a").map((a) => [a.text, a.href]);
    expect(server.contentEl.textContent).toContain(
      "Hosted by the OpenLFCP project (beta). The server sees metadata, not your tasks.",
    );
    expect(links()).toEqual([
      [
        "Privacy note",
        "https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md",
      ],
      [
        "Terms",
        "https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md",
      ],
    ]);
    // Another server: no notice; back to the project server: shown again.
    input(server).value = SERVER;
    input(server).trigger("input");
    expect(server.contentEl.textContent).not.toContain("Hosted by the OpenLFCP project");
    expect(links()).toEqual([]);
    input(server).value = "wss://sync.openlfcp.org/v1/ws";
    input(server).trigger("input");
    expect(links()).toHaveLength(2);
    // Not a modal of its own, and nothing to click: OK goes on as before.
    expect(mock.modals).toHaveLength(seen + 2);
    input(server).value = SERVER;
    button(server, "OK").click();
    await settle(() => mock.notices.some((n) => n.includes('"Team" created')));
    expect(mock.notices.join("\n")).not.toContain("Hosted by");
  });

  it("registers a handler for every product command", async () => {
    const { host } = await load();
    expect(
      host.commands.filter((c) => COMMANDS.some((x) => x.id === c.id)).map((c) => c.name),
    ).toEqual(COMMANDS.map((c) => c.name));
  });

  it("shares the task under the cursor into the note, child-line by default", async () => {
    const { host, app } = await load();
    await createTeam(host);
    const file = { path: "plan.md" };
    app.vault.files.set(file.path, "- [ ] Prepare API contract\n");
    const view = new mock.MarkdownView(file, "- [ ] Prepare API contract\n");
    app.workspace.activeView = view;
    const seen = mock.modals.length;
    run(host, "share-task-under-cursor");
    await pick(seen, "Team");
    await settle(() => mock.notices.includes("Shared Tasks: task shared."));
    const text = app.vault.files.get(file.path) as string;
    expect(scanRefs(text).projections.map((p) => p.placement)).toEqual(["child"]);
    expect(view.saves).toBe(1);
  });

  it("invitation dialog: copy and show on request only; nothing in notices or data.json", async () => {
    const { plugin, host } = await load();
    await createTeam(host);
    const seen = mock.modals.length;
    run(host, "invite-collaborator");
    await pick(seen, "Team");
    await pick(seen + 1, "Read + write");
    const dialog = await next(seen + 2);
    const shown = input(dialog);
    expect(shown.type).toBe("password");
    expect(dialog.contentEl.textContent).not.toContain("lfcp://join");
    button(dialog, "Copy link").click();
    await settle(() => copied.length === 1);
    const link = copied[0] as string;
    expect(link.startsWith("lfcp://join/")).toBe(true);
    button(dialog, "Show link").click();
    expect(shown.value).toBe(link);
    expect(shown.type).toBe("text");
    button(dialog, "Done").click();
    await plugin.saveSettings();
    const secret = link.slice(link.indexOf("#secret=") + 8);
    expect(JSON.stringify(host.stored)).not.toContain(secret);
    for (const n of mock.notices) expect(n).not.toContain(secret);
  });

  it("join dialog masks the link", async () => {
    const { host } = await load();
    const seen = mock.modals.length;
    run(host, "join-collaboration");
    const dialog = await next(seen);
    expect(input(dialog).type).toBe("password");
    button(dialog, "Cancel").click();
  });

  it("status view shows non-secret fields only, and a blocking control conflict explicitly", async () => {
    const { plugin, host } = await load();
    await createTeam(host);
    const runtime = plugin.runtime;
    if (runtime === null) throw new Error("no runtime");
    const seen = mock.modals.length;
    run(host, "resource-status");
    await pick(seen, "Team");
    const view = await next(seen + 1);
    const text = view.contentEl.textContent;
    expect(text).toContain("Resource ID");
    expect(text).toContain("Server (relays only; not your identity, not the owner)");
    expect(text).toContain("Not hosted yet");
    const secrets = [
      ...(plugin.app.secretStorage as unknown as mock.SecretStorage).values.values(),
    ].filter((v) => v.length >= 16);
    expect(secrets.length).toBeGreaterThan(2);
    for (const s of secrets) expect(text).not.toContain(s);
    button(view, "Close").click();

    vi.spyOn(runtime, "registry").mockResolvedValue(
      (await runtime.registry()).map((e) => ({ ...e, state: "control_conflict" as const })),
    );
    const seen2 = mock.modals.length;
    run(host, "resource-status");
    await pick(seen2, "Team");
    const blocked = await next(seen2 + 1);
    const banner = blocked.contentEl.findAll("div").find((d) => d.cls === "openlfcp-blocked");
    expect(banner?.text).toMatch(/NOT in sync/);
  });
});
