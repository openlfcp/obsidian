// IME in a shared section (0.4.0-beta.5 owner check B13), real Obsidian with
// a simulated composition: WebDriver cannot drive an IME, so the spec sends
// compositionstart and compositionend to the editor and makes the composed
// edits itself, as an IME's do (input.type.compose), with CodeMirror's own
// composing flag false as it is at a composition's first change. Nothing of
// a composition is committed while it is open (IME-1), and the deletion of
// the composed word afterwards syncs: no refused Text edit, no
// LOCAL_SAVE_FAILED. The reference server at LFCP_SERVER_BIN hosts it.
import { restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
const NOTE = ["## IME test", "", "- [ ] One", "- [ ] Two", "", "A paragraph for typing.", ""].join("\n");
let server;

describe("IME composition in a shared section (B13)", () => {
  before(async () => {
    server = await restartableServer();
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
    await server?.stop();
  });

  it("commits nothing while composing; the composed word and its deletion sync", async () => {
    await inA(async ({ app, obsidian }, text) => {
      await app.vault.create("IME.md", text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("IME.md"), { state: { mode: "source", source: true } });
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
          const e = (await p.runtime.registry()).find((x) => x.profile.includes("section"));
          if (e === undefined) return false;
          return (await p.runtime.localState.get(`collab-hosting:${Buffer.from(e.resourceId).toString("hex")}`)) === "hosted";
        }),
      { timeout: 60_000, timeoutMsg: "the section shared and hosted" },
    );
    const out = await inA(async ({ app, obsidian }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = app.plugins.plugins["shared-tasks"];
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const cm = view.editor.cm;
      const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
      const model = () => {
        const doc = p.runtime.sectionProfile(R).replica.toJSON();
        return String(Object.values(doc.nodes ?? {}).find((n) => n.kind === "paragraph")?.text ?? "");
      };
      const note = () => view.editor.getValue().split("\n").find((l) => l.startsWith("A paragraph"));
      const badge = () => view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null;
      const end = () => {
        const d = cm.state.doc;
        for (let n = 1; n <= d.lines; n++) if (d.line(n).text.startsWith("A paragraph")) return d.line(n).to;
        return -1;
      };
      const compose = (type, data) =>
        cm.contentDOM.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
      const put = (from, to, insert) =>
        cm.dispatch({ changes: { from, to, insert }, userEvent: "input.type.compose" });
      cm.focus();
      cm.dispatch({ selection: { anchor: end() } });
      const at = end();
      compose("compositionstart", "");
      put(at, at, " ｎ");
      await sleep(80);
      put(at, at + 2, " に");
      await sleep(80);
      put(at, at + 2, " にｈ");
      await sleep(80);
      put(at, at + 3, " にほ");
      // Longer than the idle, the cap and the typing coalescer's pause together.
      await sleep(3000);
      const whileComposing = { model: model(), composingFlag: cm.composing };
      put(at, at + 3, " 日本"); // Space converts
      await sleep(300);
      compose("compositionend", "日本"); // Enter commits
      const committed = await (async () => {
        for (let i = 0; i < 100; i++) {
          if (model().endsWith(" 日本")) return true;
          await sleep(100);
        }
        return false;
      })();
      for (let i = 0; i < 3; i++) {
        const e = end();
        cm.dispatch({ changes: { from: e - 1, to: e }, userEvent: "delete.backward" });
        await sleep(150);
      }
      let synced = false;
      for (let i = 0; i < 100 && !synced; i++) {
        await sleep(100);
        synced = model() === "A paragraph for typing." && badge() === "CURRENT";
      }
      const kept = ((await p.runtime.localState.get("section-candidates")) ?? []).length;
      return { whileComposing, committed, after: { note: note(), model: model(), badge: badge() }, kept };
    });
    evidence("B13", out);
    expect(out.whileComposing.model).toBe("A paragraph for typing.");
    expect(out.committed).toBe(true);
    expect(out.after).toEqual({
      note: "A paragraph for typing.",
      model: "A paragraph for typing.",
      badge: "CURRENT",
    });
    expect(out.kept).toBe(0);
  });
});
