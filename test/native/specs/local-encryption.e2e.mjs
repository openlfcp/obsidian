// LFCP-02-098 on the real files: a shared Task whose title carries a unique
// canary goes through the plugin into its IndexedDB database (a sealed
// profile checkpoint, a sealed projection base). After the plugin stops,
// no file of Obsidian's IndexedDB directory holds the canary. A control
// canary written unsealed into the same database must be found, so a scan
// that cannot see plaintext (compression, the wrong directory) fails.
// Obsidian's File recovery core plugin is off: it keeps copies of the
// notes themselves in IndexedDB, which this does not cover (design §1).

const NOWHERE = "ws://127.0.0.1:9/v1/ws";
const CANARY = `CANARY_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
const CONTROL = `CONTROL_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

describe("local state encrypted at rest (LFCP-02-098)", () => {
  it("no IndexedDB file holds a shared Task's title; an unsealed control is found", async () => {
    await browser.executeObsidian(
      async ({ app, obsidian }, canary, url) => {
        // Obsidian's File recovery snapshots note text into the same IndexedDB
        // directory: the note's own text is out of scope (the vault's Markdown).
        await app.internalPlugins.getPluginById("file-recovery")?.disable(true);
        await app.vault.create("canary.md", `## Plan\n\n- [ ] ${canary} contract\n`);
        await app.plugins.plugins["shared-tasks"].runtime.createResource({
          name: "Canary",
          endpoints: [url],
          coordinatorUrl: url,
        });
        await app.workspace.openLinkText("canary.md", "", false);
        const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
        editor.setSelection({ line: 0, ch: 0 }, { line: 2, ch: editor.getLine(2).length });
      },
      CANARY,
      NOWHERE,
    );
    await browser.executeObsidianCommand("shared-tasks:share-selected-tasks");
    await (await $(".prompt")).waitForExist({ timeout: 10_000 });
    await browser.keys("Enter");
    await browser.waitUntil(
      () =>
        browser.executeObsidian(async ({ app }) =>
          (await app.vault.adapter.read("canary.md")).includes("lfcp-ref:"),
        ),
      { timeout: 10_000, timeoutMsg: "the task shared" },
    );
    const found = await browser.executeObsidian(
      async ({ app }, canary, control) => {
        const plugin = app.plugins.plugins["shared-tasks"];
        const runtime = plugin.runtime;
        // The control: plaintext in the same database, outside the plugin's sealing.
        await runtime.storage.meta.put("canary-control", control);
        const diagnostics = runtime.localStateSummary(await runtime.localStateDiagnostics());
        // Stopping flushes the checkpoints; LevelDB then has every write in its files.
        await app.plugins.disablePlugin("shared-tasks");
        await new Promise((r) => setTimeout(r, 1500));
        const fs = require("node:fs");
        const path = require("node:path");
        const arg = process.argv.find((a) => a.startsWith("--user-data-dir="));
        const dir = path.join(arg.slice("--user-data-dir=".length), "IndexedDB");
        const files = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true }))
            if (e.isDirectory()) walk(path.join(d, e.name));
            else files.push(path.join(d, e.name));
        };
        walk(dir);
        const hits = (needle) =>
          files.filter((f) => fs.readFileSync(f).includes(Buffer.from(needle, "latin1")));
        const result = {
          files: files.length,
          canary: hits(canary).map((f) => path.relative(dir, f)),
          control: hits(control).map((f) => path.relative(dir, f)),
          diagnostics,
        };
        await app.plugins.enablePlugin("shared-tasks");
        return result;
      },
      CANARY,
      CONTROL,
    );
    console.log(`EVIDENCE ${JSON.stringify({ id: "LOCAL-ENCRYPTION-CANARY", ...found })}`);
    expect(found.files).toBeGreaterThan(0);
    expect(found.control.length).toBeGreaterThan(0);
    expect(found.canary).toEqual([]);
    expect(found.diagnostics).toMatch(/^Local encryption: lse-v1, generation 1, key present\./);
  });
});
