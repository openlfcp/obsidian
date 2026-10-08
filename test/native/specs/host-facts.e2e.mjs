// Facts about the Obsidian host that MVP 0.2 designs depend on
// (LFCP-02-005 evidence; docs/devel/testing/obsidian-host-facts.md). Each is
// asserted, so a new Obsidian that changes one fails here first.

describe("Obsidian host facts (LFCP-02-005)", () => {
  it("indents lists with tabs by default (M2)", async () => {
    const useTab = await browser.executeObsidian(({ app }) => app.vault.getConfig("useTab"));
    expect(useTab).toBe(true);
  });

  it("opens notes in Live Preview, where HTML comments stay visible away from the cursor (M5)", async () => {
    await browser.executeObsidian(async ({ app }) => {
      await app.workspace.openLinkText("comments.md", "", false);
    });
    await browser.pause(500);
    const r = await browser.executeObsidian(
      ({ app, obsidian }) =>
        new Promise((resolve) => {
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          view.editor.setCursor({ line: view.editor.lastLine(), ch: 0 });
          setTimeout(() => {
            const lines = [...view.containerEl.querySelectorAll(".cm-content .cm-line")];
            const refs = lines.filter((el) => el.textContent.includes("lfcp-ref:"));
            resolve({
              livePreview: view.getMode() === "source" && view.getState().source === false,
              refLines: refs.length,
              visible: refs.every((el) => el.getBoundingClientRect().height > 0),
            });
          }, 300);
        }),
    );
    expect(r).toEqual({ livePreview: true, refLines: 2, visible: true });
  });

  // Section start marker before its heading (the 0.2 packet) or right after
  // it (decision M4), private text after the end marker.
  const note = (markerFirst) =>
    [
      "# Doc",
      "",
      "Private intro.",
      "",
      ...(markerFirst
        ? ["<!-- lfcp-section: A -->", "## Shared"]
        : ["## Shared", "<!-- lfcp-section: A -->"]),
      "- [ ] t",
      "<!-- /lfcp-section: A -->",
      "",
      "Private tail.",
      "",
      "## Other",
      "",
      "text",
      "",
    ].join("\n");

  /** Drags the outline item `from` onto `onto` (above it); returns the note. */
  const dragInOutline = (file, text, from, onto) =>
    browser.executeObsidian(
      async ({ app }, file, text, from, onto) => {
        await app.vault.create(file, text);
        await app.workspace.openLinkText(file, "", false);
        let leaf = app.workspace.getLeavesOfType("outline")[0];
        if (!leaf) {
          leaf = app.workspace.getRightLeaf(false);
          await leaf.setViewState({ type: "outline" });
        }
        await app.workspace.revealLeaf(leaf);
        await new Promise((r) => setTimeout(r, 1200));
        const item = (t) =>
          [...leaf.view.containerEl.querySelectorAll(".tree-item")].find(
            (el) => el.querySelector(".tree-item-inner")?.textContent === t,
          );
        const src = item(from).querySelector("[draggable]");
        const dst = item(onto).querySelector(".tree-item-self") ?? item(onto);
        const dt = new DataTransfer();
        const box = dst.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.top + 2 };
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        for (const type of ["dragenter", "dragover", "drop"]) dst.dispatchEvent(new DragEvent(type, at));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 1000));
        return app.vault.adapter.read(file);
      },
      file,
      text,
      from,
      onto,
    );

  it("drags a heading in the Outline with its lines up to the next heading, leaving a marker above it behind (M4)", async () => {
    const before = await dragInOutline("drag-before.md", note(true), "Other", "Shared");
    // The marker stayed; the private "Other" section moved between the markers.
    expect(before).toMatch(/<!-- lfcp-section: A -->\n\n## Other\n\ntext\n\n## Shared\n- \[ \] t\n<!-- \/lfcp-section: A -->/);
    const after = await dragInOutline("drag-after.md", note(false), "Other", "Shared");
    // The marker moved with its heading; the region is intact.
    expect(after).toMatch(/## Other\n\ntext\n\n## Shared\n<!-- lfcp-section: A -->\n- \[ \] t\n<!-- \/lfcp-section: A -->\n\nPrivate tail\./);
  });

  it("folds a heading down to the next heading, private text after the end marker included (M4)", async () => {
    const r = await browser.executeObsidian(
      async ({ app, obsidian }, text) => {
        await app.vault.create("fold.md", text);
        await app.workspace.openLinkText("fold.md", "", false);
        await new Promise((r) => setTimeout(r, 500));
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        app.workspace.setActiveLeaf(view.leaf, { focus: true });
        view.editor.focus();
        view.editor.setCursor({ line: 4, ch: 0 });
        view.editor.exec("toggleFold");
        await new Promise((r) => setTimeout(r, 300));
        return {
          folds: view.currentMode.getFoldInfo().folds,
          visible: [...view.containerEl.querySelectorAll(".cm-line")].map((el) => el.textContent),
        };
      },
      note(false),
    );
    // Lines 4–10: the heading through "Private tail." and the blank line before "## Other".
    expect(r.folds).toEqual([{ from: 4, to: 10 }]);
    expect(r.visible).not.toContain("Private tail.");
    expect(r.visible).toContain("Other");
  });
});

