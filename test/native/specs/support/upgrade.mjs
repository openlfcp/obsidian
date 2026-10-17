// Shared by the install, upgrade and rollback specs (upgrade-install,
// upgrade-rollback): another version of the plugin written into a fresh
// test vault as an update writes it, then enabled. Not a spec itself (the
// harness runs specs/**/*.e2e.mjs only).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "../../wdio.conf.mjs";
import { inA } from "./section-checks.mjs";

const here = import.meta.dirname;
const ROOT = path.resolve(here, "../../../..");
const VAULT = path.resolve(here, "../../vaults/basic");
// The harness cache as the harness resolves it (OPENLFCP_OBSIDIAN_CACHE included).
const CACHE = path.join(cacheDir, "releases");

/** A version's three release files ("main": this checkout's build), or null when not cached. */
export function releaseFiles(version) {
  const dir = version === "main" ? ROOT : path.join(CACHE, version);
  const names = ["main.js", "manifest.json", "styles.css"];
  if (!names.every((n) => existsSync(path.join(dir, n)))) return null;
  return Object.fromEntries(names.map((n) => [n, readFileSync(path.join(dir, n), "utf8")]));
}

/** A fresh copy of the test vault: Shared Tasks installed (this build's files), not enabled, never run. */
export async function freshVault(server) {
  await browser.reloadObsidian({ vault: VAULT, plugins: [] });
  // The plugin's settings as a user leaves them: the test server as default server.
  await inA(
    async ({ app }, url) => {
      const dir = `${app.vault.configDir}/plugins/shared-tasks`;
      await app.vault.adapter.write(`${dir}/data.json`, JSON.stringify({ defaultServer: url, sectionsDisabled: false }));
    },
    server.url,
  );
}

/** The plugin disabled (an update's first step), so nothing of it runs until the next install. */
export const disable = () =>
  inA(async ({ app }) => {
    if (app.plugins.enabledPlugins.has("shared-tasks")) await app.plugins.disablePlugin("shared-tasks");
  });

/**
 * `version`'s files written into the plugin's folder and the plugin enabled
 * (an update: disabled, files replaced, enabled), until its runtime is
 * ready. Its manifest version, status and start time, and which code it is:
 * main.js on disk (read by this process, not through Obsidian) against the
 * files written. 0.4.2 and this build both say 0.4.2 in their manifest.
 */
export async function install(version) {
  const files = releaseFiles(version);
  if (files === null) throw new Error(`no release files for ${version}`);
  const r = await inA(
    async ({ app }, files) => {
      const pl = app.plugins;
      if (pl.enabledPlugins.has("shared-tasks")) await pl.disablePlugin("shared-tasks");
      const dir = `${app.vault.configDir}/plugins/shared-tasks`;
      if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
      // The harness puts the plugin's files into the vault as hard links to
      // this checkout's: removed first, so a write never reaches the checkout.
      for (const [name, content] of Object.entries(files)) {
        const f = `${dir}/${name}`;
        if (await app.vault.adapter.exists(f)) await app.vault.adapter.remove(f);
        await app.vault.adapter.write(f, content);
      }
      await pl.loadManifests();
      const t0 = Date.now();
      await pl.enablePluginAndSave("shared-tasks");
      const p = pl.plugins["shared-tasks"];
      for (let i = 0; i < 300 && p?.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      const st = p?.runtime?.status;
      const disk = JSON.parse(await app.vault.adapter.read(`${dir}/manifest.json`)).version;
      const code = await app.vault.adapter.read(`${dir}/main.js`);
      return {
        version: pl.manifests["shared-tasks"]?.version ?? null,
        disk,
        // Which code runs: this build (main) has SectionsHost.unavailable; 0.4 has sections at all.
        running: typeof p?.sections?.unavailable === "function" ? "main" : p?.sections ? "0.4-beta" : "0.3",
        onDisk: code.includes("holds this vault's data") ? "main" : code.includes("lfcp-section") ? "0.4-beta" : "0.3",
        status: st?.kind ?? null,
        principal: st?.principalId === undefined ? null : Array.from(st.principalId, (b) => b.toString(16).padStart(2, "0")).join(""),
        upgradedLocalData: p?.runtime?.upgradedLocalData === true,
        // Only 0.5 development builds have it (LFCP-03-021).
        dev05: typeof p?.setDismissedHints === "function",
        ms: Date.now() - t0,
        base: app.vault.adapter.basePath ?? null,
        configDir: app.vault.configDir,
      };
    },
    files,
  );
  const sha = (x) => createHash("sha256").update(x).digest("hex");
  const { base, configDir, ...out } = r;
  const dir = base === null ? null : path.join(base, configDir, "plugins", "shared-tasks");
  const disk = (name) => (dir !== null && existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name)) : null);
  const main = disk("main.js");
  const manifest = disk("manifest.json");
  return {
    ...out,
    mainJs: { written: sha(files["main.js"]), disk: main === null ? null : sha(main) },
    fsManifest: manifest === null ? null : JSON.parse(manifest.toString("utf8")).version,
  };
}

export const noteText = (file) => inA(({ app }, f) => app.vault.adapter.read(f), file);

/** The intents A has queued for the server, over every Resource; -1 while its runtime starts or stops. */
export const outboundA = () =>
  inA(async ({ app }) => {
    const rt = app.plugins.plugins["shared-tasks"]?.runtime;
    // Starting or stopping: nothing to count yet.
    if (rt === null || rt === undefined || rt.storage === null) return -1;
    let n = 0;
    for (const e of await rt.registry()) n += (await rt.storage.outbound.list(e.resourceId)).length;
    return n;
  });

/** The status badge of the active note's first section, or null. */
export const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);

/** Opens `file` (created with `text` when missing) in Live Preview, the cursor at `line`. */
export const open = (file, text, line) =>
  inA(
    async ({ app, obsidian }, file, text, line) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() === ""; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line, ch: 0 });
    },
    file,
    text,
    line,
  );

/** Types `text` at the end of the line of `title` in the active editor (as the user). */
export async function typeAfter(title, text) {
  await inA(async ({ app, obsidian }, title) => {
    const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
    for (let i = 0; i < 40 && !e.hasFocus(); i++) {
      e.focus();
      await new Promise((r) => setTimeout(r, 50));
    }
    const line = e.getValue().split("\n").findIndex((l) => l.includes(`] ${title}`));
    e.setCursor({ line, ch: e.getLine(line).length });
  }, title);
  await browser.pause(200);
  await browser.keys(text);
  await browser.pause(300);
}
