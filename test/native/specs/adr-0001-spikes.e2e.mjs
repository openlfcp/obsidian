// ADR 0001 spikes S1–S6 (docs/architecture/decisions/0001-codemirror-transactions-for-sections.md):
// how CodeMirror transactions behave in a real Obsidian, through the spike
// plugin (test/native/plugins/cm-spike). Each test prints "EVIDENCE {json}"
// and asserts what the ADR relies on.

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);

/** Creates and opens `file` in the active leaf, focused, cursor at `cursor`. */
async function open(file, text, cursor = { line: 0, ch: 0 }) {
  await browser.executeObsidian(
    async ({ app, obsidian }, file, text, cursor) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      else await app.vault.adapter.write(file, text);
      await app.workspace.openLinkText(file, "", false);
      await new Promise((r) => setTimeout(r, 300));
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      app.workspace.setActiveLeaf(view.leaf, { focus: true });
      view.editor.focus();
      view.editor.setCursor(cursor);
      window.__lfcpSpike.clear();
      window.__lfcpSpike.bind = null;
    },
    file,
    text,
    cursor,
  );
  await browser.pause(100);
}

const log = () =>
  browser.executeObsidian(() => window.__lfcpSpike.log.map(({ t, composing, ...e }) => e));
const text = () =>
  browser.executeObsidian(({ app, obsidian }) =>
    app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue(),
  );
const mod = process.platform === "darwin" ? "Meta" : "Control";

