// LFCP-03-018 (U03-16, U03-25; F-04): the problem hub of the Shared Tasks
// pane in a real Obsidian, run from the pane, without the command palette.
// Vault A is real Obsidian, B the headless peer, the reference server at
// LFCP_SERVER_BIN. Setup (share, join) uses the existing commands; every
// step of the problem flow is a click in the pane or in its resolver.
//
// - A's copy loses its end marker and A edits a Task in it, the cursor in
//   that section: the card is that problem, said once (issue #87): its
//   reason on the card, "Repair shared sections…" its one button, no row
//   saying it again; B does not get the edit.
// - That button opens the repair on that item; the user picks the line and
//   applies it: the marker is written in A's note.
// - The card's problem goes because the facts changed (the note parses
//   clean), the section is current again, and B's note shows the held edit.
// - A heading inside the section: its row says so with its line, and "Go to
//   the problem" puts the cursor there; nothing is written.
import { closeModals, evidence, inA, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const FILE = "Hub.md";
const NOTE = ["## Hub", "", "- [ ] Alpha", "- [ ] Beta", "", "## Later", ""].join("\n");
const TOOLTIP = "Open Shared Tasks pane";
let server;
let b;
let bFile;

/** The open note's text, cursor and badge. */
const stateA = () =>
  inA(({ app, obsidian }, file) => {
    const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
    const view = leaf?.view;
    if (!(view instanceof obsidian.MarkdownView)) return null;
    return {
      md: view.editor.getValue(),
      cursor: view.editor.getCursor().line,
      badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
    };
  }, FILE);

/** An edit of the note as a user's (replaceRange: a user transaction to the engine). */
const editA = (fn) =>
  inA(
    ({ app, obsidian }, src, file) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const next = new Function("md", `return (${src})(md)`)(view.editor.getValue());
      view.editor.replaceRange(next, { line: 0, ch: 0 }, { line: view.editor.lineCount(), ch: 0 });
      view.editor.setCursor({ line: 0, ch: 0 });
    },
    fn.toString(),
    FILE,
  );

/** The pane's problem rows: id, text, source line and its button's label. */
const rows = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".openlfcp-pane li.openlfcp-pane-problem")].map((li) => ({
      id: li.dataset.problem,
      text: li.querySelector(".openlfcp-pane-problem-text")?.textContent ?? null,
      source: li.querySelector(".openlfcp-pane-row-meta")?.textContent ?? null,
      button: li.querySelector("button")?.textContent ?? null,
    })),
  );

/** The pane's card: its fact, its primary's label, and every button the pane draws with a label. */
const cardA = () =>
  browser.execute(() => {
    const pane = document.querySelector(".openlfcp-pane");
    return {
      fact: pane?.querySelector(".openlfcp-pane-card .openlfcp-pane-fact")?.textContent ?? null,
      primary: pane?.querySelector(".openlfcp-pane-primary button")?.textContent ?? null,
      buttons: [...(pane?.querySelectorAll("button") ?? [])].map((x) => x.textContent),
    };
  });

const rowWith = (re, msg) =>
  browser.waitUntil(
    async () => (await rows()).find((r) => re.test(r.text ?? "")) ?? false,
    { timeout: 30_000, timeoutMsg: msg },
  );

/** Clicks the button of the problem row `id` in the pane (a DOM click, as a user's). */
const pressRow = (id) =>
  browser.execute((id) => {
    const b = [...document.querySelectorAll(".openlfcp-pane button[data-problem]")].find((x) => x.dataset.problem === id);
    if (b === undefined) return false;
    b.click();
    return true;
  }, id);

