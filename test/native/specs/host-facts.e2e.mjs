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
});
