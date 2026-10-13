// The desktop support matrix (LFCP-02-069, docs/devel/testing/support-matrix-0.2.md):
// a shared section in vault A (real Obsidian, the real plugin), the headless
// peer B and the reference server at LFCP_SERVER_BIN, under both themes and
// in the three views, in split panes, with focus moving between panes, and
// copied from Live Preview into a note outside any section.
// 1. Light (moonstone) and dark (obsidian) theme × Source, Live Preview and
//    Reading view: B's edit shows in the view, the badge is CURRENT, and no
//    binding text shows where it is hidden (Live Preview, Reading).
//    Back from Reading view to editing, B's edit stays in the note and at B
//    (it used to live only in the editor behind the Reading view, lost at
//    the switch).
// 2. Per note: one shared note in Reading view and another in Live Preview,
//    side by side; B's edits show in both and reach both files.
//    Split view: the note in Live Preview and in Reading side by side; A
//    types in the Live Preview pane and B's edit shows in both.
// 3. Focus: A types in one pane and clicks the other; the edit reaches B
//    without another keystroke.
// 4. Clipboard: two Task lines copied in Live Preview and pasted in a plain
//    note carry no binding text there.
import {
  editorA,
  evidence,
  inA,
  lineOf,
  mod,
  sectionOf,
  shareAndJoin,
  startPeers,
  stateA,
  titles,
} from "./support/section-checks.mjs";

const HEADING = "## Matrix";
const NOTE = [HEADING, "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "A paragraph.", ""].join("\n");
const BINDING = /lfcp-(?:section|node|ref):/;

/** The active note's view state: mode "source" (source true: Source, false: Live Preview) or "preview" (Reading). */
const setView = (mode, source) =>
  inA(
    async ({ app, obsidian }, mode, source) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      await view.leaf.setViewState({ type: "markdown", state: { file: view.file.path, mode, source } });
      await new Promise((r) => setTimeout(r, 500));
    },
    mode,
    source,
  );

/** What the active view shows as text: the editor's rendered lines, or the Reading view's. */
const shownText = () =>
  inA(({ app, obsidian }) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (view.getMode() === "preview") return view.previewMode.containerEl.innerText;
    return view.editor.cm.contentDOM.innerText;
  });

const setTheme = (theme) =>
  inA(async ({ app }, theme) => {
    app.vault.setConfig("theme", theme);
    const dark = theme === "obsidian";
    for (let i = 0; i < 40 && document.body.classList.contains("theme-dark") !== dark; i++)
      await new Promise((r) => setTimeout(r, 100));
    return document.body.classList.contains("theme-dark");
  }, theme);

/** B renames Task `from` to `to` in its copy and passes. */
async function renameInB(ctx, from, to) {
  ctx.b.files.set(ctx.bFile, ctx.b.files.get(ctx.bFile).replace(`- [ ] ${from}\n`, `- [ ] ${to}\n`));
  await ctx.b.pass(ctx.bFile);
}

const badge = async (ctx) => (await stateA(ctx.R)).badge;

