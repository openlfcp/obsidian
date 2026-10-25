// The owner's check of 0.4.0-beta.19, step 4: a collaborator nests Delta
// under Gamma (Tab), and in Live Preview Gamma is moved above Alpha the
// owner's way: the caret at the start of Gamma's line, Shift+Down, Cmd+X,
// the caret at the start of Alpha's line, Cmd+V. The selection ended after
// Delta's indentation, the cut took it and the paste gave it to Alpha: "A
// binding line of the section is damaged". With the fix (obsidian f04c5e3)
// every binding keeps its line: the section stays current and the
// collaborator gets Gamma first. Vault A is real Obsidian with real keys;
// B is the headless peer on the reference server at LFCP_SERVER_BIN. Also
// with B's Tab arriving between the cut and the paste.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { inviteToSectionInA } from "./support/section-checks.mjs";

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

/** B: Delta under Gamma (Tab), sent. */
async function nestDeltaInB(b) {
  const L = b.files.get("B.md").split("\n");
  const at = L.findIndex((l) => l.includes("[ ] Delta"));
  L[at] = `  ${L[at]}`;
  L[at + 1] = `  ${L[at + 1]}`;
  b.files.set("B.md", L.join("\n"));
  await b.pass("B.md");
}

/** In A: the caret at the start of the line titled `title` (Live Preview). */
const caretAt = (title) =>
  inA(({ app, obsidian }, title) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const at = view.editor.getValue().split("\n").findIndex((l) => l.includes(`] ${title}`));
    view.editor.focus();
    view.editor.setCursor({ line: at, ch: 0 });
  }, title);

let server;
let b;

describe("a Task moved by Shift+Down, cut and paste while a collaborator nests the next one (beta.19 step 4)", () => {
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
    await inviteToSectionInA("Tasks19");
    const pick = (label) =>
      inA(async ({}, label) => {
        let items = [];
        for (let i = 0; i < 100 && items.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          items = [...document.querySelectorAll(".prompt .suggestion-item")];
        }
        items.find((x) => x.textContent.includes(label)).click();
      }, label);
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

  /** The owner's keys: Shift+Down from Gamma's line start, cut; `between`; the caret at Alpha's line start, paste. */
  async function moveGamma(between) {
    await caretAt("Gamma");
    await browser.keys(["Shift", "ArrowDown"]);
    const selection = await inA(({ app, obsidian }) => {
      const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
      return { from: e.getCursor("from"), to: e.getCursor("to"), text: e.getSelection() };
    });
    await browser.keys([mod, "x"]);
    await browser.pause(150);
    await between();
    await caretAt("Alpha 4");
    await browser.keys([mod, "v"]);
    return selection;
  }

  async function settled(label) {
    await browser.pause(3000);
    const badge = await browser.waitUntil(async () => {
      const s = await badgeA();
      return s === "CURRENT" || s === "ATTENTION" ? s : false;
    }, { timeout: 30_000, timeoutMsg: `${label}: A's badge settles` });
    let order = [];
    for (let i = 0; i < 40; i++) {
      await b.pass("B.md");
      order = titles(b.files.get("B.md"));
      if (order[0] === "Gamma") break;
      await browser.pause(250);
    }
    return { badge, a: layout(await noteA()), file: layout(await fileA()), b: order };
  }

  it("the Tab arrived before the cut: every binding keeps its line", async () => {
    await share(FILE);
    await nestDeltaInB(b);
    await browser.waitUntil(async () => layout(await noteA()).find((t) => t.title === "Delta")?.indent === 2, {
      timeout: 30_000,
      timeoutMsg: "A shows Delta under Gamma",
    });
    const selection = await moveGamma(async () => {});
    const out = await settled("before");
    evidence("STEP4-BEFORE", { selection, ...out });
    expect(out.a.every((t) => t.bound)).toBe(true);
    expect(out.a[0]).toEqual({ title: "Gamma", indent: 0, bound: true });
    expect(out.a.find((t) => t.title === "Alpha 4")).toEqual({ title: "Alpha 4", indent: 0, bound: true });
    expect(out.badge).toBe("CURRENT");
    expect(out.b[0]).toBe("Gamma");
  });
});
