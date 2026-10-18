// LFCP-03-019 (U03-15, U03-17, U03-19; F-01): access, copy and detach from
// the Shared Tasks pane of a real Obsidian, without the command palette. A
// shares a section; the headless peers B and C join it. With the cursor in
// A's copy, the pane says this vault's rights and the access list's
// freshness, and what deleting, removing the copy and detaching do (N-05).
// "Copy readable text" and "Copy shared section" copy A's copy (without and
// with its bindings). "Remove access…" opens the card; C is removed there,
// after its confirmation: C is told it is removed, B keeps its access.
// "Detach this section" from the pane's menu asks first, then unbinds A's
// note only: B's access and C's removal stay as they were. Reference server
// at LFCP_SERVER_BIN.
import { peer } from "../peer.bundle.mjs";
import { closeModals, evidence, inA, inviteFromA, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const VIEW = "shared-tasks-pane";
const TOOLTIP = "Open Shared Tasks pane";
const FILE = "Pane access.md";
const HEADING = "## Pane access";
const TEXT = [HEADING, "- [ ] Alpha", "- [ ] Beta", "", "A paragraph.", ""].join("\n");
const BODY_DELETE = "Deleting text inside this section deletes it for everyone who has this section.";
const WHOLE_COPY = "Removing this whole copy from the note, or deleting the note, removes only this copy.";
const DETACH = "Detach this section keeps its text here as your own. The shared section, its other copies and everyone's access stay as they are.";
const CONFIRM = "Its text stays in this note as your own and no longer updates. The shared section, your other notes, your collaborators and their access are not changed.";
const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));

const paneText = () => inA(() => document.querySelector(".openlfcp-pane")?.textContent ?? "");
/** The pane's button for action `id`: its label and whether it is enabled. */
const paneButton = (id) =>
  inA((_o, id) => {
    const b = document.querySelector(`.openlfcp-pane button[data-action="${id}"]`);
    return b === null ? null : { label: b.textContent, enabled: b.getAttribute("aria-disabled") !== "true" };
  }, id);
const clickPane = (id) =>
  inA((_o, id) => {
    // A destructive action sits in "More actions": opened first, as a user does.
    const menu = document.querySelector(".openlfcp-pane details.openlfcp-pane-menu");
    if (menu !== null) menu.open = true;
    const b = document.querySelector(`.openlfcp-pane button[data-action="${id}"]`);
    b?.click();
    return b !== null;
  }, id);
const modalWith = (part) =>
  browser.waitUntil(
    () => inA((_o, part) => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 30_000, timeoutMsg: `a dialog with "${part}"` },
  );
const clickIn = (part, label) =>
  inA(
    (_o, part, label) => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes(part));
      const b = m && [...m.querySelectorAll("button")].find((x) => x.textContent === label || x.getAttribute("aria-label") === label);
      b?.click();
      return b !== undefined && b !== null;
    },
    part,
    label,
  );
const noteA = () => inA(({ app }, file) => app.vault.adapter.read(file), FILE);

