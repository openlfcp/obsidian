// The MVP 0.3 baseline review, F-03 and F-04, in real Obsidian with the
// headless peer B and the reference server at LFCP_SERVER_BIN.
//
// F-03: "Share section…" run twice on one note opens one preview (the second
// run brings it forward, LFCP-03-002); one Resource is made and hosted, and
// no "stopped syncing" / RESOURCE_NOT_HOSTED notice comes.
// F-04: held edits are never shown as synced. For each cause (a heading
// inside the section, a damaged binding line, a read-only copy) the card
// counts the edits not sent with their cause and line, never says "No local
// changes waiting." or "Current as last checked", offers "Go to line", and
// the editor marks the held lines; typing into a read-only section is stopped.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { closeModals } from "./support/section-checks.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const NOTE = ["## Twice", "", "- [ ] One", "- [ ] Two", "", "A paragraph.", ""].join("\n");
let server;
let b;

/** Every notice A showed since the start (they fade: an observer keeps them). */
const notices = () => inA(() => window.__lfcpNotices ?? []);

/** The open note's text, its badge state and attention cues. */
const stateA = () =>
  inA(({ app, obsidian }) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    return {
      path: view.file.path,
      md: view.editor.getValue(),
      cursor: view.editor.getCursor().line,
      badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
      cues: view.containerEl.querySelectorAll('.openlfcp-row-cue[data-cue="attention"]').length,
    };
  });

/** Opens the card of the section under the cursor; its text by part, and its buttons. */
const card = () =>
  inA(async ({ app }) => {
    for (const m of document.querySelectorAll(".openlfcp-section-card"))
      m.closest(".modal-container")?.querySelector(".modal-bg")?.click();
    app.commands.executeCommandById("shared-tasks:open-section-details");
    let modal = null;
    for (let i = 0; i < 100 && modal === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      modal = document.querySelector(".openlfcp-section-card");
    }
    if (modal === null) return null;
    const texts = (sel) => [...modal.querySelectorAll(`${sel} li`)].map((li) => li.textContent);
    return {
      status: modal.querySelector(".openlfcp-card-status")?.textContent ?? null,
      problems: texts(".openlfcp-card-problems"),
      facts: texts(".openlfcp-card-facts"),
      buttons: [...modal.querySelectorAll(".modal-button-container button")].map((x) => x.textContent),
    };
  });

const pressInCard = (label) =>
  inA(({}, label) => {
    const modal = document.querySelector(".openlfcp-section-card");
    [...modal.querySelectorAll(".modal-button-container button")].find((x) => x.textContent === label).click();
  }, label);

const closeCard = async () => {
  await closeModals("section card");
  return inA(() => document.querySelector(".openlfcp-section-card") === null);
};

/** An edit of the open note as a user's (replaceRange: a user transaction to the engine). */
const editA = (fn) =>
  inA(({ app, obsidian }, src) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const next = new Function("md", `return (${src})(md)`)(view.editor.getValue());
    view.editor.replaceRange(next, { line: 0, ch: 0 }, { line: view.editor.lineCount(), ch: 0 });
  }, fn.toString());

const badgeIs = (state, msg) =>
  browser.waitUntil(async () => (await stateA()).badge === state, { timeout: 20_000, timeoutMsg: msg });

function expectHeldCard(c, re) {
  expect(c).not.toBeNull();
  expect(c.facts.join(" | ")).toMatch(re);
  expect(c.facts).not.toContain("No local changes waiting.");
  expect(c.facts.join(" ")).not.toMatch(/Current as last checked/);
}

