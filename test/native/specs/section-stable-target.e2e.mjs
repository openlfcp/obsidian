// LFCP-03-009 (F-06, F-07; U03-03, U03-04) in real Obsidian with the
// reference server at LFCP_SERVER_BIN: "Share section…" is bound to the
// note and the selection it started on.
//
// 1. Selection by keyboard: the caret at the start of the heading, Shift+Down
//    three times (the selection ends at column 0 of the blank line after the
//    second Task); the preview shows exactly the heading and two Tasks, the
//    private paragraph after them is listed as staying private; Share binds
//    exactly that range (the end marker before the private paragraph).
// 2. Tab switch: a preview open on one note, the same tab opens another note
//    (as a click in the file explorer does); Share binds the first note, the
//    second is unchanged, and no "heading is gone" notice appears.
// 3. IME: a composition open in the editor (compositionstart, as the IME spec
//    simulates it; WebDriver cannot drive an IME) when "Share section…" runs:
//    no preview opens and the notice says to finish typing.
//
// Status: written with LFCP-03-009, NOT_RUN (native runs are collected by
// the orchestrator separately).
import { restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const TAIL = "PRIVATE_TAIL_c0ffee stays on this device.";
const NOTE = ["## Selected share", "- [ ] One", "- [ ] Two", "", TAIL, "", "## After", ""].join("\n");
const SWITCH = ["## Switched share", "", "- [ ] Alpha", ""].join("\n");
const OTHER = ["## Elsewhere", "", "- [ ] Not this one", ""].join("\n");
let server;

const notices = () => inA(() => window.__lfcpNotices ?? []);
const shareModal = () =>
  inA(() => {
    const m = [...document.querySelectorAll(".modal-container .modal")].find((x) =>
      [...x.querySelectorAll("button")].some((b) => b.textContent === "Share"),
    );
    return m === undefined ? null : m.textContent;
  });
const clickShare = () =>
  inA(() => {
    for (const m of document.querySelectorAll(".modal-container .modal"))
      [...m.querySelectorAll("button")].find((b) => b.textContent === "Share")?.click();
  });
/** Opens `path` (created with `text`) in the active tab, Live Preview, focused; the caret at line 0. */
const openNote = (path, text) =>
  inA(
    async ({ app, obsidian }, p, t) => {
      if (app.vault.getFileByPath(p) === null) await app.vault.create(p, t);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(p), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== t; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.focus();
    },
    path,
    text,
  );
const hosted = (path) =>
  browser.waitUntil(
    () =>
      inA(async ({ app }, p) => {
        const plugin = app.plugins.plugins["shared-tasks"];
        const file = app.vault.getFileByPath(p);
        const R = file === null ? undefined : /<!-- lfcp-section: lfcp1:([A-Za-z0-9_-]+)#/.exec(await app.vault.read(file))?.[1];
        if (R === undefined) return false;
        const hex = Buffer.from(R, "base64url").toString("hex");
        return (await plugin.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted";
      }, path),
    { timeout: 60_000, timeoutMsg: `${path} shared and hosted` },
  );

describe("a share keeps its captured target (LFCP-03-009)", () => {
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

  it("U03-04: Shift+Down to column 0 shares exactly the selected lines", async () => {
    await openNote("Selected.md", NOTE);
    for (let i = 0; i < 3; i++) await browser.keys(["Shift", "ArrowDown"]);
    const selection = await inA(({ app, obsidian }) => {
      const s = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.listSelections()[0];
      return { anchor: s.anchor, head: s.head };
    });
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:share-section"));
    await browser.waitUntil(async () => (await shareModal()) !== null, { timeout: 10_000 });
    const preview = await shareModal();
    await clickShare();
    await hosted("Selected.md");
    const text = await inA(async ({ app }) => app.vault.read(app.vault.getFileByPath("Selected.md")));
    evidence("U03-04-shift-down", { selection, preview, text });
    expect(selection.head).toEqual({ line: 3, ch: 0 });
    expect(preview).toContain("- [ ] Two");
    expect(preview.slice(0, preview.indexOf("Stays private"))).not.toContain("PRIVATE_TAIL");
    expect(text.indexOf("<!-- /lfcp-section: ")).toBeLessThan(text.indexOf(TAIL));
  });

  it("U03-03: the tab switched to another note during the preview; Share binds the first note", async () => {
    await inA(async ({ app }, other) => {
      if (app.vault.getFileByPath("Elsewhere.md") === null) await app.vault.create("Elsewhere.md", other);
    }, OTHER);
    await openNote("Switched.md", SWITCH);
    const before = (await notices()).length;
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:share-section"));
    await browser.waitUntil(async () => (await shareModal()) !== null, { timeout: 10_000 });
    // The same tab shows another note, as a click in the file explorer does.
    await inA(async ({ app }) => {
      await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Elsewhere.md"));
    });
    await clickShare();
    await hosted("Switched.md");
    const files = await inA(async ({ app }) => ({
      elsewhere: await app.vault.read(app.vault.getFileByPath("Elsewhere.md")),
      active: app.workspace.getActiveFile()?.path ?? null,
    }));
    const said = (await notices()).slice(before);
    evidence("U03-03-switch", { files, said });
    expect(files.elsewhere).toBe(OTHER);
    expect(said).toContain('Shared Tasks: section "Switched share" is shared.');
    for (const t of said) expect(t).not.toMatch(/heading is gone|Nothing was shared/);
  });

  it("IME: Share while a composition is open opens no preview", async () => {
    await openNote("Composing.md", ["## Composing", "", "- [ ] Typing", ""].join("\n"));
    const before = (await notices()).length;
    const opened = await inA(async ({ app }) => {
      const content = document.querySelector(".workspace-leaf.mod-active .cm-content");
      content.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      app.commands.executeCommandById("shared-tasks:share-section");
      await new Promise((r) => setTimeout(r, 1000));
      const modals = document.querySelectorAll(".modal-container .modal").length;
      content.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
      return modals;
    });
    const said = (await notices()).slice(before);
    evidence("IME-share", { opened, said });
    expect(opened).toBe(0);
    expect(said).toContain(
      "Shared Tasks: finish typing first (text is still being composed). Nothing was shared.",
    );
  });
});
