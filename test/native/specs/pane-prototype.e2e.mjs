// LFCP-03-007: the developer pane prototype in a real Obsidian, on mock
// facts (no SDK operation, no server, synthetic content). Status: NOT_RUN
// when it was written; its first run is in CI after LFCP-03-031.
//
// - The prototype exists only with the developer flag: no command without it.
// - Every scenario (the four layouts of UX §3, the join start and every
//   fixture of test/fixtures/ux-0.3/states.json) in a narrow pane, light and
//   dark: the primary button is the fixture's, and a screenshot of the pane
//   is saved to $LFCP_SCREENSHOT_DIR (default: the system temp directory).
// - share → invite with the keyboard only: Enter on the focused primary,
//   focus stays in the pane; the active note switched mid-flow, the flow
//   keeps its note.
// The screenshots are design review material, not evidence of sync.

import { mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const states = JSON.parse(
  readFileSync(path.join(here, "../../fixtures/ux-0.3/states.json"), "utf8"),
);
const LABEL = Object.fromEntries(states.actions.map((a) => [a.id, a.label]));
const VIEW = "shared-tasks-pane-prototype";
const OUT = process.env.LFCP_SCREENSHOT_DIR ?? path.join(os.tmpdir(), "lfcp-pane-prototype");

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);

/** The developer flag on or off, the plugin restarted so that onload sees it. */
const prototypeFlag = (on) =>
  browser.executeObsidian(async ({ app }, on) => {
    const plugin = app.plugins.plugins["shared-tasks"];
    plugin.settings.developerPanePrototype = on;
    await plugin.saveData(plugin.settings);
    await app.plugins.disablePlugin("shared-tasks");
    await app.plugins.enablePlugin("shared-tasks");
  }, on);

const commands = () =>
  browser.executeObsidian(({ app }) =>
    Object.keys(app.commands.commands).filter((id) => id.startsWith("shared-tasks:")),
  );

/** Calls a method of the open prototype view. */
const view = (method, ...args) =>
  browser.executeObsidian(
    ({ app }, type, method, args) => {
      const v = app.workspace.getLeavesOfType(type)[0]?.view;
      return v?.[method](...args);
    },
    VIEW,
    method,
    args,
  );

const primaryLabel = () =>
  browser.execute(
    () => document.querySelector(".openlfcp-pane-primary button")?.textContent ?? null,
  );

const theme = (mode) =>
  browser.executeObsidian(({ app }, mode) => {
    app.changeTheme?.(mode === "dark" ? "obsidian" : "moonstone");
  }, mode);

describe("LFCP-03-007: pane prototype (mock facts)", () => {
  before(() => mkdirSync(OUT, { recursive: true }));

  after(async () => {
    await theme("light");
    await prototypeFlag(false);
  });

  it("has no prototype command without the developer flag", async () => {
    await prototypeFlag(false);
    expect(await commands()).not.toContain("shared-tasks:open-pane-prototype");
    await prototypeFlag(true);
    expect(await commands()).toContain("shared-tasks:open-pane-prototype");
    await browser.executeObsidianCommand("shared-tasks:open-pane-prototype");
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
  });

  for (const mode of ["light", "dark"])
    it(`shows every scenario in a narrow pane (${mode}), with the fixture's primary action`, async () => {
      await theme(mode);
      const scenarios = await browser.executeObsidian(
        ({ app }, type) => app.workspace.getLeavesOfType(type)[0].view.prototype.scenarios(),
        VIEW,
      );
      const seen = [];
      for (const s of scenarios) {
        await view("select", s.id);
        await view("setNarrow", true);
        await browser.pause(100);
        const primary = await primaryLabel();
        if (s.id.startsWith("fixture:")) {
          const want = states.states.find((x) => `fixture:${x.id}` === s.id).expected.primaryCta;
          expect(primary).toBe(want === null ? null : LABEL[want]);
        }
        const file = path.join(OUT, `${mode}-${s.id.replace(/[^a-z0-9-]/gi, "_")}.png`);
        await $(".openlfcp-pane").saveScreenshot(file);
        seen.push({ id: s.id, primary });
      }
      evidence("pane-prototype-scenarios", { mode, count: seen.length, out: OUT });
    });

  it("share → invite by keyboard: focus stays in the pane, the flow keeps its note", async () => {
    await theme("light");
    await view("select", "first-use");
    await browser.execute(() => document.querySelector(".openlfcp-pane-primary button")?.focus());
    await browser.keys("Enter");
    const inPane = () =>
      browser.execute(() => document.activeElement?.closest(".openlfcp-pane") !== null);
    expect(await inPane()).toBe(true);
    expect(await browser.execute(() => document.querySelector(".openlfcp-pane")?.textContent)).toContain(
      "Target: Plan.md",
    );
    // The active note changes while the preview is open: the share stays on Plan.md (T2).
    await browser.execute(() =>
      [...document.querySelectorAll(".openlfcp-pane-prototype-controls button")]
        .find((b) => b.textContent.includes("switch the active note"))
        ?.click(),
    );
    const text = await browser.execute(() => document.querySelector(".openlfcp-pane")?.textContent);
    expect(text).toContain("this stays on Plan.md");
    expect(await primaryLabel()).toBe("Share section…");
    await $(".openlfcp-pane").saveScreenshot(path.join(OUT, "flow-share-switched-note.png"));
    // Tab moves through the pane's controls without a trap; Escape does nothing to the pane.
    await browser.keys("Tab");
    expect(await inPane()).toBe(true);
    evidence("pane-prototype-keyboard", { focusInPane: true });
  });
});
