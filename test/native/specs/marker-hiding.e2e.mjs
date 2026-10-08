// LFCP-02-048 spike: hiding LFCP binding lines in Live Preview by default
// (decision M5), with the test-only plugin plugins/marker-spike. Prints
// "EVIDENCE {json}" and asserts what LFCP-02-048 would rely on.

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SEC = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const ref = (n) => `<!-- lfcp-ref: lfcp1:${R}#task:2372cd94-58dc-7fd0-bbc6-6e17c0aeb${String(n).padStart(3, "0")} -->`;
const node = (kind, n) => `<!-- lfcp-node: ${kind}:84cf3237-3432-7041-881f-c34897689${String(n).padStart(3, "0")} -->`;

const NOTE = [
  "Private intro.",
  "",
  "## Joint launch",
  `<!-- lfcp-section: ${SEC} -->`,
  "- [ ] Prepare contract",
  `  ${ref(1)}`,
  `  ${node("paragraph", 2)}`,
  "  Draft contract",
  "",
  "  - Check details",
  `    ${node("item", 3)}`,
  `<!-- /lfcp-section: ${SEC} -->`,
  "",
  "## Other",
  "text",
  "",
].join("\n");
const MARKER_LINES = 5;

/** Opens `file` with `text` in Live Preview, cursor on `line`. */
async function open(file, text, line = 0) {
  await browser.executeObsidian(
    async ({ app, obsidian }, file, text, line) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      else await app.vault.adapter.write(file, text);
      const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      await new Promise((r) => setTimeout(r, 300));
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = leaf.view;
      view.editor.focus();
      view.editor.setCursor({ line, ch: 0 });
    },
    file,
    text,
    line,
  );
  await browser.pause(200);
}

/** Rendered lines of the active editor that show LFCP binding text. */
const visibleMarkers = () =>
  browser.executeObsidian(({ app, obsidian }) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    return [...view.containerEl.querySelectorAll(".cm-content .cm-line")].filter((el) =>
      el.textContent.includes("lfcp-"),
    ).length;
  });
const text = () =>
  browser.executeObsidian(({ app, obsidian }) =>
    app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue(),
  );

