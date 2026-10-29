// LFCP-03-012 (U03-01, U03-20): the Shared Tasks pane in a real Obsidian,
// opened without the command palette. Status: NOT_RUN when it was written
// (the native workflow is manual; its first run is in CI after LFCP-03-031).
//
// - The ribbon icon, clicked in the DOM, opens the pane in one leaf; a
//   second click and the command reveal that leaf, never a second one.
// - The pane shows "Join with a link…" with no wizard or dialog opened.
// - A second leaf of the pane (as a restored or split layout makes it) is
//   closed at the next layout change: one pane per workspace.
// - Closed and opened again, the pane draws once more (no stale view).
// - LFCP-03-021: on a vault with no shared section the pane leads to share
//   and join, with the first-use tip; "Hide tip" keeps only its ID in the
//   plugin's settings, "Show tips again" brings it back; no dialog opens.

const VIEW = "shared-tasks-pane";
const TOOLTIP = "Open Shared Tasks pane";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);

const leaves = () =>
  browser.executeObsidian(({ app }, type) => app.workspace.getLeavesOfType(type).length, VIEW);

const paneText = () =>
  browser.execute(() => document.querySelector(".openlfcp-pane")?.textContent ?? null);

const clickRibbon = () =>
  browser.execute((label) => {
    const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
    if (icon === null) return false;
    icon.click();
    return true;
  }, TOOLTIP);

describe("LFCP-03-012: Shared Tasks pane host", () => {
  before(() =>
    browser.executeObsidian(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW),
  );

  after(() =>
    browser.executeObsidian(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW),
  );

  it("opens from the ribbon in one leaf; the ribbon again and the command reveal it", async () => {
    expect(await leaves()).toBe(0);
    expect(await clickRibbon()).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    expect(await leaves()).toBe(1);
    expect(await clickRibbon()).toBe(true);
    await browser.executeObsidianCommand("shared-tasks:open-pane");
    await browser.pause(300);
    expect(await leaves()).toBe(1);
    const text = await paneText();
    expect(text).toContain("Join with a link…");
    expect(text).not.toMatch(/protocol|wizard/i);
    const modals = await browser.execute(() => document.querySelectorAll(".modal").length);
    expect(modals).toBe(0);
    evidence("pane-host-ribbon", { leaves: 1, modals });
  });

  it("LFCP-03-021: first use leads to share and join; a tip hides and comes back", async () => {
    const tip = () =>
      browser.execute(
        () => document.querySelector(".openlfcp-pane .openlfcp-pane-hint")?.dataset.hint ?? null,
      );
    await browser.waitUntil(async () => (await tip()) !== null, {
      timeout: 15_000,
      timeoutMsg: "no tip in the pane",
    });
    const text = await paneText();
    expect(text).toContain("No shared sections on this device yet. Share one from a note, or join one with a link.");
    expect(await tip()).toBe("first-use");
    const settings = () =>
      browser.executeObsidian(({ app }) => {
        const p = app.plugins.plugins["shared-tasks"];
        return { ...p.settings, dismissedHints: [...p.settings.dismissedHints] };
      });
    const before = await settings();
    const click = (label) =>
      browser.execute((l) => {
        const b = [...document.querySelectorAll(".openlfcp-pane button")].find((x) => x.textContent === l);
        b?.click();
        return b !== undefined;
      }, label);
    expect(await click("Hide tip")).toBe(true);
    await browser.waitUntil(async () => (await tip()) === null, { timeout: 5_000 });
    const hidden = await settings();
    expect(hidden.dismissedHints).toEqual(["first-use"]);
    expect({ ...hidden, dismissedHints: before.dismissedHints }).toEqual(before);
    expect(await click("Show tips again")).toBe(true);
    await browser.waitUntil(async () => (await tip()) === "first-use", { timeout: 5_000 });
    expect((await settings()).dismissedHints).toEqual([]);
    expect(await browser.execute(() => document.querySelectorAll(".modal").length)).toBe(0);
    evidence("pane-first-use-tip", { hidden: hidden.dismissedHints, restored: true });
  });

  it("keeps one pane when a second leaf of it appears", async () => {
    await browser.executeObsidian(async ({ app }, type) => {
      const leaf = app.workspace.getRightLeaf(true);
      await leaf.setViewState({ type });
    }, VIEW);
    await browser.pause(500);
    expect(await leaves()).toBe(1);
  });

  it("closed and opened again, it draws anew", async () => {
    await browser.executeObsidian(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
    await browser.pause(200);
    expect(await leaves()).toBe(0);
    expect(await clickRibbon()).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    expect(await leaves()).toBe(1);
    expect(await browser.execute(() => document.querySelectorAll(".openlfcp-pane").length)).toBe(1);
  });
});
