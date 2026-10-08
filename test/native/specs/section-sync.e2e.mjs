// LFCP-02-041..043: the section engine in a real editor, on the fake SDK
// (plugins/section-sync, test only). Typing, an incoming change while the
// user types, an emoji selection replaced, a new paragraph bound, in Live
// Preview and in Source mode. Mock SDK, real host: the SDK binding replaces
// the fake. IME is the manual checklist (docs/devel/testing/ime-checklist.md).

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SEC = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const P = "84cf3237-3432-7041-881f-c34897689001";
const Q = "84cf3237-3432-7041-881f-c34897689002";

const NOTE = [
  "Private intro.",
  "",
  "## Joint launch",
  `<!-- lfcp-section: ${SEC} -->`,
  `<!-- lfcp-node: paragraph:${P} -->`,
  "Draft contract",
  "",
  `<!-- lfcp-node: paragraph:${Q} -->`,
  "Notes 😀 here",
  `<!-- /lfcp-section: ${SEC} -->`,
  "",
  "Private outro.",
  "",
].join("\n");
const P_LINE = 5;
const Q_LINE = 8;

/** Opens `file` with `text`, in Source mode or Live Preview, focused, caret at the end of `line`. */
async function open(file, text, source, line) {
  await browser.executeObsidian(
    async ({ app, obsidian }, file, text, source, line) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      else await app.vault.adapter.write(file, text);
      const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && (view.editor.getValue() !== text || !view.editor.hasFocus()); i++) {
        view.editor.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
    },
    file,
    text,
    source,
    line,
  );
}

const doc = () =>
  browser.executeObsidian(({ app, obsidian }) =>
    app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue(),
  );
const sync = () => browser.execute(() => window.__lfcpSectionSync);
const changeCount = async () => (await sync()).port.changes.length;
const model = (resource) => browser.execute((r) => window.__lfcpSectionSync.model(r), resource);

/** Waits until `fn` is true, a condition rather than a fixed time. */
const until = (fn, what) => browser.waitUntil(fn, { timeout: 8000, timeoutMsg: what });

describe("LFCP-02-041..043: shared sections in the editor (fake SDK)", () => {
  before(async () => {
    await browser.executeObsidian(async ({ app }) => {
      await app.plugins.enablePlugin("lfcp-section-sync");
    });
  });

  after(async () => {
    await browser.executeObsidian(async ({ app }) => {
      await app.plugins.disablePlugin("lfcp-section-sync");
    });
  });

  for (const [mode, source] of [
    ["live-preview", false],
    ["source", true],
  ]) {
    it(`${mode}: typing, an incoming change while typing, an emoji selection, a new paragraph`, async () => {
      const file = `sync-${mode}.md`;
      const resource = await browser.execute((note) => window.__lfcpSectionSync.host(note), NOTE);
      await open(file, NOTE, source, P_LINE);
      // First sight: the note shows the model, so the base is seeded and nothing is sent.
      await browser.execute((f) => window.__lfcpSectionSync.sync(f), file);
      const start = await changeCount();
      await until(async () => (await sync()).passes.some((p) => p.path === file), "seed pass");
      expect(await changeCount()).toBe(start);

      // Typing: one batch after the idle, the status "edited" before it.
      const before = await changeCount();
      await browser.keys([" ", "v", "2"]);
      await until(async () => (await changeCount()) > before, "typing committed");
      const typed = (await sync()).port.changes.at(-1);
      expect(typed.intents.map((i) => i.intent)).toEqual(["text.edit"]);
      expect((await model(resource))[`nodes`][P].text).toBe("Draft contract v2");
      const statuses = (await sync()).statuses.filter((s) => s.path === file).map((s) => s.status);
      expect(statuses).toContain("edited");

      // An incoming change to P while the user types in Q: both kept, the caret where it was.
      await browser.executeObsidian(
        ({ app, obsidian }, line) => {
          const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
          e.setCursor({ line, ch: e.getLine(line).length });
        },
        Q_LINE,
      );
      await browser.keys(["A"]);
      await browser.execute(
        (r, p, f) => window.__lfcpSectionSync.remoteText(r, p, "Draft agreement", f),
        resource,
        P,
        file,
      );
      await browser.keys(["B"]);
      await until(async () => (await doc()).includes("Draft agreement"), "remote change projected");
      await until(
        async () => (await model(resource)).nodes[Q].text === "Notes 😀 hereAB",
        "typing around the remote change committed",
      );
      const afterRemote = await doc();
      const caret = await browser.executeObsidian(({ app, obsidian }) =>
        app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getCursor(),
      );
      expect(afterRemote.split("\n")[P_LINE]).toBe("Draft agreement");
      expect(afterRemote.split("\n")[Q_LINE]).toBe("Notes 😀 hereAB");
      expect(caret).toEqual({ line: Q_LINE, ch: "Notes 😀 hereAB".length });

      // An emoji selected and typed over: Text positions in scalars (one 😀, two UTF-16 units).
      await browser.executeObsidian(
        ({ app, obsidian }, line) => {
          const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
          const at = e.getLine(line).indexOf("😀");
          e.setSelection({ line, ch: at }, { line, ch: at + 2 });
        },
        Q_LINE,
      );
      await browser.keys(["x"]);
      await until(
        async () => (await model(resource)).nodes[Q].text === "Notes x hereAB",
        "emoji replaced in the model",
      );

      // A new paragraph after Q: created with its own ID, its marker written above it.
      await browser.executeObsidian(
        ({ app, obsidian }, line) => {
          const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
          e.setCursor({ line, ch: e.getLine(line).length });
        },
        Q_LINE,
      );
      await browser.keys(["Enter", "Enter", "N", "e", "w"]);
      await browser.executeObsidian(({ app, obsidian }) => {
        app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.cm.contentDOM.blur();
      });
      await until(
        async () => Object.keys((await model(resource)).nodes).length === 3,
        "new paragraph created",
      );
      const final = await doc();
      const markers = final.match(/<!-- lfcp-node: paragraph:/g) ?? [];
      const created = Object.entries((await model(resource)).nodes).find(([id]) => id !== P && id !== Q);
      evidence(`SYNC-${mode}`, { statuses, changes: (await changeCount()) - start, final });
      expect(markers).toHaveLength(3);
      expect(created?.[1].text).toBe("New");
      expect(final).toContain(`<!-- lfcp-node: paragraph:${created?.[0]} -->\nNew`);
      expect(final.startsWith("Private intro.\n")).toBe(true);
      expect(final.endsWith("Private outro.\n")).toBe(true);
      expect((await sync()).errors).toEqual([]);
    });
  }
});
