// LFCP-03-015 (U03-10, U03-11; F-02, F-C02, F-C07): Join in the Shared
// Tasks pane of a real Obsidian, without the command palette. The headless
// peer B shares a section and makes a one-time link. A opens the pane from
// the ribbon, chooses "Join with a link…": a masked field opens, no
// dialog. A pastes the link and chooses Join: the pane shows each step
// with the fact that confirms it (claim accepted, access, loaded), lists
// the section as not inserted yet and offers "Insert into a note…", which
// previews that section without a section choice (LFCP-03-016) and inserts
// it into A's note. The same link again reaches the
// section without a new claim. The link is never in the pane, a notice or
// the clipboard. Reference server at LFCP_SERVER_BIN.
import { closeModals, evidence, inA, sectionOf, startPeers, titles } from "./support/section-checks.mjs";

const VIEW = "shared-tasks-pane";
const TOOLTIP = "Open Shared Tasks pane";
const FILE = "Pane join.md";

const paneText = () => inA(() => document.querySelector(".openlfcp-pane")?.textContent ?? "");
const paneHtml = () => inA(() => document.querySelector(".openlfcp-pane")?.innerHTML ?? "");
const clickPane = (label) =>
  inA((_o, label) => {
    const b = [...document.querySelectorAll(".openlfcp-pane button")].find((x) => x.textContent === label);
    b?.click();
    return b !== undefined;
  }, label);
/** Pastes `link` into the pane's field, as a paste does (an input event), and chooses Join. */
const pasteAndJoin = (link) =>
  inA(async (_o, link) => {
    let input = null;
    for (let i = 0; i < 100 && input === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      input = document.querySelector(".openlfcp-pane input.openlfcp-pane-join-input");
    }
    if (input === null) return { field: false };
    const type = input.type;
    input.focus();
    input.value = link;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const join = [...document.querySelectorAll(".openlfcp-pane form button")].find((x) => x.textContent === "Join");
    join.click();
    return { field: true, type, cleared: input.value === "", modals: document.querySelectorAll(".modal-container").length };
  }, link);

describe("LFCP-03-015: join → insert in the pane", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
  });

  after(async () => {
    await closeModals("pane join").catch(() => undefined);
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
    await b?.stop().catch(() => undefined);
    await server?.stop();
  });

  it("joins from the pane's field, each step confirmed; inserts; the same link again makes no new claim", async () => {
    // B's section and its one-time link.
    b.files.set("B-join.md", ["## Joined from B", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n"));
    const shared = await b.share("B-join.md", "## Joined from B");
    const link = (await b.collab.invite(shared.resource, "read-write")).link.reveal();
    const secret = link.slice(link.indexOf("#secret=") + 8);

    // A's own note, open for editing, the cursor after its paragraph.
    await inA(
      async ({ app, obsidian }, file) => {
        const text = ["# Mine", "", "My own text.", ""].join("\n");
        await app.vault.create(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 2, ch: 0 });
      },
      FILE,
    );

    // The pane from the ribbon; its join entry opens a field, nothing else.
    expect(
      await inA((_o, label) => {
        const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
        icon?.click();
        return icon !== null;
      }, TOOLTIP),
    ).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    const clipboardBefore = await inA(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    expect(await clickPane("Join with a link…")).toBe(true);
    const field = await pasteAndJoin(link);
    evidence("PANE-JOIN field", field);
    expect(field.field).toBe(true);
    expect(field.type).toBe("password");
    expect(field.cleared).toBe(true);
    expect(field.modals).toBe(0);

    // Each step, as the pane shows it, until the section is joined and loaded. The step, the
    // primary button and the text from one look at the pane: the last step and the button may
    // come in the same render, and reading them apart could miss that step.
    const steps = [];
    await browser.waitUntil(
      async () => {
        const now = await inA(() => {
          const pane = document.querySelector(".openlfcp-pane");
          return {
            step: pane?.querySelector(".openlfcp-pane-step.is-current")?.textContent ?? null,
            primary: pane?.querySelector(".openlfcp-pane-primary button")?.textContent ?? null,
            text: pane?.textContent ?? "",
          };
        });
        if (now.step !== null && steps.at(-1) !== now.step) steps.push(now.step);
        return now.primary === "Insert into a note…" && now.text.includes("Not inserted yet");
      },
      { timeout: 90_000, interval: 100, timeoutMsg: "the section joined and listed as not inserted yet" },
    );
    const joined = await paneText();
    evidence("PANE-JOIN joined", { steps, text: joined.slice(0, 700) });
    expect(steps.at(-1)).toBe("Choose a note to insert it into");
    expect(joined).toContain("The server accepted the claim.");
    expect(joined).toContain("Access: read and write.");
    expect(joined).toContain("Loaded on this device.");
    expect(joined).toContain("Joined from B");
    expect(joined).not.toContain("Shared collaboration");
    expect(await paneHtml()).not.toContain(secret);

    // Insert into a note…: the joined section is the pane's subject, so no section choice
    // (LFCP-03-016); its preview, then into A's note.
    await inA(() => document.querySelector(".openlfcp-pane .openlfcp-pane-primary button")?.click());
    const picked = await inA(async () => {
      let ins;
      for (let i = 0; i < 200 && ins === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      const asked = document.querySelector(".prompt .suggestion-item") !== null;
      ins.click();
      return asked;
    });
    expect(picked).toBe(false);
    await browser.waitUntil(
      () => inA(({ app }, file) => app.vault.cachedRead(app.vault.getFileByPath(file)).then((t) => t.includes("<!-- /lfcp-section: ")), FILE),
      { timeout: 30_000, timeoutMsg: "the section inserted" },
    );
    const md = await inA(({ app }, file) => app.vault.cachedRead(app.vault.getFileByPath(file)), FILE);
    expect(md).toContain("My own text.");
    expect(titles(sectionOf(md))).toEqual(["Alpha", "Beta"]);
    expect(await paneText()).not.toContain("Joining with a link");

    // The same link again: the section, no new claim.
    expect(await clickPane("Join with a link…")).toBe(true);
    await pasteAndJoin(link);
    await browser.waitUntil(async () => (await paneText()).includes("This vault had already joined this section. No new claim was made."), {
      timeout: 30_000,
      timeoutMsg: "already joined",
    });
    expect(await clickPane("Later")).toBe(true);

    const notices = await inA(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent));
    for (const n of notices) expect(n).not.toContain(secret);
    expect(await paneHtml()).not.toContain(secret);
    // Nothing was read from or put on the clipboard.
    const clipboardAfter = await inA(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    expect(clipboardAfter).toBe(clipboardBefore);
  });
});
