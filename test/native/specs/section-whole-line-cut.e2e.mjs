// The owner's check of 0.4.0-beta.19: in Live Preview, "- [ ] Gamma" selected
// with the mouse from the line's end to its start (the Task's line exactly,
// its ref line hidden below it), Cmd+X, the caret at the start of Alpha's
// line, Cmd+V. Only the Task's text was cut: its ref line stayed behind,
// alone, and the section said a binding line was damaged. With the fix
// (withBindingLines) the cut takes the Task's binding lines along: the
// paste restores the same Task, the section stays current and the
// collaborator gets the move. Also Backspace on such a selection. Vault A
// is real Obsidian with a real mouse and keys; B is the headless peer.
import { peer, restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const mod = process.platform === "darwin" ? "Meta" : "Control";
const FILE = "Tasks19.md";
const NOTE = [
  "PRIVATE-A",
  "",
  "## Tasks19",
  "",
  "- [ ] Alpha 4",
  "- [x] Beta",
  "- [ ] Gamma",
  "- [ ] Delta",
  "",
  "paragraph 1.",
  "",
].join("\n");
const noteA = () => inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue());
const fileA = () => inA(({ app }, f) => app.vault.adapter.read(f), FILE);
const badgeA = () =>
  inA(({ app, obsidian }) => {
    const el = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status");
    return el?.dataset.state ?? null;
  });
/** The Tasks of a note in order, each with its indentation and whether its ref line follows at its depth. */
const layout = (md) => {
  const L = md.split("\n");
  return L.flatMap((l, i) => {
    const m = /^(\s*)- \[.\] (.*)$/.exec(l);
    if (m === null) return [];
    const ref = /^(\s*)<!-- lfcp-ref:/.exec(L[i + 1] ?? "");
    return [{ title: m[2], indent: m[1].length, bound: ref !== null && ref[1].length === m[1].length + 2 }];
  });
};
const titles = (md) => layout(md).map((t) => t.title);

/** In A: the caret at the start of the line titled `title` (Live Preview). */
const caretAt = (title) =>
  inA(({ app, obsidian }, title) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const at = view.editor.getValue().split("\n").findIndex((l) => l.includes(`] ${title}`));
    view.editor.focus();
    view.editor.setCursor({ line: at, ch: 0 });
  }, title);

/** In A: drag the mouse from the end of the line titled `title` to its start. */
async function selectLineBackwards(title) {
  const at = await inA(({ app, obsidian }, title) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const cm = view.editor.cm;
    const n = view.editor.getValue().split("\n").findIndex((l) => l.includes(`] ${title}`));
    const line = cm.state.doc.line(n + 1);
    const end = cm.coordsAtPos(line.to);
    // The start of the Task's text (Live Preview shows a checkbox widget before it).
    const textStart = cm.coordsAtPos(line.from + line.text.indexOf("] ") + 2);
    const start = cm.coordsAtPos(line.from);
    return {
      x0: Math.round(end.right + 2),
      y: Math.round((end.top + end.bottom) / 2),
      x1: Math.round(Math.min(start.left, textStart.left) - 30),
    };
  }, title);
  await browser
    .action("pointer")
    .move({ x: at.x0, y: at.y })
    .down()
    .move({ x: at.x1, y: at.y, duration: 300 })
    .up()
    .perform();
  return inA(({ app, obsidian }) => {
    const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
    return { from: e.getCursor("from"), to: e.getCursor("to"), text: e.getSelection() };
  });
}

let server;
let b;

describe("a Task's whole line selected with the mouse, then cut or deleted (beta.19)", () => {
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
      for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    }, server.url);
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  /** A shares a fresh note in Live Preview; B joins and inserts it. */
  async function share(file) {
    await inA(async ({ app, obsidian }, file, text) => {
      await app.vault.create(file, text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 2, ch: 0 });
      app.commands.executeCommandById("shared-tasks:share-section");
      let modal = null;
      for (let i = 0; i < 80 && modal === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = document.querySelector(".modal-container .modal");
      }
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
    }, file, NOTE);
    await browser.waitUntil(
      () =>
        inA(async ({ app }, file) => {
          const p = app.plugins.plugins["shared-tasks"];
          if (!(await app.vault.adapter.read(file)).includes("<!-- /lfcp-section: ")) return false;
          const all = await p.runtime.registry();
          for (const e of all.filter((x) => x.profile.includes("section"))) {
            const hex = Buffer.from(e.resourceId).toString("hex");
            if ((await p.runtime.localState.get(`collab-hosting:${hex}`)) !== "hosted") return false;
          }
          return all.length > 0;
        }, file),
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
    await pick("Tasks19");
    await pick("Read + write");
    const link = await inA(async () => {
      let modal;
      for (let i = 0; i < 200 && modal === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = [...document.querySelectorAll(".modal-container .modal")].find((m) => m.textContent.includes("Invitation ("));
      }
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const value = modal.querySelector("input").value;
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return value;
    });
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert(link, "B.md", 3);
  }

  const gammaIdIn = (md) => {
    const L = md.split("\n");
    const at = L.findIndex((l) => l.includes("] Gamma"));
    return /#task:([0-9a-f-]{36})/.exec(L[at + 1] ?? "")?.[1];
  };

  it("cut and paste: the same Task moved, every binding in place", async () => {
    await share(FILE);
    const before = gammaIdIn(await noteA());
    const selection = await selectLineBackwards("Gamma");
    await browser.keys([mod, "x"]);
    await browser.pause(150);
    await caretAt("Alpha 4");
    await browser.keys([mod, "v"]);
    await browser.pause(3000);
    const badge = await browser.waitUntil(async () => {
      const s = await badgeA();
      return s === "CURRENT" || s === "ATTENTION" ? s : false;
    }, { timeout: 30_000, timeoutMsg: "A's badge settles" });
    let order = [];
    for (let i = 0; i < 40; i++) {
      await b.pass("B.md");
      order = titles(b.files.get("B.md"));
      if (order[0] === "Gamma") break;
      await browser.pause(250);
    }
    const a = layout(await noteA());
    evidence("WHOLE-LINE-CUT", { selection, badge, a, b: order, before, after: gammaIdIn(await noteA()), bGamma: gammaIdIn(b.files.get("B.md")) });
    expect(a.every((t) => t.bound)).toBe(true);
    expect(a.map((t) => t.title)).toEqual(["Gamma", "Alpha 4", "Beta", "Delta"]);
    expect(gammaIdIn(await noteA())).toBe(before);
    expect(badge).toBe("CURRENT");
    expect(order[0]).toBe("Gamma");
    expect(gammaIdIn(b.files.get("B.md"))).toBe(before);
  });

  it("Backspace on the selected line: the Task deleted, no binding left behind", async () => {
    const selection = await selectLineBackwards("Delta");
    await browser.keys(["Backspace"]);
    await browser.pause(3000);
    const md = await noteA();
    const L = md.split("\n");
    const orphans = L.filter((l, i) => l.includes("lfcp-ref:") && !/- \[.\] /.test(L[i - 1] ?? "")).length;
    const badge = await badgeA();
    let order = [];
    for (let i = 0; i < 40; i++) {
      await b.pass("B.md");
      order = titles(b.files.get("B.md"));
      if (!order.includes("Delta")) break;
      await browser.pause(250);
    }
    evidence("WHOLE-LINE-DELETE", { selection, orphans, badge, a: titles(md), b: order });
    expect(orphans).toBe(0);
    expect(titles(md)).not.toContain("Delta");
    expect(badge).toBe("CURRENT");
    expect(order).not.toContain("Delta");
  });
});