describe("LFCP-03-018: the pane's problem hub leads to the resolver", () => {
  before(async () => {
    ({ server, b } = await startPeers());
    ({ bFile } = await shareAndJoin(b, FILE, "## Hub", NOTE, true));
    await browser.waitUntil(async () => (await stateA())?.badge === "CURRENT", {
      timeout: 30_000,
      timeoutMsg: "the shared section current",
    });
    // The pane, from its ribbon icon (not the palette).
    await browser.execute((label) => document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`)?.click(), TOOLTIP);
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
  });

  after(async () => {
    await closeModals("problem hub");
    await b?.stop();
    await server?.stop();
  });

  it("U03-16: a damaged boundary at the cursor is the card, said once; repaired from its button, the held edit reaches B", async () => {
    await editA((md) =>
      md
        .split("\n")
        .filter((l) => !l.startsWith("<!-- /lfcp-section: "))
        .join("\n")
        .replace("- [ ] Alpha", "- [ ] Alpha edited while damaged"),
    );
    // The cursor is in the damaged section: its problem is the card, with its fix as the primary.
    const card = await browser.waitUntil(
      async () => {
        const c = await cardA();
        return /start marker and no end/.test(c.fact ?? "") && c.primary !== null ? c : false;
      },
      { timeout: 30_000, timeoutMsg: "the damaged boundary on the pane's card" },
    );
    const damaged = (await stateA()).md;
    const start = damaged.split("\n").findIndex((l) => l.startsWith("<!-- lfcp-section: "));
    expect(card.primary).toBe("Repair shared sections…");
    // Issue #87: one cause, one line, one button: no row says it again.
    expect((await rows()).filter((r) => /start marker and no end/.test(r.text ?? ""))).toEqual([]);
    expect(card.buttons.filter((x) => x === "Repair shared sections…")).toHaveLength(1);
    // Held: B does not get the edit while the boundary is damaged.
    await browser.pause(3000);
    await b.pass(bFile);
    expect(b.files.get(bFile)).not.toContain("Alpha edited while damaged");

    expect(
      await browser.execute(() => {
        const x = document.querySelector(".openlfcp-pane .openlfcp-pane-primary button");
        x?.click();
        return x !== null;
      }),
    ).toBe(true);
    const repair = await browser.waitUntil(
      () =>
        browser.execute(() => {
          const m = document.querySelector(".openlfcp-repair");
          if (m === null) return false;
          return {
            items: [...m.querySelectorAll(".openlfcp-repair-item > p")].map((p) => p.textContent),
            choices: [...m.querySelectorAll(".openlfcp-repair-choice")].map((c) => c.textContent.trim()),
          };
        }),
      { timeout: 10_000, timeoutMsg: "the repair opened from the pane" },
    );
    evidence("problem-hub-repair-opened", { card, repair });
    expect(repair.items[0]).toMatch(new RegExp(`section starting on line ${start + 1} has no end`));
    // The user picks the line after the last Task's lines, before "## Later", and applies it.
    const later = damaged.split("\n").indexOf("## Later");
    const pick = repair.choices.filter((c) => Number(/^After line (\d+):/.exec(c)?.[1] ?? 0) < later + 1).at(-1);
    expect(pick).toBeDefined();
    await browser.execute((pick) => {
      const m = document.querySelector(".openlfcp-repair");
      const label = [...m.querySelectorAll(".openlfcp-repair-choice")].find((c) => c.textContent.trim() === pick);
      label.querySelector("input").click();
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Apply").click();
    }, pick);
    await browser.waitUntil(async () => (await stateA()).md.includes("<!-- /lfcp-section: "), {
      timeout: 10_000,
      timeoutMsg: "the end marker written in A's note",
    });
    // The facts change, not the click: the problem goes once the note parses clean, and the section is current.
    await browser.waitUntil(async () => !/start marker and no end/.test((await cardA()).fact ?? ""), {
      timeout: 20_000,
      timeoutMsg: "the card's problem gone after the repair",
    });
    await browser.waitUntil(async () => (await stateA()).badge === "CURRENT", {
      timeout: 30_000,
      timeoutMsg: "current after the repair",
    });
    // The peer's outcome: B's note shows the edit that was held.
    await browser.waitUntil(
      async () => {
        await b.pass(bFile);
        return b.files.get(bFile).includes("Alpha edited while damaged");
      },
      { timeout: 30_000, timeoutMsg: "B got the held edit after the repair" },
    );
    evidence("problem-hub-repaired", { rows: await rows(), badge: (await stateA()).badge, b: b.files.get(bFile).split("\n") });
  });

  it("U03-25: a heading inside the section is listed with its line; Go to the problem goes there, writing nothing", async () => {
    // Just above the end marker: no Task loses its binding line.
    await editA((md) => md.replace("\n<!-- /lfcp-section: ", "\n### Inside\n<!-- /lfcp-section: "));
    const row = await rowWith(/cannot be shared by this version/, "the unsupported content listed");
    const md = (await stateA()).md;
    const line = md.split("\n").indexOf("### Inside");
    expect(row.source).toBe(`Where: ${FILE}, line ${line + 1}`);
    expect(row.button).toBe("Go to the problem");
    expect(await pressRow(row.id)).toBe(true);
    await browser.waitUntil(async () => (await stateA()).cursor === line, {
      timeout: 10_000,
      timeoutMsg: "the cursor on the heading inside",
    });
    expect((await stateA()).md).toBe(md);
    expect(await browser.execute(() => document.querySelectorAll(".modal-container").length)).toBe(0);
    evidence("problem-hub-go-to", { row, line });
    // Undone: the row goes with the heading.
    await editA((m) => m.replace("\n### Inside\n", "\n"));
    await browser.waitUntil(async () => !(await rows()).some((r) => r.id === row.id), {
      timeout: 20_000,
      timeoutMsg: "the row gone with the heading",
    });
  });
});
