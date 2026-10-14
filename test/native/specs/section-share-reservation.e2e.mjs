// LFCP-03-002 (F-03, U03-09) in real Obsidian with the reference server at
// LFCP_SERVER_BIN: the share reservation is the note's, not its path.
//
// A share preview is open on a note; the note is renamed in the file
// explorer's way (fileManager.renameFile); "Share section…" on the renamed
// note brings the open preview forward and opens nothing else; "Insert
// shared section…" on it does the same. Share binds the renamed note: one
// Resource, hosted, no "stopped syncing" / RESOURCE_NOT_HOSTED notice, and
// no "Finish that first" notice.
//
// Status: written with LFCP-03-002, NOT_RUN (native runs are collected by
// the orchestrator separately).
import { restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const NOTE = ["## Renamed share", "", "- [ ] One", "- [ ] Two", ""].join("\n");
let server;

const notices = () => inA(() => window.__lfcpNotices ?? []);

describe("the share reservation follows the note (LFCP-03-002)", () => {
  before(async () => {
    server = await restartableServer();
    await inA(async ({ app }, url) => {
      window.__lfcpNotices = [];
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.classList.contains("notice")) window.__lfcpNotices.push(n.textContent);
      }).observe(document.body, { childList: true, subtree: true });
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = url;
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++)
        await new Promise((r) => setTimeout(r, 50));
    }, server.url);
  });

  after(async () => {
    await server?.stop();
  });

  it("rename during the preview: a repeat reveals it; Share binds the renamed note once", async () => {
    // What earlier specs left in this vault: the counts below are deltas.
    const counts = () =>
      inA(async ({ app }) => {
        const p = app.plugins.plugins["shared-tasks"];
        return {
          listed: (await p.runtime.registry()).filter((x) => x.profile.includes("section")).length,
          stored: (await p.runtime.storage.resources.list()).length,
        };
      });
    const base = await counts();
    const seen = await inA(async ({ app, obsidian }, text) => {
      await app.vault.create("Before rename.md", text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Before rename.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 0, ch: 0 });
      const modals = () => [...document.querySelectorAll(".modal-container .modal")];
      const shareModals = () =>
        modals().filter((m) => [...m.querySelectorAll("button")].some((x) => x.textContent === "Share"));
      app.commands.executeCommandById("shared-tasks:share-section");
      for (let i = 0; i < 80 && shareModals().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      await app.fileManager.renameFile(app.vault.getFileByPath("Before rename.md"), "After rename.md");
      await new Promise((r) => setTimeout(r, 500));
      // The same note under its new path: the open preview comes forward, nothing else opens.
      app.commands.executeCommandById("shared-tasks:share-section");
      await new Promise((r) => setTimeout(r, 500));
      app.commands.executeCommandById("shared-tasks:insert-section");
      await new Promise((r) => setTimeout(r, 1000));
      const front = [...document.body.querySelectorAll(":scope > .modal-container")].at(-1);
      const out = {
        modals: modals().length,
        previews: shareModals().length,
        inFront: front?.contains(shareModals()[0] ?? null) ?? false,
        // The dialog has the focus, not its Share button.
        focus: document.activeElement === shareModals()[0] ? "dialog" : (document.activeElement?.tagName ?? null),
        path: app.workspace.getActiveFile()?.path ?? null,
      };
      for (const m of shareModals()) [...m.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
      return out;
    }, NOTE);
    await browser.waitUntil(
      () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          const file = app.vault.getFileByPath("After rename.md");
          if (file === null || !(await app.vault.read(file)).includes("<!-- /lfcp-section: ")) return false;
          const R = /<!-- lfcp-section: lfcp1:([A-Za-z0-9_-]+)#/.exec(await app.vault.read(file))?.[1];
          if (R === undefined) return false;
          const hex = Buffer.from(R, "base64url").toString("hex");
          return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted";
        }),
      { timeout: 60_000, timeoutMsg: "the renamed note shared and hosted" },
    );
    // Long enough for a refusal of an unhosted Resource to come and be announced.
    await browser.pause(6000);
    const now = await counts();
    const after = await inA(async ({ app }) => {
      return {
        oldPath: app.vault.getFileByPath("Before rename.md") !== null,
        bound: ((await app.vault.read(app.vault.getFileByPath("After rename.md"))).match(/<!-- lfcp-section: /g) ?? [])
          .length,
      };
    });
    const said = await notices();
    evidence("U03-09-rename", { seen, base, now, after, said });
    expect(seen).toEqual({ modals: 1, previews: 1, inFront: true, focus: "dialog", path: "After rename.md" });
    expect({ listed: now.listed - base.listed, stored: now.stored - base.stored }).toEqual({ listed: 1, stored: 1 });
    expect(after).toEqual({ oldPath: false, bound: 1 });
    expect(said).toContain('Shared Tasks: section "Renamed share" is shared.');
    for (const t of said)
      expect(t).not.toMatch(/stopped syncing|RESOURCE_NOT_HOSTED|changed since the preview|Finish that first|heading is gone/);
  });
});