describe("one share flow per note; held edits are never shown as synced (F-03, F-04)", () => {
  before(async () => {
    server = await restartableServer();
    b = await peer(server.url);
    await inA(async ({ app }, url) => {
      window.__lfcpNotices = [];
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.classList.contains("notice")) window.__lfcpNotices.push(n.textContent);
      }).observe(document.body, { childList: true, subtree: true });
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = url;
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++)
        await new Promise((r) => setTimeout(r, 50));
    }, server.url);
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it('F-03: "Share section…" twice on one note: one preview, one Resource, no "stopped syncing"', async () => {
    const previews = await inA(async ({ app, obsidian }, text) => {
      await app.vault.create("Twice.md", text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Twice.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 0, ch: 0 });
      const shareModals = () =>
        [...document.querySelectorAll(".modal-container .modal")].filter((m) =>
          [...m.querySelectorAll("button")].some((x) => x.textContent === "Share"),
        );
      app.commands.executeCommandById("shared-tasks:share-section");
      for (let i = 0; i < 80 && shareModals().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      // The second run while the first preview is open: it is brought forward, nothing else opens.
      app.commands.executeCommandById("shared-tasks:share-section");
      await new Promise((r) => setTimeout(r, 1000));
      const n = shareModals().length;
      const front = [...document.body.querySelectorAll(":scope > .modal-container")].at(-1);
      const inFront = front?.contains(shareModals()[0] ?? null) ?? false;
      // The dialog has the focus, not its Share button (Enter after a repeated hotkey must not share).
      const focus = document.activeElement === shareModals()[0] ? "dialog" : (document.activeElement?.tagName ?? null);
      for (const m of shareModals()) [...m.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
      return { n, inFront, focus };
    }, NOTE);
    await browser.waitUntil(
      () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          if (!(await app.vault.adapter.read("Twice.md")).includes("<!-- /lfcp-section: ")) return false;
          const e = (await p.runtime.registry()).find((x) => x.profile.includes("section"));
          if (e === undefined) return false;
          const hex = Buffer.from(e.resourceId).toString("hex");
          return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted";
        }),
      { timeout: 60_000, timeoutMsg: "the section shared and hosted" },
    );
    // Long enough for a refusal of an unhosted Resource to come and be announced.
    await browser.pause(6000);
    const sections = await inA(async ({ app }) =>
      (await app.plugins.plugins["shared-tasks"].runtime.registry()).filter((x) => x.profile.includes("section")).length,
    );
    const said = await notices();
    const md = (await stateA()).md;
    evidence("F-03", { previews, sections, said, bound: md.match(/<!-- lfcp-section: /g)?.length ?? 0 });
    expect(previews).toEqual({ n: 1, inFront: true, focus: "dialog" });
    expect(sections).toBe(1);
    expect(md.match(/<!-- lfcp-section: /g)).toHaveLength(1);
    expect(said).toContain('Shared Tasks: section "Twice" is shared.');
    expect(said.some((t) => t.includes("already has a section being shared"))).toBe(false);
    for (const t of said) expect(t).not.toMatch(/stopped syncing|RESOURCE_NOT_HOSTED|changed since the preview/);
    await badgeIs("CURRENT", "the shared section current");
  });

  it("F-04 unsupported: a heading inside the section holds 2 edits; the card says so, with its line", async () => {
    const before = (await stateA()).md;
    await inA(({ app, obsidian }) => {
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 3, ch: 0 });
    });
    await editA((md) => md.replace("- [ ] One", "- [ ] One edited").replace("A paragraph.", "A paragraph.\n\n### Inside"));
    await badgeIs("ATTENTION", "the section needs attention");
    const s = await stateA();
    const heading = s.md.split("\n").indexOf("### Inside");
    const c = await card();
    const cues = (await stateA()).cues;
    evidence("F-04-unsupported", { card: c, cues, heading, said: (await notices()).filter((t) => t.includes("not sent")) });
    expectHeldCard(c, new RegExp(`^2 edits not sent: the section has content it cannot share \\(Twice\\.md, line ${heading + 1}\\)\\.`));
    expect(c.problems[0]).toMatch(new RegExp(`^A heading inside the shared section \\(line ${heading + 1} of Twice\\.md\\)`));
    expect(c.buttons).toContain(`Go to line ${heading + 1}`);
    expect(c.buttons).toContain("Repair shared sections in this note");
    expect(cues).toBeGreaterThanOrEqual(2);
    expect((await notices()).some((t) => t.startsWith('Shared Tasks: 2 edits in "Twice" not sent'))).toBe(true);
    // Nothing reached the model.
    const model = await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
      return JSON.stringify(p.runtime.sectionProfile(R).replica.toJSON());
    });
    expect(model).not.toContain("One edited");
    // "Go to line" puts the cursor on the heading.
    await inA(({ app, obsidian }) => {
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 0, ch: 0 });
    });
    await card();
    await pressInCard(`Go to line ${heading + 1}`);
    await browser.waitUntil(async () => (await stateA()).cursor === heading, { timeout: 5000, timeoutMsg: "cursor on the line" });
    // Undone: current again, and the card says so.
    await editA(new Function(`return () => ${JSON.stringify(before)}`)());
    await badgeIs("CURRENT", "current again after the undo");
    const back = await card();
    expect(back.facts).toContain("No local changes waiting.");
    await closeCard();
  });

  it("F-04 binding: a damaged binding line holds the edits; the card names it and offers the repair", async () => {
    const before = (await stateA()).md;
    await editA((md) =>
      md.replace(/<!-- lfcp-node: paragraph:[0-9a-f-]+ -->/, "<!-- lfcp-node: paragraph:zz -->").replace("- [ ] Two", "- [ ] Two edited"),
    );
    await badgeIs("ATTENTION", "the section needs attention");
    const s = await stateA();
    const marker = s.md.split("\n").findIndex((l) => l.startsWith("<!-- lfcp-node: paragraph:zz"));
    const c = await card();
    evidence("F-04-binding", { card: c, cues: s.cues, marker });
    expectHeldCard(c, new RegExp(`^1 edit not sent: a binding line in the section is damaged \\(Twice\\.md, line ${marker + 1}\\)\\.`));
    expect(c.problems[0]).toMatch(/^A binding line of the section is damaged/);
    expect(c.buttons).toContain(`Go to line ${marker + 1}`);
    expect(c.buttons).toContain("Repair shared sections in this note");
    await closeCard();
    await editA(new Function(`return () => ${JSON.stringify(before)}`)());
    await badgeIs("CURRENT", "current again after the undo");
  });

  it("F-04 read-only: typing is stopped and said; an edit from outside the editor is held, never sent", async () => {
    // B shares a section and invites A to read it.
    b.files.set("B.md", ["## From B", "", "- [ ] Task of B", ""].join("\n"));
    const shared = await b.share("B.md", "## From B");
    const link = (await b.collab.invite(shared.resource, "read")).link.reveal();
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:join-collaboration"));
    const answer = (text) =>
      inA(async ({}, text) => {
        let input = null;
        for (let i = 0; i < 100 && input === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          input = document.querySelector(".modal-container .modal input");
        }
        input.value = text;
        input.dispatchEvent(new Event("input"));
        [...document.querySelectorAll(".modal-container .modal button")].find((x) => x.textContent === "OK").click();
        await new Promise((r) => setTimeout(r, 200));
      }, text);
    await answer(link);
    await answer("From B");
    await browser.waitUntil(async () => (await notices()).some((t) => t.includes("joined the shared section")), {
      timeout: 30_000,
      timeoutMsg: "A joined",
    });
    await inA(async ({ app, obsidian }) => {
      await app.vault.create("RO.md", ["# Read only", "", "Above.", ""].join("\n"));
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("RO.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.getValue().includes("Above."); i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 2, ch: 0 });
      app.commands.executeCommandById("shared-tasks:insert-section");
    });
    await inA(async () => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes("From B")).click();
      let ins;
      for (let i = 0; i < 200 && ins === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      ins.click();
    });
    await browser.waitUntil(async () => (await stateA()).md.includes("<!-- /lfcp-section: "), {
      timeout: 30_000,
      timeoutMsg: "the section inserted",
    });
    await badgeIs("READ_ONLY_CURRENT", "read-only and current");
    // Typing into it is stopped, and said.
    const before = (await stateA()).md;
    await closeModals("typing into read-only");
    await inA(async ({ app, obsidian }) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "RO.md");
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.hasFocus(); i++) {
        view.editor.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      const line = view.editor.getValue().split("\n").findIndex((l) => l.includes("Task of B"));
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
    });
    await browser.keys(["x", "y", "z"]);
    await browser.pause(1500);
    const typed = await stateA();
    evidence("F-04-read-only-typing", {
      same: typed.md === before,
      said: await notices(),
      focus: await inA(({ app, obsidian }) => {
        const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        return {
          has: v.editor.hasFocus(),
          active: `${document.activeElement?.tagName}.${document.activeElement?.className ?? ""}`,
          cursor: v.editor.getCursor(),
          modals: [...document.querySelectorAll(".modal-container")].map((m) => m.textContent.slice(0, 80)),
          leaves: app.workspace.getLeavesOfType("markdown").map((l) => l.view.file?.path),
          docFocus: document.hasFocus(),
        };
      }),
    });
    expect(typed.md).toBe(before);
    expect((await notices()).some((t) => t.includes('"From B" is read-only for you. Your typing was not applied'))).toBe(true);
    // An edit from outside the editor (another plugin, a sync tool) is held, not sent.
    await inA(({ app }) =>
      app.vault.process(app.vault.getFileByPath("RO.md"), (t) => t.replace("- [ ] Task of B", "- [ ] Task of B, edited outside")),
    );
    const held = await browser.waitUntil(async () => (await stateA()).badge === "ATTENTION", { timeout: 20_000 }).catch(() => false);
    if (!held) {
      // Diagnostics (mac/Windows, LFCP-03-036): what the note and the status show instead.
      const now = await stateA();
      evidence("F-04-read-only not held", {
        badge: now.badge,
        edited: now.md.includes("edited outside"),
        disk: await inA(async ({ app }) => (await app.vault.read(app.vault.getFileByPath("RO.md"))).includes("edited outside")),
        card: await card(),
      });
      await closeCard();
      throw new Error("the read-only copy holds an edit");
    }
    const s = await stateA();
    const line = s.md.split("\n").findIndex((l) => l.includes("edited outside"));
    const c = await card();
    evidence("F-04-read-only", { card: c, cues: s.cues, line });
    expectHeldCard(c, new RegExp(`^1 edit not sent: you can read this section, not edit it \\(RO\\.md, line ${line + 1}\\)\\.`));
    expect(c.problems.some((p) => p.startsWith("You can read this section, not edit it: your edits"))).toBe(true);
    expect(c.buttons).toContain(`Go to line ${line + 1}`);
    expect(s.cues).toBeGreaterThanOrEqual(1);
    await closeCard();
    await browser.pause(3000);
    expect(JSON.stringify(b.runtime.sectionProfile(shared.resource).replica.toJSON())).not.toContain("edited outside");
  });
});
