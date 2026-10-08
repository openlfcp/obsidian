// Baselines of the 0.3 plugin in a real Obsidian (LFCP-02-005 evidence;
// docs/devel/testing/obsidian-host-facts.md). They measure, they do not
// gate: each prints one "METRIC {json}" line, and asserts only that the
// flow worked. The collaboration is local only (an unreachable server), so
// the numbers are the device's own cost: SDK commits, Markdown and vault
// writes, no network.

const N = 200;
const NOWHERE = "ws://127.0.0.1:9/v1/ws";

const metric = (name, value) => console.log(`METRIC ${JSON.stringify({ name, ...value })}`);

describe("0.3 baselines (LFCP-02-005)", () => {
  it(`plugin start, then "Share selected tasks" with ${N} tasks, then edit and render paths`, async () => {
    // A note with N tasks under one heading, and a local-only collaboration.
    await browser.executeObsidian(
      async ({ app }, n, url) => {
        const lines = ["## Sprint", ""];
        for (let i = 0; i < n; i++) lines.push(`- [ ] Task number ${i + 1} 📅 2026-11-${String((i % 28) + 1).padStart(2, "0")}`);
        await app.vault.create("big.md", `${lines.join("\n")}\n`);
        const runtime = app.plugins.plugins["shared-tasks"].runtime;
        await runtime.createResource({ name: "Baseline", endpoints: [url], coordinatorUrl: url });
        await app.workspace.openLinkText("big.md", "", false);
      },
      N,
      NOWHERE,
    );
    await browser.pause(300);

    // "Share selected tasks" from the heading, picking the collaboration.
    await browser.executeObsidian(({ app, obsidian }) => {
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 0, ch: 0 });
    });
    await browser.executeObsidianCommand("shared-tasks:share-selected-tasks");
    const prompt = await $(".prompt");
    await prompt.waitForExist({ timeout: 10_000 });
    const t0 = await browser.execute(() => performance.now());
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        (await browser.executeObsidian(
          async ({ app }) => (await app.vault.adapter.read("big.md")).split("lfcp-ref:").length - 1,
        )) === N,
      { timeout: 120_000, interval: 50 },
    );
    const t1 = await browser.execute(() => performance.now());
    const queued = await browser.executeObsidian(async ({ app }) => {
      const runtime = app.plugins.plugins["shared-tasks"].runtime;
      const [entry] = await runtime.registry();
      return (await runtime.storage.outbound.list(entry.resourceId)).length;
    });
    metric("share-selected", { tasks: N, ms: t1 - t0, perTaskMs: (t1 - t0) / N, queued });

    // Until the plugin has seen its own write (the vault change hub waits
    // 300 ms) and its serialized projection queue is idle again.
    const settle = await browser.executeObsidian(async ({ app }) => {
      const plugin = app.plugins.plugins["shared-tasks"];
      const t0 = performance.now();
      while (plugin.guard.pending > 0 && performance.now() - t0 < 10_000)
        await new Promise((r) => setTimeout(r, 10));
      let jobs = 0;
      for (let last = null; last !== plugin.lastProjection; jobs++) {
        last = plugin.lastProjection;
        await last;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ms: performance.now() - t0, waits: jobs };
    });
    metric("share-selected-settle", settle);
    expect(queued).toBeGreaterThanOrEqual(N);

    // Edit path: a title edited in the editor and saved → its intent queued.
    const edit = await browser.executeObsidian(async ({ app, obsidian }) => {
      const runtime = app.plugins.plugins["shared-tasks"].runtime;
      const [entry] = await runtime.registry();
      const count = async () => (await runtime.storage.outbound.list(entry.resourceId)).length;
      const before = await count();
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getLine(2);
      const at = line.indexOf("Task number 1 ") + "Task number 1".length;
      const t0 = performance.now();
      view.editor.replaceRange(" (edited)", { line: 2, ch: at });
      await view.save();
      while ((await count()) === before && performance.now() - t0 < 30_000)
        await new Promise((r) => setTimeout(r, 10));
      return { ms: performance.now() - t0, queued: (await count()) - before };
    });
    metric("edit-to-queued", edit);
    expect(edit.queued).toBe(1);

    // Render path: a shared change (as a remote one would arrive) → the note rewritten.
    const render = await browser.executeObsidian(async ({ app }) => {
      const runtime = app.plugins.plugins["shared-tasks"].runtime;
      const [entry] = await runtime.registry();
      const count = async () => (await runtime.storage.outbound.list(entry.resourceId)).length;
      const text = await app.vault.adapter.read("big.md");
      const id = /#task:([0-9a-f-]{36})/.exec(text.split("\n").slice(-3).join("\n"))[1];
      const q0 = await count();
      const t0 = performance.now();
      await runtime.writeIntent(entry.resourceId, {
        intent: "task.set_title",
        id,
        title: "Renamed by a peer",
      });
      while (
        !(await app.vault.adapter.read("big.md")).includes("Renamed by a peer") &&
        performance.now() - t0 < 10_000
      )
        await new Promise((r) => setTimeout(r, 10));
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 1000));
      // Only the rename itself is queued: the render sent nothing back.
      return { ms, queued: (await count()) - q0 };
    });
    metric("change-to-render", render);
    expect(render.ms).toBeLessThan(10_000);
    expect(render.queued).toBe(1);
    // Plugin start (last: it replaces the plugin instance): disable and enable, until the runtime is ready.
    const start = await browser.executeObsidian(async ({ app }) => {
      await app.plugins.disablePlugin("shared-tasks");
      const t0 = performance.now();
      await app.plugins.enablePlugin("shared-tasks");
      const loaded = performance.now();
      const runtime = await app.plugins.plugins["shared-tasks"].whenRuntimeStarted();
      return {
        onloadMs: loaded - t0,
        readyMs: performance.now() - t0,
        status: runtime?.status.kind,
      };
    });
    metric("plugin-start", start);
    expect(start.status).toBe("ready");

  });
});
