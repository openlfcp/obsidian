// @vitest-environment happy-dom
// LFCP-03-023 (U03-07, F-C08): the palette side of the action seam, on the
// real plugin and the recording Obsidian mock. Every palette command that
// is an action of the UX contract (§3) is registered under its unchanged ID
// and name, and runs that action through the one dispatcher, surface
// "palette", on the note of the editor it was given. The contract's table,
// the dispatcher's map and the registered commands are the same list.
// Every dialog an action opens, from any surface, is opened through
// returnsFocus (LFCP-03-022, U03-18): Tab kept in it, focus given back.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionId } from "../../src/core/actions/catalog";
import { PALETTE_COMMAND } from "../../src/core/actions/dispatcher";
import OpenLfcpPlugin from "../../src/main";
import * as mock from "../mocks/obsidian";

const manifest = { id: "shared-tasks", name: "Shared Tasks", version: "0.0.0" };
const ROOT = join(__dirname, "..", "..");

/** The §3 table of the UX contract: action ID → palette command ID and name ("—": none). */
function contractTable(): Map<ActionId, { id: string; name: string } | null> {
  const doc = readFileSync(join(ROOT, "docs/architecture/ux-contract-0.3.md"), "utf8");
  const section = doc.slice(doc.indexOf("## 3. Actions and labels"), doc.indexOf("## 4."));
  const out = new Map<ActionId, { id: string; name: string } | null>();
  for (const line of section.split("\n")) {
    const m = /^\| `([a-z-]+)` \| [^|]+ \| ([^|]+) \|/.exec(line);
    if (m === null) continue;
    const cmd = /^`([a-z-]+)` "(.+)"\s*$/.exec((m[2] ?? "").trim());
    out.set(m[1] as ActionId, cmd === null ? null : { id: cmd[1] ?? "", name: cmd[2] ?? "" });
  }
  return out;
}

const opened: OpenLfcpPlugin[] = [];

