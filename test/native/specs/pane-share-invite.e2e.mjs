// LFCP-03-014 (U03-04, U03-05, U03-08; F-02, F-07): Share and Invite as one
// journey in the Shared Tasks pane of a real Obsidian, without the command
// palette. A opens the pane from the ribbon; with the cursor on a private
// heading the pane shows the share preview (counts, the sync server) and
// "Share section…"; its dialog says the server too; once the section is on
// its server the pane says "ready to invite" and offers "Invite
// collaborator…"; the role is chosen in its dialog; the invitation dialog
// says the one-time link rule (D2) and keeps the link hidden until "Show
// link"; "Copy link" makes the pane say "Link copied" (when the system
// clipboard takes it). The headless peer B claims the link and holds the
// section. Reference server at LFCP_SERVER_BIN.
import { closeModals, evidence, inA, sectionOf, startPeers, titles } from "./support/section-checks.mjs";

const VIEW = "shared-tasks-pane";
const TOOLTIP = "Open Shared Tasks pane";
const D2 = "One-time link, does not expire; whoever opens it first joins.";
const FILE = "Pane journey.md";
const TEXT = ["## Pane journey", "- [ ] Alpha", "- [ ] Beta", "", "A paragraph.", "", "## Later", "Private tail.", ""].join("\n");

const paneText = () => inA(() => document.querySelector(".openlfcp-pane")?.textContent ?? "");
const primary = () =>
  inA(() => {
    const b = document.querySelector(".openlfcp-pane .openlfcp-pane-primary button");
    return b === null ? null : { label: b.textContent, disabled: b.getAttribute("aria-disabled") === "true" };
  });
const clickPrimary = () => inA(() => document.querySelector(".openlfcp-pane .openlfcp-pane-primary button")?.click());
/** The open modal whose text contains `part`, its text. */
const modalWith = (part) =>
  browser.waitUntil(
    () => inA((part) => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 30_000, timeoutMsg: `a dialog with "${part}"` },
  );
const clickIn = (part, label) =>
  inA(
    (part, label) => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes(part));
      const b = m && [...m.querySelectorAll("button")].find((x) => x.textContent === label);
      b?.click();
      return b !== undefined && b !== null;
    },
    part,
    label,
  );

describe("LFCP-03-014: share → invite in the pane", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
  });

  after(async () => {
    await closeModals("pane share-invite").catch(() => undefined);
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
    await b?.stop().catch(() => undefined);
    await server?.stop();
  });

  it("previews the heading with its server, shares, says ready, invites with an explicit role; B claims", async () => {
    // A's note, open for editing, the cursor on its heading.
    await inA(
      async ({ app, obsidian }, file, text) => {
        await app.vault.create(file, text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 0, ch: 3 });
      },
      FILE,
      TEXT,
    );
    // The pane, from the ribbon (no palette).
    expect(
      await inA((label) => {
        const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
        icon?.click();
        return icon !== null;
      }, TOOLTIP),
    ).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await primary())?.label === "Share section…", { timeout: 20_000, timeoutMsg: "Share section… in the pane" });
    const before = await paneText();
    evidence("PANE-SHARE preview", { text: before.slice(0, 600) });
    expect(before).toContain("2 tasks, 1 paragraph, 0 list items.");
    expect(before).toContain(`Sync server: ${server.url}.`);
    expect(before).not.toContain("Private tail.");

    // Share section… → its dialog (the review, with the same server) → Share.
    await clickPrimary();
    const dialog = await modalWith('Share section "Pane journey"');
    expect(dialog).toContain(`Sync server: ${server.url}.`);
    expect(await clickIn('Share section "Pane journey"', "Share")).toBe(true);

    // On its server, access checked: the pane says so; its next step is Invite.
    await browser.waitUntil(
      async () => (await primary())?.label === "Invite collaborator…" && (await paneText()).includes("Shared and on its sync server: ready to invite."),
      { timeout: 90_000, timeoutMsg: "the pane ready to invite" },
    );
    // Nothing was sent by itself: no invitation dialog before the click.
    expect(await inA(() => [...document.querySelectorAll(".modal")].some((m) => m.textContent.includes("Invitation (")))).toBe(false);

    // Invite collaborator… → the role (explicit) → the invitation dialog.
    await clickPrimary();
    const roles = await browser.waitUntil(
      () => inA(() => {
        const items = [...document.querySelectorAll(".prompt .suggestion-item")].map((x) => x.textContent);
        return items.length > 0 ? items : false;
      }),
      { timeout: 20_000, timeoutMsg: "the role choice" },
    );
    evidence("PANE-INVITE roles", { roles });
    expect(roles.length).toBe(2);
    for (const r of roles) expect(r).toContain(D2);
    expect(await paneText()).toContain(D2);
    await inA(() => [...document.querySelectorAll(".prompt .suggestion-item")].find((x) => x.textContent.startsWith("Read + write"))?.click());
    const invitation = await modalWith("Invitation (");
    expect(invitation).toContain(D2);
    expect(invitation).toContain("treat it like a password");
    // Hidden until Show link.
    expect(invitation).not.toContain("lfcp://join/");
    expect(await paneText()).toContain("Copy or show the link in the invitation dialog.");
    const copied = await inA(async () => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes("Invitation ("));
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Copy link").click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const notices = [...document.querySelectorAll(".notice")].map((n) => n.textContent);
        if (notices.some((n) => n.includes("link copied"))) return true;
        if (notices.some((n) => n.includes("could not copy"))) return false;
      }
      return null;
    });
    evidence("PANE-INVITE copy", { copied });
    if (copied === true) expect(await paneText()).toContain("Link copied");
    const link = await inA(() => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes("Invitation ("));
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const value = m.querySelector("input").value;
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return value;
    });
    expect(link.startsWith("lfcp://join/")).toBe(true);
    const after = await paneText();
    expect(after).not.toContain("lfcp://join/");
    expect(after.toLowerCase()).not.toContain("invitation sent");
    expect(after.toLowerCase()).not.toContain("invited");

    // B claims the one-time link and holds the section A shared.
    b.files.set("From A.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert(link, "From A.md", 2);
    const got = titles(sectionOf(b.files.get("From A.md")));
    evidence("PANE-INVITE claimed", { titles: got });
    expect(got.length).toBe(2);
    expect(got[0]).toMatch(/^Alpha\b/);
    expect(got[1]).toMatch(/^Beta\b/);
  });
});
