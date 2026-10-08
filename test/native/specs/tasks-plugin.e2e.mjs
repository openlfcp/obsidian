// The Obsidian Tasks plugin (8.4.0) next to Shared Tasks: its edits as
// CodeMirror transactions (ADR 0001, S1) and the Task lines it writes,
// including an inline lfcp-ref (decision M1) and a recurring Task.

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const REF = "<!-- lfcp-ref: lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#task:019a2f85-7b31-7c42-b85a-fc843e2f40ad -->";

/** Toggles the Task on line 0 of `text` with Tasks' own command; returns the note and the transactions. */
async function toggle(file, text) {
  return browser.executeObsidian(
    async ({ app, obsidian }, file, text) => {
      await app.vault.create(file, text);
      await app.workspace.openLinkText(file, "", false);
      await new Promise((r) => setTimeout(r, 300));
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      app.workspace.setActiveLeaf(view.leaf, { focus: true });
      view.editor.focus();
      view.editor.setCursor({ line: 0, ch: 2 });
      window.__lfcpSpike.clear();
      app.commands.executeCommandById("obsidian-tasks-plugin:toggle-done");
      await new Promise((r) => setTimeout(r, 300));
      return {
        after: view.editor.getValue(),
        userEvents: window.__lfcpSpike.log.map((e) => e.userEvent),
      };
    },
    file,
    text,
  );
}

describe("Obsidian Tasks 8.4.0 next to Shared Tasks", () => {
  before(async () => {
    const version = await browser.executeObsidian(async ({ app }) => {
      await app.plugins.enablePlugin("obsidian-tasks-plugin");
      return app.plugins.plugins["obsidian-tasks-plugin"]?.manifest.version;
    });
    expect(version).toBe("8.4.0");
  });

  it("T1–T3: Task lines Tasks writes when it toggles one", async () => {
    const plain = await toggle("t1.md", "- [ ] alpha 📅 2026-11-01\n");
    const inline = await toggle("t2.md", `- [ ] alpha 📅 2026-11-01 ${REF}\n`);
    const child = await toggle("t3.md", `- [ ] alpha 📅 2026-11-01\n  ${REF}\n`);
    const recurring = await toggle("t4.md", "- [ ] water 🔁 every day 📅 2026-11-01\n  " + REF + "\n");
    evidence("TASKS", { plain, inline, child, recurring });
    const today = new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD, as Tasks writes it
    // Tasks' own edits carry no userEvent (ADR 0001: classify by our annotation).
    for (const r of [plain, inline, child, recurring]) expect(r.userEvents).toEqual([null]);
    expect(plain.after).toBe(`- [x] alpha 📅 2026-11-01 ✅ ${today}\n`);
    // An inline ref does NOT stay last: Tasks appends ✅ after it (against decision M1).
    expect(inline.after).toBe(`- [x] alpha 📅 2026-11-01 ${REF} ✅ ${today}\n`);
    // A child-line ref is untouched.
    expect(child.after).toBe(`- [x] alpha 📅 2026-11-01 ✅ ${today}\n  ${REF}\n`);
    // A recurring Task: the next occurrence goes ABOVE, unbound; the ref stays with the done one.
    expect(recurring.after).toBe(
      `- [ ] water 🔁 every day 📅 2026-11-02\n- [x] water 🔁 every day 📅 2026-11-01 ✅ ${today}\n  ${REF}\n`,
    );
  });
});