describe("ADR 0001 spikes", () => {
  it("S1: every gesture reaches a ViewPlugin, with its userEvent", async () => {
    const seen = {};
    const gesture = async (name, run) => {
      await browser.executeObsidian(() => window.__lfcpSpike.clear());
      await run();
      await browser.pause(250);
      seen[name] = (await log()).map((e) => e.userEvent ?? (e.remote ? "remote" : null));
    };
    await open("s1.md", "- [ ] alpha\n- [ ] beta\n\n## Head\ntext\n", { line: 0, ch: 11 });
    await gesture("type", () => browser.keys(["x"]));
    await gesture("enter-in-list", () => browser.keys(["Enter"]));
    await gesture("backspace", () => browser.keys(["Backspace"]));
    await gesture("paste", async () => {
      await browser.executeObsidian(() => navigator.clipboard.writeText("pasted"));
      await browser.keys([mod, "v"]);
    });
    await gesture("undo", () => browser.keys([mod, "z"]));
    await gesture("command-swap-line-down", () =>
      browser.executeObsidianCommand("editor:swap-line-down"),
    );
    await gesture("command-toggle-checklist", () =>
      browser.executeObsidianCommand("editor:toggle-checklist-status"),
    );
    await gesture("click-checkbox-live-preview", async () => {
      const box = await $(".markdown-source-view .task-list-item-checkbox");
      await box.click();
    });
    await gesture("editor-api-replaceRange", () =>
      browser.executeObsidian(({ app, obsidian }) =>
        app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.replaceRange("!", { line: 0, ch: 0 }),
      ),
    );
    await gesture("vault-process-open-file", () =>
      browser.executeObsidian(({ app }) =>
        app.vault.process(app.vault.getFileByPath("s1.md"), (d) => `${d}external\n`),
      ),
    );
    evidence("S1", { userEvents: seen });
    // Obsidian's own edits (commands, checkbox clicks, the Editor API) carry
    // no userEvent; an external write to an open note arrives as "set".
    expect(seen).toEqual({
      type: ["input.type"],
      "enter-in-list": ["input.type"],
      backspace: ["delete.backward"],
      paste: ["input.paste"],
      undo: ["undo"],
      "command-swap-line-down": ["move.line"],
      "command-toggle-checklist": [null],
      "click-checkbox-live-preview": [null],
      "editor-api-replaceRange": [null],
      "vault-process-open-file": ["set"],
    });
  });

  it("S2: a transaction filter joins the plugin's change to the user's undo step", async () => {
    await open("s2.md", "- [ ] alpha\n", { line: 0, ch: 11 });
    // Filter: whenever the user types "Z", append a marker line in the same transaction.
    await browser.executeObsidian(() => {
      const spike = window.__lfcpSpike;
      spike.bind = (tr) => {
        let z = false;
        tr.changes.iterChanges((_a, _b, _c, _d, ins) => {
          if (ins.toString() === "Z") z = true;
        });
        return z ? { from: tr.newDoc.length, insert: "<!-- m -->\n" } : null;
      };
    });
    await browser.keys(["Z"]);
    await browser.pause(200);
    const typed = await text();
    await browser.executeObsidian(({ app, obsidian }) => {
      window.__lfcpSpike.bind = null;
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.undo();
    });
    const undone = await text();
    await browser.executeObsidian(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.redo(),
    );
    const redone = await text();

    // The alternative: a separate dispatch right after the user's input.
    await open("s2b.md", "- [ ] alpha\n", { line: 0, ch: 11 });
    await browser.keys(["Z"]);
    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const cm = window.__lfcpSpike.viewsOf("s2b.md")[0];
      window.__lfcpSpike.dispatch(cm, { from: cm.state.doc.length, insert: "<!-- m -->\n" }, { userEvent: "input.type" });
      view.editor.undo();
    });
    const separateUndone = await text();
    evidence("S2", { typed, undone, redone, separateUndone });
    expect(typed).toBe("- [ ] alphaZ\n<!-- m -->\n");
    expect(undone).toBe("- [ ] alpha\n");
    expect(redone).toBe(typed);
    // A separate dispatch, even with the same userEvent, is its own undo step.
    expect(separateUndone).toBe("- [ ] alphaZ\n");
  });

  it("S3: two views of one note; a change in one reaches the other", async () => {
    await open("s3.md", "- [ ] alpha\n");
    const r = await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getFileByPath("s3.md");
      const second = app.workspace.getLeaf("split");
      await second.openFile(file);
      await new Promise((r) => setTimeout(r, 400));
      const spike = window.__lfcpSpike;
      const [a, b] = spike.viewsOf("s3.md");
      spike.clear();
      spike.dispatch(a, { from: 0, insert: "X" }, { op: "op-1", history: false, userEvent: "lfcp.remote" });
      await new Promise((r) => setTimeout(r, 300));
      const entries = spike.log.map(({ t, composing, changes, ...e }) => e);
      return {
        views: spike.viewsOf("s3.md").length,
        same: a.state.doc.toString() === b.state.doc.toString(),
        entries,
        indexA: [...spike.views].indexOf(a),
        indexB: [...spike.views].indexOf(b),
      };
    });
    evidence("S3", r);
    expect(r.views).toBe(2);
    expect(r.same).toBe(true);
    // The other view receives the change as "set", without our annotation.
    expect(r.entries.find((e) => e.view === r.indexB)).toMatchObject({ userEvent: "set", origin: null });
  });

  it("S4: vault.process on an open note: the buffer, the cursor and unsaved typing", async () => {
    await open("s4.md", "line one\nline two\nline three\n", { line: 2, ch: 4 });
    const clean = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      await app.vault.process(app.vault.getFileByPath("s4.md"), (d) => `TOP\n${d}`);
      const t0 = performance.now();
      while (!view.editor.getValue().startsWith("TOP") && performance.now() - t0 < 3000)
        await new Promise((r) => setTimeout(r, 5));
      return { lagMs: performance.now() - t0, cursor: view.editor.getCursor(), buffer: view.editor.getValue() };
    });
    // Unsaved typing in the buffer, then an external write.
    await browser.keys(["Q"]);
    const dirty = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const disk = await app.vault.adapter.read("s4.md");
      await app.vault.process(app.vault.getFileByPath("s4.md"), (d) => `${d}BOTTOM\n`);
      await new Promise((r) => setTimeout(r, 800));
      return {
        typedWasUnsaved: !disk.includes("Q"),
        buffer: view.editor.getValue(),
        disk: await app.vault.adapter.read("s4.md"),
      };
    });
    evidence("S4", { clean, dirty });
    expect(clean.cursor).toEqual({ line: 3, ch: 4 });
    // An unsaved edit in the buffer is kept and merged with the external write.
    expect(dirty).toMatchObject({
      typedWasUnsaved: true,
      buffer: "TOP\nline one\nline two\nlineQ three\nBOTTOM\n",
    });
  });

  it("S5: the recorder's cost while typing in a 200-Task note", async () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`- [ ] Task number ${i + 1}`, "  <!-- lfcp-ref: x -->");
    await open("s5.md", `${lines.join("\n")}\n`, { line: 200, ch: 0 });
    await browser.executeObsidian(() => {
      window.__lfcpSpike.updateMs = 0;
    });
    const t0 = Date.now();
    await browser.keys("typing forty characters into a long note".split(""));
    const wall = Date.now() - t0;
    const r = await browser.executeObsidian(() => ({
      updates: window.__lfcpSpike.log.length,
      updateMs: window.__lfcpSpike.updateMs,
    }));
    evidence("S5", { ...r, perUpdateMs: r.updateMs / Math.max(1, r.updates), wallMs: wall });
    expect(r.updates).toBeGreaterThan(30);
  });

  it("S6: a transaction filter leaves list continuation, checkbox clicks and folding alone", async () => {
    await open("s6.md", "## Head\n- [ ] alpha\n\n## Next\ntext\n", { line: 1, ch: 11 });
    await browser.executeObsidian(() => {
      // Active but adding nothing to these gestures.
      window.__lfcpSpike.bind = () => null;
    });
    await browser.keys(["Enter", "b"]);
    await browser.pause(200);
    const continued = await text();
    const box = await $(".markdown-source-view .task-list-item-checkbox");
    await box.click();
    await browser.pause(200);
    const clicked = await text();
    const folds = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.exec("toggleFold");
      await new Promise((r) => setTimeout(r, 200));
      return view.currentMode.getFoldInfo().folds;
    });
    evidence("S6", { continued, clicked, folds });
    expect(continued).toBe("## Head\n- [ ] alpha\n- [ ] b\n\n## Next\ntext\n");
    expect(clicked).toContain("- [x] alpha");
    expect(folds.length).toBe(1);
  });
});