// Obsidian's DOM helper the plugin's live region uses (happy-dom has none).
const P = HTMLElement.prototype as unknown as Record<string, unknown>;
const hadCreateDiv = "createDiv" in P;
beforeAll(() => {
  P.createDiv ??= function (this: HTMLElement, o: { attr?: Record<string, string> } = {}) {
    const el = this.ownerDocument.createElement("div");
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
});
afterAll(() => {
  if (!hadCreateDiv) delete P.createDiv;
});

// What the mock Plugin lacks for a sections host (as stable-target.test.ts gives it).
const PLUGIN = mock.Plugin.prototype as unknown as Record<string, unknown>;
const STUBS: Record<string, unknown> = {
  register: () => undefined,
  registerInterval: (id: number) => {
    window.clearInterval(id);
    return id;
  },
  registerMarkdownPostProcessor: () => undefined,
};
const saved = new Map<string, unknown>();
beforeAll(() => {
  for (const [k, v] of Object.entries(STUBS)) {
    saved.set(k, PLUGIN[k]);
    PLUGIN[k] ??= v;
  }
});
afterAll(() => {
  for (const [k, v] of saved)
    if (v === undefined) delete PLUGIN[k];
    else PLUGIN[k] = v;
});

/** The plugin with shared sections on (the mock's default is off), its runtime started or failed. */
async function loaded() {
  const app = new mock.App();
  const plugin = new OpenLfcpPlugin(app as never, manifest as never);
  (plugin as unknown as mock.Plugin).stored = { sectionsDisabled: false, settingsVersion: 2 };
  opened.push(plugin);
  await plugin.onload();
  await plugin.whenRuntimeStarted();
  return { app, plugin };
}

afterEach(() => {
  for (const p of opened.splice(0)) (p as unknown as mock.Plugin).unload();
  vi.restoreAllMocks();
  mock.notices.length = 0;
});

describe("the palette's actions (LFCP-03-023, U03-07)", () => {
  it("the contract's table, the dispatcher's map and the registered commands agree", async () => {
    const table = contractTable();
    expect(table.size).toBeGreaterThan(15);
    const fromTable = Object.fromEntries(
      [...table].flatMap(([action, cmd]) => (cmd === null ? [] : [[action, cmd.id]])),
    );
    expect(fromTable).toEqual(PALETTE_COMMAND);
    const { plugin } = await loaded();
    const commands = (plugin as unknown as { commands: { id: string; name: string }[] }).commands;
    for (const [action, cmd] of table) {
      if (cmd === null) continue;
      const registered = commands.find((c) => c.id === cmd.id);
      expect(registered?.name, `${action} → ${cmd.id}`).toBe(cmd.name);
    }
  });

  it("each runs its action through the one dispatcher, surface palette, on the editor's note", async () => {
    const { plugin } = await loaded();
    const run = vi.spyOn(plugin.actions, "run").mockResolvedValue();
    const view = new mock.MarkdownView(new mock.TFile("Plan.md"), "# Plan\n\nPrivate.\n");
    const commands = (
      plugin as unknown as {
        commands: {
          id: string;
          callback?: () => unknown;
          editorCallback?: (editor: unknown, ctx: unknown) => unknown;
        }[];
      }
    ).commands;
    for (const [action, id] of Object.entries(PALETTE_COMMAND)) {
      const command = commands.find((c) => c.id === id);
      expect(command, id).toBeDefined();
      run.mockClear();
      if (command?.editorCallback !== undefined) command.editorCallback(view.editor, view);
      else command?.callback?.();
      expect(run, id).toHaveBeenCalledTimes(1);
      const [got, request, surface] = run.mock.calls[0] ?? [];
      expect([got, surface ?? "palette"], id).toEqual([action, "palette"]);
      // An editor command hands the note it was run on, never a live editor.
      if (command?.editorCallback !== undefined)
        expect(request, id).toMatchObject({ target: { path: "Plan.md", text: view.buffer } });
    }
  });
});

/** The plugin's source files, by path from the repository. */
function sources(dir = "src"): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(`${dir}/${e.name}`)
      : e.name.endsWith(".ts")
        ? [`${dir}/${e.name}`]
        : [],
  );
}

describe("the dialogs of the actions (LFCP-03-023 over LFCP-03-022, U03-18)", () => {
  it("every dialog the plugin opens goes through returnsFocus: Tab kept in it, focus given back", () => {
    const files = sources().map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const);
    const modals = files.flatMap(([, src]) =>
      [...src.matchAll(/class (\w+)(?:<[^>]*>)? extends (?:Suggest)?Modal\b/g)].map(
        (m) => m[1] ?? "",
      ),
    );
    expect(modals.length).toBeGreaterThan(12);
    const bare: string[] = [];
    const made = new Set<string>();
    for (const [file, src] of files)
      for (const name of modals)
        for (const line of src.split("\n").filter((l) => l.includes(`new ${name}(`))) {
          made.add(name);
          if (new RegExp(`(?:returnsFocus|opened)\\(new ${name}\\(`).test(line)) continue;
          const v = new RegExp(`(?:const|let) (\\w+) = new ${name}\\(`).exec(line)?.[1];
          if (v !== undefined && src.includes(`returnsFocus(${v})`)) continue;
          bare.push(`${file}: ${line.trim()}`);
        }
    expect(bare).toEqual([]);
    // Every dialog class is opened somewhere, so none escapes the check by being made elsewhere.
    expect(modals.filter((m) => !made.has(m))).toEqual([]);
    // The section prompter's helper wraps what it opens.
    const prompter = readFileSync(join(ROOT, "src/obsidian/ui/section-prompter.ts"), "utf8");
    const opened = /function opened<T>[\s\S]*?\n\}\n/.exec(prompter)?.[0] ?? "";
    expect(opened).toContain("returnsFocus(modal).open()");
  });
});
