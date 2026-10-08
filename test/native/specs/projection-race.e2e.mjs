// Regression (0.3.2): a shared change that lands while the plugin processes
// a note it has just shared must not be sent back. Before 0.3.2, an edit
// saved within the 300 ms change debounce after "Share selected tasks" made
// the plugin process the note with no bases, and a change arriving mid-pass
// was reverted (docs/devel/testing/obsidian-host-facts.md).

const N = 200;
const NOWHERE = "ws://127.0.0.1:9/v1/ws";

describe("projection race (0.3.2 regression)", () => {
  it("keeps a change that arrives right after sharing and editing", async () => {
    await browser.executeObsidian(
      async ({ app, obsidian }, n, url) => {
        const lines = ["## Sprint", ""];
        for (let i = 0; i < n; i++) lines.push(`- [ ] Task number ${i + 1}`);
        await app.vault.create("race.md", `${lines.join("\n")}\n`);
        await app.plugins.plugins["shared-tasks"].runtime.createResource({
          name: "Race",
          endpoints: [url],
          coordinatorUrl: url,
        });
        await app.workspace.openLinkText("race.md", "", false);
        app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 0, ch: 0 });
      },
      N,
      NOWHERE,
    );
    await browser.executeObsidianCommand("shared-tasks:share-selected-tasks");
    await (await $(".prompt")).waitForExist({ timeout: 10_000 });
    await browser.keys("Enter");
    const r = await browser.executeObsidian(
      async ({ app, obsidian }, n) => {
        const runtime = app.plugins.plugins["shared-tasks"].runtime;
        const [entry] = await runtime.registry();
        const count = async () => (await runtime.storage.outbound.list(entry.resourceId)).length;
        const read = () => app.vault.adapter.read("race.md");
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const refs = (s) => s.split("lfcp-ref:").length - 1;
        const t0 = performance.now();
        // The refs on disk and in the open editor (Obsidian loads the
        // command's write into the editor some 20 ms later).
        while (
          (refs(await read()) < n || refs(view.editor.getValue()) < n) &&
          performance.now() - t0 < 20_000
        )
          await new Promise((r) => setTimeout(r, 10));
        // Edit and save inside the change debounce of the share's own write.
        const before = await count();
        const line = view.editor.getLine(2);
        view.editor.replaceRange(" (edited)", { line: 2, ch: line.length });
        await view.save();
        while ((await count()) === before && performance.now() - t0 < 20_000)
          await new Promise((r) => setTimeout(r, 5));
        // A peer's change to the last Task, while that pass may still run.
        const text = await read();
        const id = /#task:([0-9a-f-]{36})/.exec(text.split("\n").slice(-3).join("\n"))[1];
        const q0 = await count();
        await runtime.writeIntent(entry.resourceId, { intent: "task.set_title", id, title: "Renamed by a peer" });
        await new Promise((r) => setTimeout(r, 2000));
        return {
          replica: (await runtime.profileOf(entry.resourceId)).replica.task(id)?.task?.title,
          rendered: (await read()).includes("Renamed by a peer"),
          queued: (await count()) - q0,
        };
      },
      N,
    );
    expect(r).toEqual({ replica: "Renamed by a peer", rendered: true, queued: 1 });
  });
});
