// The owner's IME check of 0.4.0-beta.6 (IME-3), real Obsidian in Live
// Preview with a simulated composition (WebDriver cannot drive an IME): a
// space and a composed word at the end of the paragraph, then a real Enter
// at the end of a Task line (Live Preview continues the list) and a composed
// word in the new Task. On 0.4.0-beta.6 the peer showed the paragraph's word
// twice, A's note lost it and A's section stayed LOCAL_SAVE_FAILED. Both
// vaults must show the paragraph once, as typed, and the new Task once; A's
// badge CURRENT, nothing kept. The headless peer B is the other vault; the
// reference server at LFCP_SERVER_BIN hosts the section.
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
const TYPED = "A paragraph for typing. 　日本";
let server;
let b;

/** The section's lines of `md` that are not markers or refs. */
const content = (md) =>
  md
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("<!--") && !l.startsWith("##") && !/^\s*%%/.test(l))
    .map((l) => l.replace(/\s*<!-- lfcp-ref:.*-->$/, "").replace(/\s*\^[\w-]+$/, ""));

/** A composition in A's editor at the caret, as an IME makes it: each step replaces the composed text. */
const compose = (steps, final) =>
  inA(
    async ({ app, obsidian }, steps, final) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.cm;
      const at = cm.state.selection.main.head;
      const event = (type, data) =>
        cm.contentDOM.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
      let len = 0;
      event("compositionstart", "");
      for (const s of [...steps, final]) {
        cm.dispatch({
          changes: { from: at, to: at + len, insert: s },
          selection: { anchor: at + s.length },
          userEvent: "input.type.compose",
        });
        len = s.length;
        await sleep(120);
      }
      await sleep(300);
      event("compositionend", final);
    },
    steps,
    final,
  );

