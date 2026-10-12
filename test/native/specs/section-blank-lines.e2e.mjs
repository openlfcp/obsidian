// Blank lines in a shared section (the owner's check of 0.4.0-beta.8), real
// Obsidian in Live Preview with the headless peer B: Enter at the start of a
// paragraph is a blank line before it (local layout, MARKDOWN-SECTIONS-01
// §5), not a new node, and B is unchanged; an empty paragraph whose empty
// line is deleted (a blank line to the eye) still binds, and the section
// stays CURRENT. The reference server at LFCP_SERVER_BIN hosts the section.
import { peer, restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const NOTE = [
  "## IME test",
  "",
  "- [ ] First task",
  "- [ ] Second task 📅 2026-10-20",
  "- [ ] Third task",
  "",
  "A paragraph for typing.",
  "",
].join("\n");
let server;
let b;

/** The section's lines of `md` that are not markers or refs. */
const content = (md) =>
  md
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("<!--") && !l.startsWith("##") && !/^\s*%%/.test(l))
    .map((l) => l.replace(/\s*<!-- lfcp-ref:.*-->$/, "").replace(/\s*\^[\w-]+$/, ""));

describe("blank lines are local layout; an empty paragraph keeps its binding (0.4.0-beta.8)", () => {
  before(async () => {
    server = await restartableServer();
    b = await peer(server.url);
    await inA(async ({ app }, url) => {
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

  it("A shares the section, B joins", async () => {
    await inA(async ({ app, obsidian }, text) => {
      await app.vault.create("IME.md", text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("IME.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 0, ch: 0 });
      app.commands.executeCommandById("shared-tasks:share-section");
      let modal = null;
      for (let i = 0; i < 80 && modal === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = document.querySelector(".modal-container .modal");
      }
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
    }, NOTE);
    await browser.waitUntil(
      () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          if (!(await app.vault.adapter.read("IME.md")).includes("<!-- /lfcp-section: ")) return false;
          const e = (await p.runtime.registry()).find((x) => x.profile.includes("section"));
          if (e === undefined) return false;
          const hex = Buffer.from(e.resourceId).toString("hex");
          return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted";
        }),
      { timeout: 60_000, timeoutMsg: "the section shared and hosted" },
    );
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:invite-collaborator"));
    const pick = (label) =>
      inA(async ({}, label) => {
        let items = [];
        for (let i = 0; i < 100 && items.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          items = [...document.querySelectorAll(".prompt .suggestion-item")];
        }
        items.find((x) => x.textContent.includes(label)).click();
      }, label);
    await pick("IME test");
    await pick("Read + write");
    const link = await inA(async () => {
      let modal;
      for (let i = 0; i < 200 && modal === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = [...document.querySelectorAll(".modal-container .modal")].find((m) =>
          m.textContent.includes("Invitation ("),
        );
      }
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const value = modal.querySelector("input").value;
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return value;
    });
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert(link, "B.md", 3);
    expect(content(b.files.get("B.md"))).toContain("A paragraph for typing.");
  });


  /** A's paragraph lines and model paragraphs, and the badge. */
  const stateA = () =>
    inA(async ({ app, obsidian }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
      const doc = p.runtime.sectionProfile(R).replica.toJSON();
      return {
        md: view.editor.getValue(),
        paragraphs: Object.values(doc.nodes ?? {})
          .filter((n) => n.kind === "paragraph")
          .map((n) => String(n.text ?? ""))
          .sort(),
        badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
      };
    });

  it("Enter at the start of the paragraph is a blank line before it, no new node; B unchanged", async () => {
    const bBefore = content(b.files.get("B.md"));
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("A paragraph"));
      view.editor.focus();
      view.editor.setCursor({ line, ch: 0 });
    });
    await browser.keys("Enter");
    await browser.pause(3000);
    const a = await stateA();
    for (let i = 0; i < 3; i++) await b.pass("B.md");
    const L = a.md.split("\n");
    const at = L.findIndex((l) => l.startsWith("A paragraph"));
    evidence("ENTER-AT-START", { around: L.slice(at - 3, at + 1), paragraphs: a.paragraphs, badge: a.badge });
    // The marker stays right above its text; the blank line is above the marker.
    expect(L[at - 1]).toMatch(/^<!-- lfcp-node: paragraph:/);
    expect(L[at - 2]).toBe("");
    expect(a.paragraphs).toEqual(["A paragraph for typing."]);
    expect(a.badge).toBe("CURRENT");
    expect(content(b.files.get("B.md"))).toEqual(bBefore);
  });

  it("an empty paragraph whose empty line is deleted keeps its binding; CURRENT", async () => {
    // B splits the paragraph at its start, as 0.4.0-beta.8 did: the old node empty, the text a new one.
    const L = b.files.get("B.md").split("\n");
    const at = L.findIndex((l) => l.startsWith("A paragraph"));
    L.splice(at, 0, "");
    b.files.set("B.md", L.join("\n"));
    await b.pass("B.md");
    await b.pass("B.md");
    await browser.waitUntil(async () => (await stateA()).paragraphs.length === 2, {
      timeout: 20_000,
      timeoutMsg: "A: the empty paragraph arrived",
    });
    await browser.pause(1000);
    // In A, the empty paragraph's empty line (a blank line to the eye) is deleted.
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const cm = view.editor.cm;
      const d = cm.state.doc;
      for (let n = 2; n < d.lines; n++)
        if (
          d.line(n - 1).text.startsWith("<!-- lfcp-node: paragraph:") &&
          d.line(n).text === "" &&
          d.line(n + 1).text.startsWith("<!-- lfcp-node: paragraph:")
        ) {
          cm.dispatch({ changes: { from: d.line(n).from - 1, to: d.line(n).from }, userEvent: "delete.backward" });
          return;
        }
      throw new Error("no empty paragraph line");
    });
    let a = await stateA();
    for (let i = 0; i < 40 && a.badge !== "CURRENT"; i++) {
      await browser.pause(250);
      a = await stateA();
    }
    await browser.pause(2000);
    a = await stateA();
    const lines = a.md.split("\n");
    const p = lines.findIndex((l) => l.startsWith("A paragraph"));
    evidence("EMPTY-LINE-DELETED", { around: lines.slice(p - 3, p + 1), paragraphs: a.paragraphs, badge: a.badge });
    expect(lines[p - 2]).toMatch(/^<!-- lfcp-node: paragraph:/);
    expect(lines[p - 1]).toMatch(/^<!-- lfcp-node: paragraph:/);
    expect(a.paragraphs).toEqual(["", "A paragraph for typing."]);
    expect(a.badge).toBe("CURRENT");
  });
});
