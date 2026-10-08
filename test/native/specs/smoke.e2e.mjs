// The built plugin loads in a real Obsidian and its runtime starts
// (LFCP-02-096 smoke).

describe("Shared Tasks in a real Obsidian", () => {
  it("is enabled, registers its commands and starts its runtime", async () => {
    const r = await browser.executeObsidian(async ({ app }) => {
      const plugin = app.plugins.plugins["shared-tasks"];
      const runtime = plugin === undefined ? null : await plugin.whenRuntimeStarted();
      return {
        enabled: plugin !== undefined,
        version: plugin?.manifest.version,
        commands: Object.keys(app.commands.commands).filter((id) => id.startsWith("shared-tasks:")),
        runtime: runtime?.status.kind ?? plugin?.runtimeError ?? null,
      };
    });
    expect(r.enabled).toBe(true);
    expect(r.commands).toContain("shared-tasks:share-task-under-cursor");
    expect(r.commands).toContain("shared-tasks:resource-status");
    expect(r.runtime).toBe("ready");
  });
});
