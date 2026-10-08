// LFCP-02-048 in Shared Tasks itself: a shared section's binding lines are
// hidden in Live Preview, standalone refs are not, and "Show or hide
// sharing metadata" switches them in every editor and is remembered.

const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SEC = `lfcp1:${R}#section:268a166f-4891-7243-840e-e7fea9fe6390`;
const ref = (n) => `<!-- lfcp-ref: lfcp1:${R}#task:2372cd94-58dc-7fd0-bbc6-6e17c0aeb${String(n).padStart(3, "0")} -->`;
const NOTE = [
  "- [ ] Standalone",
  `  ${ref(9)}`,
  "",
  "## Shared",
  `<!-- lfcp-section: ${SEC} -->`,
  "- [ ] Task",
  `  ${ref(1)}`,
  "  <!-- lfcp-node: paragraph:84cf3237-3432-7041-881f-c34897689002 -->",
  "  Text",
  `<!-- /lfcp-section: ${SEC} -->`,
  "",
].join("\n");

const state = () =>
  browser.executeObsidian(({ app, obsidian }) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const lines = [...view.containerEl.querySelectorAll(".cm-content .cm-line")];
    return {
      binding: lines.filter((el) => el.textContent.includes("lfcp-")).length,
      boundary: lines.filter((el) => el.classList.contains("openlfcp-section-line")).length,
      setting: app.plugins.plugins["shared-tasks"].settings.showSharingMetadata,
    };
  });

describe("sharing metadata in Shared Tasks (LFCP-02-048)", () => {
  it("hides a section's binding lines by default, keeps standalone refs, and toggles them", async () => {
    await browser.executeObsidian(async ({ app }, note) => {
      await app.vault.create("meta.md", note);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("meta.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      leaf.view.editor.setCursor({ line: 0, ch: 0 });
    }, NOTE);
    await browser.pause(300);
    const hidden = await state();
    await browser.executeObsidianCommand("shared-tasks:toggle-sharing-metadata");
    await browser.pause(200);
    const shown = await state();
    await browser.executeObsidianCommand("shared-tasks:toggle-sharing-metadata");
    await browser.pause(200);
    const again = await state();
    // Only the standalone ref is visible; the section's 4 binding lines are hidden.
    expect(hidden).toEqual({ binding: 1, boundary: 3, setting: false });
    expect(shown).toEqual({ binding: 5, boundary: 7, setting: true });
    expect(again).toEqual(hidden);
  });
});