describe("LFCP-03-019: access, copy and detach from the pane", () => {
  let server;
  let b;
  let c;

  before(async () => {
    ({ server, b } = await startPeers());
    c = await peer(server.url);
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
  });

  after(async () => {
    await closeModals("pane access").catch(() => undefined);
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
    await inA(() => {
      if (window.__lfcpClipboard !== undefined) navigator.clipboard.writeText = window.__lfcpClipboard;
    }).catch(() => undefined);
    await c?.stop().catch(() => undefined);
    await b?.stop().catch(() => undefined);
    await server?.stop();
  });

  it("says rights and effects, copies, removes C's access and detaches A's copy, all from the pane", async () => {
    const { R } = await shareAndJoin(b, FILE, HEADING, TEXT, true);
    // C joins with an invitation of its own.
    await closeModals("before C's invitation");
    const link = await inviteFromA("Pane access");
    c.files.set("C.md", ["# C", "", "Insert below.", ""].join("\n"));
    await c.joinAndInsert(link, "C.md", 3);
    const accessOf = async (p) => {
      const s = await p.runtime.sectionAccessState(bytes(R));
      return { allowed: s.allowed, abilities: [...s.abilities].sort() };
    };
    const bBefore = await accessOf(b);
    expect(bBefore.allowed).toBe(true);
    expect((await accessOf(c)).allowed).toBe(true);

    // A's cursor in its copy, on "Alpha"; the pane from the ribbon (no palette).
    await inA(
      async ({ app, obsidian }, file) => {
        const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file) ?? app.workspace.getLeaf(false);
        if (leaf.view.file?.path !== file) await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("- [ ] Alpha"));
        view.editor.setCursor({ line, ch: 7 });
      },
      FILE,
    );
    expect(
      await inA((_o, label) => {
        const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
        icon?.click();
        return icon !== null;
      }, TOOLTIP),
    ).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    // Rights, the access list's freshness, and what changes do: before anything is done.
    await browser.waitUntil(
      async () => {
        const t = await paneText();
        return t.includes("You can edit this section.") && t.includes("Access verified with the server") && (await paneButton("remove-access"))?.enabled === true;
      },
      { timeout: 60_000, timeoutMsg: "the pane with A's rights, freshness and Remove access…" },
    );
    const before = await paneText();
    evidence("PANE-ACCESS facts", { text: before.slice(0, 900) });
    for (const s of [BODY_DELETE, WHOLE_COPY, DETACH]) expect(before).toContain(s);

    // Copy readable text and Copy shared section, from the pane: A's copy, without and with bindings.
    await inA(() => {
      window.__lfcpClipboard = navigator.clipboard.writeText;
      window.__lfcpCopied = [];
      navigator.clipboard.writeText = async (t) => {
        window.__lfcpCopied.push(t);
      };
    });
    expect(await clickPane("copy-readable")).toBe(true);
    expect(await clickPane("copy-shared-section")).toBe(true);
    const copied = await browser.waitUntil(
      () => inA(() => (window.__lfcpCopied.length >= 2 ? window.__lfcpCopied : false)),
      { timeout: 10_000, timeoutMsg: "two copies" },
    );
    evidence("PANE-COPY", { readable: copied[0], shared: copied[1].slice(0, 300) });
    expect(copied[0]).toContain("- [ ] Alpha");
    expect(copied[0]).not.toContain("lfcp-");
    expect(copied[1]).toContain("<!-- lfcp-section: ");
    expect(copied[1]).toContain("<!-- /lfcp-section: ");

    // Remove access… opens the card; C's row, its confirmation, then the revocation.
    expect(await clickPane("remove-access")).toBe(true);
    const cLabel = `Member ${hex(c.principal).slice(0, 8)}`;
    await modalWith(cLabel).catch(async (error) => {
      // The card without C's row: what it lists, and when it last verified access.
      evidence("PANE-REMOVE no row", {
        member: cLabel,
        cAllowed: (await accessOf(c)).allowed,
        notices: await inA(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 200))),
        cards: await inA(() => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent.slice(0, 1500))),
      });
      throw error;
    });
    expect(await clickIn(cLabel, `Remove access for ${cLabel}`)).toBe(true);
    const confirm = await modalWith(`Remove access: ${cLabel}`);
    evidence("PANE-REMOVE confirm", { text: confirm });
    expect(confirm).toContain("Copies already received cannot be erased.");
    expect(await clickIn(`Remove access: ${cLabel}`, "Remove access")).toBe(true);
    await browser.waitUntil(async () => !(await accessOf(c)).allowed, { timeout: 60_000, timeoutMsg: "C removed" });
    await closeModals("remove access from the pane");
    // C keeps its copy; B keeps its access.
    expect(c.files.get("C.md")).toContain("- [ ] Alpha");
    expect(await accessOf(b)).toEqual(bBefore);

    // Detach this section, from the pane's menu: asked first, then A's note only.
    await browser.waitUntil(async () => (await paneButton("detach-section"))?.enabled === true, { timeout: 20_000, timeoutMsg: "Detach enabled" });
    expect(await clickPane("detach-section")).toBe(true);
    const asked = await modalWith('Detach "Pane access" in this note');
    expect(asked).toContain(CONFIRM);
    expect(await clickIn('Detach "Pane access" in this note', "Detach")).toBe(true);
    const detached = await browser.waitUntil(
      async () => {
        const t = await noteA();
        return t.includes("lfcp-") ? false : t;
      },
      { timeout: 20_000, timeoutMsg: "A's copy detached" },
    );
    evidence("PANE-DETACH", { note: detached });
    expect(detached).toContain("- [ ] Alpha");
    // Nobody's access changed: B's as before, C still removed.
    expect(await accessOf(b)).toEqual(bBefore);
    expect((await accessOf(c)).allowed).toBe(false);
  });
});
