// LFCP-03-016 (U03-12, U03-13, U03-15): "Insert into a note…" from the
// Shared Tasks pane of a real Obsidian, without the command palette. A
// shares a section from the pane; from another note the pane's "Insert into
// a note…" picks it, the preview names the notes that already hold it,
// "Choose another note…" sends it to the end of a closed note, and the
// result notice's "Open" opens that note at the section. A second insertion
// goes into a new note named in the choice, created without touching any
// other note. Reference server at LFCP_SERVER_BIN.
import { closeModals, evidence, inA, startPeers } from "./support/section-checks.mjs";

const VIEW = "shared-tasks-pane";
const TOOLTIP = "Open Shared Tasks pane";
const SOURCE = "Insert source.md";
const SOURCE_TEXT = ["## Insert source", "- [ ] Alpha", "- [ ] Beta", "", "## After", "Private tail.", ""].join("\n");
const START = "Insert start.md";
const START_TEXT = ["# Start", "", "Private start text.", ""].join("\n");
const CLOSED = "Insert closed.md";
const CLOSED_TEXT = ["# Closed", "", "Keep me as I am.", ""].join("\n");
const FRESH = "Insert fresh.md";

const paneButton = (id) =>
  inA((_o, id) => {
    const b = document.querySelector(`.openlfcp-pane button[data-action="${id}"]`);
    return b === null ? null : { label: b.textContent, disabled: b.getAttribute("aria-disabled") === "true" };
  }, id);
const clickPane = (id) => inA((_o, id) => document.querySelector(`.openlfcp-pane button[data-action="${id}"]`)?.click(), id);
const modalWith = (part) =>
  browser.waitUntil(
    () => inA((_o, part) => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 30_000, timeoutMsg: `a dialog with "${part}"` },
  );
const clickIn = (part, label) =>
  inA(
    (_o, part, label) => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes(part));
      const b = m && [...m.querySelectorAll("button")].find((x) => x.textContent === label);
      b?.click();
      return b !== undefined && b !== null;
    },
    part,
    label,
  );
/** Types `query` into the open suggestion prompt and clicks the item whose text starts with `item`. */
const suggest = (query, item) =>
  browser.waitUntil(
    () =>
      inA(
        async (_o, query, item) => {
          const input = document.querySelector(".prompt .prompt-input");
          if (input === null) return false;
          if (input.value !== query) {
            input.value = query;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise((r) => setTimeout(r, 100));
          }
          const found = [...document.querySelectorAll(".prompt .suggestion-item")].find((x) => x.textContent.startsWith(item));
          found?.click();
          return found !== undefined;
        },
        query,
        item,
      ),
    { timeout: 20_000, timeoutMsg: `the suggestion "${item}"` },
  );
/**
 * The section choice, when the insert asks for one: the pane passes the
 * section it is about (D9: the one chosen in its list), which needs none.
 */
const pickIfAsked = async () => {
  const asked = await browser.waitUntil(
    () =>
      inA(() => {
        if ([...document.querySelectorAll(".modal-container .modal")].some((m) => m.textContent.includes('Insert section "Insert source"'))) return "preview";
        return document.querySelector(".prompt .suggestion-item") === null ? false : "pick";
      }),
    { timeout: 30_000, timeoutMsg: "the section choice or the insert preview" },
  );
  evidence("PANE-INSERT asked", { asked });
  if (asked === "pick") await suggest("", "Insert source");
};
const open = (file, line) =>
  inA(
    async ({ app, obsidian }, file, line) => {
      // A new tab: the pane follows the active leaf (T1).
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() === ""; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line, ch: 0 });
    },
    file,
    line,
  );
/**
 * Waits until the pane is about `file`. The card no longer names the note (UXD-11): the pane
 * follows the last active Markdown note (T1), so the note is the active one and the pane has
 * drawn since (its redraws are coalesced over 100 ms).
 */