describe("LFCP-02-048 spike: hiding binding lines", () => {
  before(async () => {
    await browser.executeObsidian(({ app }) => app.plugins.enablePlugin("lfcp-marker-spike"));
  });

  it("(1) hidden in Live Preview away from the selection; shown on the line, by the toggle and in Source mode", async () => {
    await open("m1.md", NOTE, 0);
    const away = await visibleMarkers();
    await browser.executeObsidian(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 3, ch: 0 }),
    );
    await browser.pause(150);
    const onLine = await visibleMarkers();
    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.cm.dispatch({ effects: window.__lfcpMarkers.setShow.of(true) });
    });
    await browser.pause(150);
    const toggled = await visibleMarkers();
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.cm.dispatch({ effects: window.__lfcpMarkers.setShow.of(false) });
      await view.setState({ ...view.getState(), source: true }, { history: false });
    });
    await browser.pause(300);
    const source = await visibleMarkers();
    evidence("M5-1", { away, onLine, toggled, source });
    expect({ away, onLine, toggled, source }).toEqual({
      away: 0,
      onLine: 1,
      toggled: MARKER_LINES,
      source: MARKER_LINES,
    });
  });

  it("(2) editing around hidden lines: Enter, arrows, checkbox, fold, undo, Outline drag", async () => {
    // Enter at the end of the Task line, its child-line ref hidden below.
    await open("m2.md", NOTE, 4);
    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 4, ch: view.editor.getLine(4).length });
    });
    await browser.keys(["Enter", "N", "e", "w"]);
    await browser.pause(200);
    const afterEnter = (await text()).split("\n").slice(4, 7);
    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 4; i++) view.editor.undo();
    });
    const undone = await text();

    // ArrowDown from the Task line: where does the caret land?
    await open("m3.md", NOTE, 4);
    await browser.keys(["ArrowDown"]);
    const arrowLine = await browser.executeObsidian(
      ({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getCursor().line,
    );

    // Checkbox click and fold, with the markers hidden.
    await open("m4.md", NOTE, 0);
    await (await $(".markdown-source-view .task-list-item-checkbox")).click();
    await browser.pause(200);
    const clicked = (await text()).split("\n")[4];
    const folds = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 2, ch: 0 });
      view.editor.exec("toggleFold");
      await new Promise((r) => setTimeout(r, 200));
      const f = view.currentMode.getFoldInfo().folds;
      view.editor.exec("toggleFold");
      return f;
    });

    // Outline drag of "## Other" above "## Joint launch".
    const dragged = await browser.executeObsidian(async ({ app }) => {
      let leaf = app.workspace.getLeavesOfType("outline")[0];
      if (!leaf) {
        leaf = app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: "outline" });
      }
      await app.workspace.revealLeaf(leaf);
      await new Promise((r) => setTimeout(r, 1000));
      const item = (t) =>
        [...leaf.view.containerEl.querySelectorAll(".tree-item")].find(
          (el) => el.querySelector(".tree-item-inner")?.textContent === t,
        );
      const src = item("Other").querySelector("[draggable]");
      const dst = item("Joint launch").querySelector(".tree-item-self") ?? item("Joint launch");
      const dt = new DataTransfer();
      const box = dst.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.top + 2 };
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      for (const type of ["dragenter", "dragover", "drop"]) dst.dispatchEvent(new DragEvent(type, at));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 800));
      return app.vault.adapter.read("m4.md");
    });
    evidence("M5-2", { afterEnter, undoneEqual: undone === NOTE, arrowLine, clicked, folds, dragged });
    // Enter splits the Task from its ref, as without hiding (MS19: the adapter's job).
    expect(afterEnter).toEqual(["- [ ] Prepare contract", "- [ ] New", `  ${ref(1)}`]);
    expect(undone).toBe(NOTE);
    // ArrowDown from the Task line skips its hidden ref and paragraph marker.
    expect(arrowLine).toBe(7);
    expect(clicked).toBe("- [x] Prepare contract");
    expect(folds).toEqual([{ from: 2, to: 12 }]);
    expect(dragged).toContain(`## Joint launch\n<!-- lfcp-section: ${SEC} -->\n- [x] Prepare contract`);
  });

  it("(3) Reading view shows no binding text, without a post-processor", async () => {
    await open("m5.md", NOTE, 0);
    const r = await browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      await view.setState({ ...view.getState(), mode: "preview" }, { history: false });
      await new Promise((r) => setTimeout(r, 500));
      const el = view.containerEl.querySelector(".markdown-preview-view");
      return { text: el?.textContent ?? "", html: el?.innerHTML.includes("lfcp-") ?? null };
    });
    evidence("M5-3", { hasLfcpText: r.text.includes("lfcp-"), hasLfcpHtml: r.html, sample: r.text.slice(0, 120) });
    expect(r.text).not.toContain("lfcp-");
  });

  it("(4) cost: a 200-Task section while typing and moving the caret", async () => {
    const lines = ["## Big", `<!-- lfcp-section: ${SEC} -->`];
    for (let i = 0; i < 200; i++)
      lines.push(`- [ ] Task ${i + 1}`, `  ${ref(i % 1000)}`, `  ${node("paragraph", i % 1000)}`, `  Note ${i + 1}`);
    lines.push(`<!-- /lfcp-section: ${SEC} -->`, "");
    await open("m6.md", lines.join("\n"), 400);
    await browser.executeObsidian(() => {
      window.__lfcpMarkers.buildMs = 0;
      window.__lfcpMarkers.builds = 0;
    });
    const t0 = Date.now();
    await browser.keys("typing forty characters into the note.".split(""));
    for (let i = 0; i < 20; i++) await browser.keys(["ArrowDown"]);
    const wall = Date.now() - t0;
    const r = await browser.executeObsidian(() => ({ ...window.__lfcpMarkers }));
    evidence("M5-4", { lines: lines.length, builds: r.builds, buildMs: r.buildMs, perBuildMs: r.buildMs / r.builds, wallMs: wall });
    expect(r.builds).toBeGreaterThan(40);
  });
});