describe("IME: a composed word, then Enter on a Task line and a composed Task (B13, IME-3)", () => {
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

  it("the paragraph's composed word and the composed Task each sync once; A keeps both", async () => {
    // The end of the paragraph: an ASCII space, then にほん → 日本 (with the IME's full-width space).
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("A paragraph"));
      view.editor.focus();
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
    });
    await browser.keys(" ");
    await browser.pause(150);
    await compose(["　ｎ", "　に", "　にｈ", "　にほ", "　にほｎ", "　にほん"], "　日本");
    await browser.pause(1500);
    // A click at the end of "Second task …", Enter (Live Preview continues the list), しごと → 仕事.
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.includes("Second task"));
      view.editor.focus();
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
    });
    await browser.pause(300);
    await browser.keys("Enter");
    await browser.pause(400);
    await compose(["ｓ", "し", "しｇ", "しご", "しごｔ", "しごと"], "仕事");
    // No further input; the coalescer, the passes and B settle.
    const states = [];
    for (let i = 0; i < 16; i++) {
      await browser.pause(500);
      states.push(
        await inA(async ({ app, obsidian }) => {
          const p = app.plugins.plugins["shared-tasks"];
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
          const doc = p.runtime.sectionProfile(R).replica.toJSON();
          return {
            note: view.editor.getValue().split("\n").find((l) => l.startsWith("A paragraph")),
            model: String(Object.values(doc.nodes ?? {}).find((n) => n.kind === "paragraph")?.text ?? ""),
            badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
          };
        }),
      );
    }
    for (let i = 0; i < 4; i++) await b.pass("B.md");
    const a = await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      return {
        md: await app.vault.adapter.read("IME.md"),
        kept: ((await p.runtime.localState.get("section-candidates")) ?? []).length,
      };
    });
    const bLines = content(b.files.get("B.md"));
    const aLines = content(a.md);
    evidence("IME-3", { states, a: aLines, b: bLines, kept: a.kept });
    for (const lines of [aLines, bLines]) {
      expect(lines.filter((l) => l.startsWith("A paragraph"))).toEqual([TYPED]);
      expect(lines.filter((l) => l.includes("仕事"))).toHaveLength(1);
    }
    expect(states.at(-1)).toEqual({ note: TYPED, model: TYPED, badge: "CURRENT" });
    expect(a.kept).toBe(0);
  });

  // Vault C of the owner's check: after the double send its projection base
  // no longer matched the model, its note had lost the word and every edit
  // of the paragraph was refused (INVALID_INTENT, LOCAL_SAVE_FAILED). Built
  // here directly: B shows the word twice, A's stored base has it three
  // times, A's note lost it. A heals by itself: its note shows the model's
  // text, nothing is deleted at B, the badge is CURRENT, and A says so.
  it("a vault whose base drifted from the model shows the model again, deletes nothing (C)", async () => {
    const L = b.files.get("B.md").split("\n");
    const at = L.findIndex((l) => l.startsWith("A paragraph"));
    L[at] = `${L[at]}\u3000日本`;
    b.files.set("B.md", L.join("\n"));
    await b.pass("B.md");
    const twice = `${TYPED}\u3000日本`;
    await browser.waitUntil(
      () =>
        inA(({ app, obsidian }) =>
          app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue().split("\n").find((l) => l.startsWith("A paragraph")),
        ).then((l) => l === twice),
      { timeout: 20_000, timeoutMsg: "B's word shown in A" },
    );
    await browser.pause(1000);
    const out = await inA(async ({ app, obsidian }, twice) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = app.plugins.plugins["shared-tasks"];
      const state = p.runtime.localState;
      const [projection] = (await state.get("section-projections:IME.md")) ?? [];
      const base = await state.get(`section-base:${projection}`);
      const pid = Object.entries(base.state.nodes).find(([, n]) => n.kind === "paragraph")[0];
      // The drifted base: one word more than the model.
      await state.put(`section-base:${projection}`, {
        ...base,
        state: { ...base.state, nodes: { ...base.state.nodes, [pid]: { ...base.state.nodes[pid], text: `${twice}\u3000日本` } } },
      });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const cm = view.editor.cm;
      const d = cm.state.doc;
      let line = null;
      for (let n = 1; n <= d.lines; n++) if (d.line(n).text.startsWith("A paragraph")) line = d.line(n);
      // The note lost the word (in C, by the bug): the paragraph back to "A paragraph for typing. ".
      cm.dispatch({ changes: { from: line.from + 24, to: line.to }, userEvent: "delete" });
      const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
      const read = () => {
        const doc = p.runtime.sectionProfile(R).replica.toJSON();
        return {
          note: view.editor.getValue().split("\n").find((l) => l.startsWith("A paragraph")),
          model: String(Object.values(doc.nodes ?? {}).find((n) => n.kind === "paragraph")?.text ?? ""),
          badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
        };
      };
      let now = read();
      for (let i = 0; i < 120 && !(now.note === twice && now.badge === "CURRENT"); i++) {
        await sleep(100);
        now = read();
      }
      const notices = [...document.querySelectorAll(".notice")].map((n) => n.textContent);
      return { now, notice: notices.some((t) => t.includes("was put back into this note")) };
    }, twice);
    for (let i = 0; i < 3; i++) await b.pass("B.md");
    const bLines = content(b.files.get("B.md"));
    evidence("C-heal", { ...out, b: bLines.filter((l) => l.startsWith("A paragraph")) });
    expect(out.now).toEqual({ note: twice, model: twice, badge: "CURRENT" });
    expect(out.notice).toBe(true);
    expect(bLines.filter((l) => l.startsWith("A paragraph"))).toEqual([twice]);
  });

  // The owner's check of 0.4.0-beta.7 in that healed vault: Backspace twice
  // and a composed word right after the heal were replaced, a moment later,
  // by older text ("日本本本"). The typed text stays and syncs; nothing ever
  // shows older text.
  it("typing right after the heal stays, syncs, and nothing older comes back", async () => {
    const twice = `${TYPED}\u3000日本`;
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("A paragraph"));
      view.editor.focus();
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
    });
    await browser.keys(["Backspace"]);
    await browser.pause(80);
    await browser.keys(["Backspace"]);
    await browser.pause(150);
    await compose(["ｋ", "か", "かｍ", "かみ"], "紙");
    const expected = `${twice.slice(0, -2)}紙`;
    const seen = await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const out = [];
      for (let i = 0; i < 60; i++) {
        const l = view.editor.getValue().split("\n").find((x) => x.startsWith("A paragraph"));
        if (out.at(-1) !== l) out.push(l);
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    for (let i = 0; i < 4; i++) await b.pass("B.md");
    const bPara = content(b.files.get("B.md")).filter((l) => l.startsWith("A paragraph"));
    evidence("AFTER-HEAL", { seen, b: bPara });
    expect(seen).toEqual([expected]);
    expect(bPara).toEqual([expected]);
  });

  // The same drift, with the user typing in the paragraph while the heal
  // comes (0.4.0-beta.7: a heal pass the typing abandoned left a base the
  // model never had; later Text landed at wrong places or older Text came
  // back). While the user types, the line is never set back and the model
  // takes nothing at a wrong place; once they stop, the note shows the
  // model's text, B is unchanged, and what was typed is kept as a local copy.
  it("typing through a heal: never set back, nothing wrong in the model, the typed text kept", async () => {
    const model0 = await inA(async ({ app, obsidian }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const state = p.runtime.localState;
      const [projection] = (await state.get("section-projections:IME.md")) ?? [];
      const base = await state.get(`section-base:${projection}`);
      const pid = Object.entries(base.state.nodes).find(([, n]) => n.kind === "paragraph")[0];
      const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
      const doc = p.runtime.sectionProfile(R).replica.toJSON();
      const model = String(doc.nodes[pid].text);
      await state.put(`section-base:${projection}`, {
        ...base,
        state: { ...base.state, nodes: { ...base.state.nodes, [pid]: { ...base.state.nodes[pid], text: `${model}\u3000日本` } } },
      });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("A paragraph"));
      view.editor.focus();
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
      return model;
    });
    const samples = [];
    const sample = () =>
      inA(async ({ app, obsidian }) => {
        const p = app.plugins.plugins["shared-tasks"];
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const R = (await p.runtime.registry()).find((x) => x.profile.includes("section")).resourceId;
        const doc = p.runtime.sectionProfile(R).replica.toJSON();
        return {
          note: view.editor.getValue().split("\n").find((l) => l.startsWith("A paragraph")),
          model: String(Object.values(doc.nodes ?? {}).find((n) => n.kind === "paragraph")?.text ?? ""),
        };
      });
    const typed = "abcdefghijklmn";
    for (const ch of typed) {
      await browser.keys(ch);
      await browser.pause(300);
      samples.push({ typed: ch, ...(await sample()) });
    }
    let end = await sample();
    for (let i = 0; i < 80 && end.note !== end.model; i++) {
      await browser.pause(150);
      end = await sample();
    }
    for (let i = 0; i < 4; i++) await b.pass("B.md");
    const bPara = content(b.files.get("B.md")).filter((l) => l.startsWith("A paragraph"));
    const kept = await inA(async ({ app }) => {
      const s = app.plugins.plugins["shared-tasks"].runtime.localState;
      const ids = (await s.get("section-candidates")) ?? [];
      const texts = [];
      for (const id of ids) texts.push((await s.get(`section-candidate:${id}`))?.sourceText ?? "");
      return texts;
    });
    evidence("TYPING-THROUGH-HEAL", { model0, samples, end, b: bPara, keptHasTyped: kept.some((t) => t.includes("abcdefgh")) });
    // While typing: each sample's line ends with everything typed so far.
    samples.forEach((x, i) => expect(x.note.endsWith(typed.slice(0, i + 1))).toBe(true));
    // The model never took Text at a wrong place: it stays what it was.
    for (const x of samples) expect(x.model).toBe(model0);
    expect(end).toEqual({ note: model0, model: model0 });
    expect(bPara).toEqual([model0]);
    expect(kept.some((t) => t.includes(`${model0}${typed}`) || t.includes(typed))).toBe(true);
  });
});