describe("the desktop support matrix (LFCP-02-069)", () => {
  const ctx = {};
  let server;
  let original;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    Object.assign(ctx, await shareAndJoin(ctx.b, "Matrix.md", HEADING, NOTE));
    original = await inA(({ app }) => app.vault.getConfig("theme"));
  });

  after(async () => {
    await inA(({ app }, t) => app.vault.setConfig("theme", t), original);
    await ctx.b?.stop();
    await server?.stop();
  });

  let n = 0;
  for (const theme of ["moonstone", "obsidian"])
    for (const [label, mode, source] of [
      ["Source", "source", true],
      ["Live Preview", "source", false],
      ["Reading", "preview", false],
    ])
      it(`${theme === "obsidian" ? "dark" : "light"} theme, ${label}: B's edit shows, CURRENT, no binding text where hidden`, async () => {
        const dark = await setTheme(theme);
        await setView(mode, source);
        const title = `Gamma ${++n}`;
        const before = titles(sectionOf(ctx.b.files.get(ctx.bFile))).find((t) => t.startsWith("Gamma")) ?? "Gamma";
        await renameInB(ctx, before, title);
        const shown = await browser
          .waitUntil(async () => ((await shownText()).includes(title) ? await shownText() : false), { timeout: 30_000 })
          .catch(() => null);
        const current = await browser.waitUntil(async () => (await badge(ctx)) === "CURRENT", { timeout: 30_000 }).catch(() => false);
        // An open editor's text reaches the file at Obsidian's next save (about 2 s).
        const inFile = await browser
          .waitUntil(async () => (await inA(({ app }) => app.vault.adapter.read("Matrix.md"))).includes(title), { timeout: 10_000 })
          .catch(() => false);
        let back = null;
        if (label === "Reading") {
          // Back to editing: the editor holds the file as written, B's title
          // stays and A sends nothing back (LFCP-02-069: the change used to
          // live only in the hidden editor and vanish at this switch).
          await setView("source", false);
          await browser.pause(5000);
          await ctx.b.pass(ctx.bFile);
          back = {
            editor: (await shownText()).includes(title),
            file: (await inA(({ app }) => app.vault.adapter.read("Matrix.md"))).includes(title),
            b: titles(sectionOf(ctx.b.files.get(ctx.bFile))).includes(title),
          };
          await setView(mode, source);
        }
        evidence(`MATRIX ${theme} ${label}`, { dark, shown: shown !== null, current, inFile, back, bindingShown: shown !== null && BINDING.test(shown) });
        expect(inFile).toBe(true);
        if (back !== null) expect(back).toEqual({ editor: true, file: true, b: true });
        expect(dark).toBe(theme === "obsidian");
        expect(shown).not.toBe(null);
        expect(current).toBe(true);
        // Source shows the binding lines as they are; Live Preview and Reading hide them.
        if (label !== "Source") expect(BINDING.test(shown)).toBe(false);
      });

  it("one note in Reading view, another in Live Preview: each by its own route, B's edits show in both", async () => {
    await setTheme("moonstone");
    const other = await shareAndJoin(ctx.b, "Other.md", "## Other", ["## Other", "- [ ] One", "- [ ] Two", ""].join("\n"));
    // Matrix.md in Reading view on the left, Other.md in Live Preview on the right.
    await inA(async ({ app }) => {
      const left = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md") ?? app.workspace.getLeaf(false);
      await left.openFile(app.vault.getFileByPath("Matrix.md"), { state: { mode: "preview" } });
      const right = app.workspace.getLeaf("split", "vertical");
      await right.openFile(app.vault.getFileByPath("Other.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(right, { focus: true });
      await new Promise((r) => setTimeout(r, 500));
    });
    const gamma = titles(sectionOf(ctx.b.files.get(ctx.bFile))).find((t) => t.startsWith("Gamma"));
    await renameInB(ctx, gamma, "Gamma per note");
    other.b = ctx.b;
    await renameInB(other, "Two", "Two per note");
    const panes = () =>
      inA(({ app }) =>
        Object.fromEntries(
          app.workspace.getLeavesOfType("markdown").map((l) => [
            `${l.view.file?.path}:${l.view.getMode()}`,
            l.view.getMode() === "preview" ? l.view.previewMode.containerEl.innerText : l.view.editor.cm.contentDOM.innerText,
          ]),
        ),
      );
    const both = await browser
      .waitUntil(
        async () => {
          const p = await panes();
          return (p["Matrix.md:preview"] ?? "").includes("Gamma per note") && (p["Other.md:source"] ?? "").includes("Two per note") ? p : false;
        },
        { timeout: 30_000 },
      )
      .catch(() => null);
    const files = await browser
      .waitUntil(
        async () => {
          const f = await inA(async ({ app }) => ({
            matrix: (await app.vault.adapter.read("Matrix.md")).includes("Gamma per note"),
            other: (await app.vault.adapter.read("Other.md")).includes("Two per note"),
          }));
          return f.matrix && f.other ? f : false;
        },
        { timeout: 10_000 },
      )
      .catch(() => ({ matrix: false, other: false }));
    evidence("MATRIX per note", { shown: both !== null, files });
    expect(both).not.toBe(null);
    expect(files).toEqual({ matrix: true, other: true });
    // Back to one Matrix.md pane in Live Preview for the cases that follow.
    await inA(async ({ app }) => {
      for (const l of app.workspace.getLeavesOfType("markdown").filter((x) => x.view.file?.path === "Other.md")) l.detach();
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md");
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await setView("source", false);
  });

  it("split view: Live Preview and Reading side by side; A's typing and B's edit show in both", async () => {
    await setTheme("moonstone");
    await setView("source", false);
    await inA(async ({ app }) => {
      const leaf = app.workspace.getLeaf("split", "vertical");
      await leaf.openFile(app.vault.getFileByPath("Matrix.md"), { state: { mode: "preview" } });
      await new Promise((r) => setTimeout(r, 500));
    });
    const panes = () =>
      inA(({ app }) =>
        app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === "Matrix.md").map((l) => ({
          mode: l.view.getMode(),
          text: l.view.getMode() === "preview" ? l.view.previewMode.containerEl.innerText : l.view.editor.cm.contentDOM.innerText,
        })),
      );
    // A types in the Live Preview pane.
    await inA(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md" && l.view.getMode() === "source");
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await editorA((e, n) => {
      e.focus();
      e.setCursor({ line: n, ch: e.getLine(n).length });
    }, await lineOf("Alpha"));
    await browser.keys(" split");
    await renameInB(ctx, "Beta", "Beta from B");
    const both = await browser
      .waitUntil(
        async () => {
          const p = await panes();
          return p.length === 2 && p.every((x) => x.text.includes("Alpha split") && x.text.includes("Beta from B")) ? p : false;
        },
        { timeout: 30_000 },
      )
      .catch(() => null);
    const atB = await browser
      .waitUntil(async () => titles(sectionOf(ctx.b.files.get(ctx.bFile))).includes("Alpha split") || (await ctx.b.pass(ctx.bFile), false), { timeout: 30_000 })
      .catch(() => false);
    evidence("MATRIX split", { panes: both?.map((p) => p.mode) ?? null, atB, bindingShown: both?.some((p) => BINDING.test(p.text)) ?? null });
    expect(both).not.toBe(null);
    expect(atB).toBe(true);
    expect(both.some((p) => BINDING.test(p.text))).toBe(false);
  });

  it("focus: a keystroke, then a click in the other pane; the edit reaches B without another key", async () => {
    await inA(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md" && l.view.getMode() === "source");
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await editorA((e, n) => {
      e.focus();
      e.setCursor({ line: n, ch: e.getLine(n).length });
    }, await lineOf("Alpha split"));
    await browser.keys(" focus");
    // Click into the Reading pane.
    const at = await inA(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md" && l.view.getMode() === "preview");
      const r = leaf.view.containerEl.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: at.x, y: at.y, origin: "viewport" })
      .down({ button: 0 })
      .up({ button: 0 })
      .perform();
    const atB = await browser
      .waitUntil(async () => {
        await ctx.b.pass(ctx.bFile);
        return titles(sectionOf(ctx.b.files.get(ctx.bFile))).includes("Alpha split focus");
      }, { timeout: 30_000 })
      .catch(() => false);
    const focusIn = await inA(() => document.activeElement?.closest(".markdown-reading-view") !== null);
    evidence("MATRIX focus", { atB, focusInReading: focusIn });
    expect(atB).toBe(true);
  });

  it("clipboard: Task lines copied in Live Preview carry no binding text into a plain note", async () => {
    await inA(async ({ app }) => {
      for (const l of app.workspace.getLeavesOfType("markdown").filter((x) => x.view.getMode() === "preview")) l.detach();
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Matrix.md");
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await setView("source", false);
    const from = await lineOf("Alpha split focus");
    const to = await lineOf("Beta from B");
    await editorA(
      (e, a, b) => {
        e.focus();
        e.setSelection({ line: a, ch: 0 }, { line: b + 1, ch: e.getLine(b + 1).length });
      },
      from,
      to,
    );
    await browser.keys([mod, "c"]);
    await browser.pause(300);
    const copied = await inA(() => window.require("electron").clipboard.readText());
    await inA(async ({ app }) => {
      const f = await app.vault.create("Plain.md", "# Plain\n\n");
      await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
    });
    await editorA((e) => {
      e.focus();
      e.setCursor({ line: 2, ch: 0 });
    });
    await browser.keys([mod, "v"]);
    await browser.pause(800);
    const pasted = await inA(async ({ app }) => app.vault.read(app.vault.getFileByPath("Plain.md")));
    evidence("MATRIX clipboard", { copiedHasBinding: BINDING.test(copied), pasted: pasted.split("\n") });
    expect(pasted).toContain("Alpha split focus");
    expect(BINDING.test(pasted)).toBe(false);
  });
});