const paneOn = async (file) => {
  await browser.waitUntil(
    () => inA(({ app, obsidian }, file) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.file?.path === file, file),
    { timeout: 20_000, timeoutMsg: `the note ${file} active` },
  );
  await browser.pause(400);
  await $(".openlfcp-pane .openlfcp-pane-card").waitForExist({ timeout: 20_000, timeoutMsg: `the pane's card on ${file}` });
};
const read = (file) => inA(({ app }, file) => app.vault.adapter.read(file), file);
const noticeWith = (part) =>
  browser.waitUntil(
    () => inA((_o, part) => [...document.querySelectorAll(".notice")].map((n) => n.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 30_000, timeoutMsg: `a notice with "${part}"` },
  );

describe("LFCP-03-016: insert into a chosen note from the pane", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
  });

  after(async () => {
    await closeModals("pane insert").catch(() => undefined);
    await inA(({ app }, type) => app.workspace.detachLeavesOfType(type), VIEW);
    await b?.stop().catch(() => undefined);
    await server?.stop();
  });

  it("shares from the pane, inserts into a closed note and into a new one, each result with Open", async () => {
    await inA(
      async ({ app }, files) => {
        for (const [file, text] of files) await app.vault.create(file, text);
      },
      [
        [SOURCE, SOURCE_TEXT],
        [START, START_TEXT],
        [CLOSED, CLOSED_TEXT],
      ],
    );
    // The pane, from the ribbon; the section shared from it.
    await open(SOURCE, 0);
    expect(
      await inA((_o, label) => {
        const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
        icon?.click();
        return icon !== null;
      }, TOOLTIP),
    ).toBe(true);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await paneButton("share-section"))?.disabled === false, { timeout: 20_000, timeoutMsg: "Share section… in the pane" });
    await clickPane("share-section");
    await modalWith('Share section "Insert source"');
    expect(await clickIn('Share section "Insert source"', "Share")).toBe(true);
    await browser.waitUntil(async () => (await read(SOURCE)).includes("<!-- /lfcp-section: "), { timeout: 60_000, timeoutMsg: "the section shared" });

    // From the start note: Insert into a note… → the section → its preview.
    await open(START, 2);
    await paneOn(START);
    await browser.waitUntil(async () => (await paneButton("insert-into-note"))?.disabled === false, { timeout: 30_000, timeoutMsg: "Insert into a note… in the pane" });
    await clickPane("insert-into-note");
    await pickIfAsked();
    let preview = await modalWith('Insert section "Insert source"');
    evidence("PANE-INSERT preview", { text: preview.slice(0, 400) });
    expect(preview).toContain("These lines go into this note after the paragraph at the cursor.");
    await browser.waitUntil(async () => (await modalWith('Insert section "Insert source"')).includes("Already in: Insert source."), {
      timeout: 10_000,
      timeoutMsg: "the existing placement named",
    });

    // Choose another note…: the closed note, at its end.
    expect(await clickIn('Insert section "Insert source"', "Choose another note…")).toBe(true);
    await suggest("Insert closed", "Insert closed.md: at its end");
    preview = await browser.waitUntil(
      async () => {
        const t = await modalWith('Insert section "Insert source"');
        return t.includes('at the end of "Insert closed"') ? t : false;
      },
      { timeout: 10_000, timeoutMsg: "the preview naming the closed note" },
    );
    expect(await clickIn('Insert section "Insert source"', "Insert")).toBe(true);
    const done = await noticeWith('inserted into "Insert closed"');
    evidence("PANE-INSERT closed", { notice: done });
    const closed = await read(CLOSED);
    expect(closed.startsWith(`${CLOSED_TEXT}\n## Insert source\n<!-- lfcp-section: `)).toBe(true);
    expect(closed).toContain("- [ ] Alpha");
    expect(await read(START)).toBe(START_TEXT);
    // Open: the closed note, at the section.
    await inA(() => {
      const n = [...document.querySelectorAll(".notice")].find((x) => x.textContent.includes('inserted into "Insert closed"'));
      [...n.querySelectorAll("button")].find((x) => x.textContent === "Open")?.click();
    });
    await browser.waitUntil(async () => (await inA(({ app }) => app.workspace.getActiveFile()?.path)) === CLOSED, {
      timeout: 10_000,
      timeoutMsg: "Open opened the note",
    });

    // Again, from the start note: a new note named in the choice.
    await open(START, 2);
    await paneOn(START);
    await browser.waitUntil(async () => (await paneButton("insert-into-note"))?.disabled === false, { timeout: 30_000, timeoutMsg: "Insert into a note… again" });
    await clickPane("insert-into-note");
    await pickIfAsked();
    await browser.waitUntil(async () => (await modalWith('Insert section "Insert source"')).includes("Insert closed"), {
      timeout: 10_000,
      timeoutMsg: "both placements named",
    });
    expect(await clickIn('Insert section "Insert source"', "Choose another note…")).toBe(true);
    await suggest("Insert fresh", 'Create note "Insert fresh"');
    await browser.waitUntil(async () => (await modalWith('Insert section "Insert source"')).includes('into a new note "Insert fresh"'), {
      timeout: 10_000,
      timeoutMsg: "the preview naming the new note",
    });
    expect(await clickIn('Insert section "Insert source"', "Insert")).toBe(true);
    await noticeWith('inserted into "Insert fresh"');
    const fresh = await read(FRESH);
    evidence("PANE-INSERT new", { text: fresh.slice(0, 200) });
    expect(fresh.startsWith("## Insert source\n<!-- lfcp-section: ")).toBe(true);
    expect(await read(CLOSED)).toBe(closed);
    expect(await read(START)).toBe(START_TEXT);
  });
});
