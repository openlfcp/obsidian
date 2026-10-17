// One shared section in two panes of vault A (real Obsidian, Live Preview,
// real keys), with the headless peer B and the reference server at
// LFCP_SERVER_BIN: typing in both alternately, a cut in one pane pasted in
// the other (within one pass, and after the cut's pass wrote), Move line in
// one pane while the other has focus, a pane closed with an edit or a cut
// its pass has not seen yet. Then two copies of the section in two notes,
// side by side: typing in each, a Task cut in one copy and pasted in the
// other. After each step: no stray marker text, every ID bound once, the
// section balanced, A's model in the note's order, B's model A's; a moved
// Task keeps its ID (the hints of every view of the note go to one pass).
import {
  caret,
  checkStep,
  editorA,
  evidence,
  inA,
  lineOf,
  markerProblems,
  mod,
  opsA,
  recordOps,
  sectionOf,
  settle,
  shareAndJoin,
  startPeers,
  stateA,
  titles,
} from "./support/section-checks.mjs";

const NOTE = ["## Panes", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta", ""].join("\n");

/** Opens `file` in a new split pane next to the active one; window.__panes lists its panes, oldest first. */
const splitPane = (file) =>
  inA(
    async ({ app, obsidian }, file) => {
      const leaf = app.workspace.getLeaf("split");
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      for (let i = 0; i < 40 && !(leaf.view instanceof obsidian.MarkdownView); i++) await new Promise((r) => setTimeout(r, 50));
      window.__panes = [...(window.__panes ?? []).filter((l) => l.view?.file !== undefined && l.parent !== null), leaf];
      return window.__panes.length;
    },
    file,
  );
/** Records the panes showing `file` (in the workspace's order). */
const panesOf = (file) =>
  inA(({ app }, file) => {
    window.__panes = app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === file);
    return window.__panes.length;
  }, file);
/** Runs `fn(editor, leaf, app, ...args)` on pane `i`. */
const inPane = (i, fn, ...args) =>
  inA(
    ({ app }, i, src, ...args) => {
      const leaf = window.__panes[i];
      return (0, eval)(`(${src})`)(leaf.view.editor, leaf, app, ...args);
    },
    i,
    fn.toString(),
    ...args,
  );
const focusPane = async (i) => {
  await inPane(i, (e, leaf, app) => {
    app.workspace.setActiveLeaf(leaf, { focus: true });
    e.focus();
  });
  await browser.pause(150);
};
/** The line of the Task titled `title` in pane `i`, with the caret at `ch` ("end" or a column). */
const caretInPane = (i, title, ch) =>
  inPane(
    i,
    (e, _leaf, _app, title, ch) => {
      const line = e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${title}`));
      e.setCursor({ line, ch: ch === "end" ? e.getLine(line).length : ch });
      return line;
    },
    title,
    ch,
  );
/** Selects the Task titled `title` with its ref line, whole, in pane `i`. */
const selectTask = (i, title) =>
  inPane(
    i,
    (e, _leaf, _app, title) => {
      const line = e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${title}`));
      e.setSelection({ line, ch: 0 }, { line: line + 2, ch: 0 });
    },
    title,
  );
const paneTexts = () => inA(() => window.__panes.map((l) => l.view.editor.getValue()));
/** Whether the Task titled `title` is a line of pane `i`'s text. */
const paneHas = async (i, title) => titles(sectionOf((await paneTexts())[i])).includes(title);
/**
 * The Task titled `title` cut, with its ref line, in pane `i` by the real
 * keys, as the user does it: their pane has the keyboard, and they see the
 * Task leave it. A cut the keys did not make (the editor without focus) is
 * said so here, with the focus facts, not as a later step's wrong titles.
 */
const cutInPane = async (i, title) => {
  await focusPane(i);
  await selectTask(i, title);
  const focus = await inPane(i, (e) => ({ editor: e.hasFocus(), document: document.hasFocus() }));
  await browser.keys([mod, "x"]);
  const gone = await browser.waitUntil(async () => !(await paneHas(i, title)), { timeout: 5_000 }).catch(() => false);
  evidence("PANES cut keys", { pane: i, title, focus, gone });
  if (!gone) throw new Error(`the cut of "${title}" in pane ${i} did not happen (focus ${JSON.stringify(focus)})`);
};
/**
 * Pane `i` shows the cut of `title` made in the other pane. Obsidian brings
 * a change of one view of a note to its other views a moment later (the
 * slower the machine, the later); a user pastes where they see the
 * neighbour, after it moved.
 */
const followed = (i, title) =>
  browser.waitUntil(async () => !(await paneHas(i, title)), {
    timeout: 5_000,
    timeoutMsg: `pane ${i} shows the cut of "${title}"`,
  });
/** The Task ID of each title of A's note. */
const idsByTitle = (md, ids) => Object.fromEntries(titles(sectionOf(md)).map((t, k) => [t, ids[k]]));
/**
 * From now on, the notices A shows and each save of a note by Obsidian
 * (vault "modify"), with the time: Obsidian merges a note saved by one pane
 * into the other pane's unsaved edit, and says so ("modified externally,
 * merging changes automatically"); that merge can insert text twice
 * (adr-0001-spikes S7, LFCP-03-038).
 */
const watchObsidian = () =>
  inA(({ app }) => {
    window.__panesLog = [];
    const t0 = Date.now();
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.classList.contains("notice"))
            window.__panesLog.push({ t: Date.now() - t0, notice: n.textContent });
    }).observe(document.body, { childList: true, subtree: true });
    app.vault.on("modify", (f) => window.__panesLog.push({ t: Date.now() - t0, modify: f.path }));
  });
/** What watchObsidian saw since the last call. */
const obsidianLog = () =>
  inA(() => {
    const log = window.__panesLog ?? [];
    window.__panesLog = [];
    return log;
  });

describe("one shared section in two panes", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    await watchObsidian();
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  /** checkStep, and both panes show the same text. */
  const step = async (label) => {
    // Obsidian's saves and merges are logged whether the step passes or not:
    // a failed one is where they matter.
    const s = await checkStep(label, ctx).catch(async (error) => {
      evidence(`${label} obsidian`, { log: await obsidianLog(), texts: await paneTexts() });
      throw error;
    });
    const texts = await paneTexts();
    evidence(`${label} obsidian`, { log: await obsidianLog() });
    expect(new Set(texts).size).toBe(1);
    return s;
  };

  it("A shares the section, B joins; the note opens in a second pane", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Panes.md", "## Panes", NOTE));
    await panesOf("Panes.md");
    expect(await splitPane("Panes.md")).toBe(2);
    const s = await step("PANES shared");
    expect(s.titles).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("typing in both panes alternately", async () => {
    await focusPane(0);
    await caretInPane(0, "Alpha", "end");
    await browser.keys(" one");
    await focusPane(1);
    await caretInPane(1, "Beta", "end");
    await browser.keys(" two");
    await focusPane(0);
    await caretInPane(0, "Gamma", "end");
    await browser.keys(" three");
    const s = await step("PANES typing");
    expect(s.titles).toEqual(["Alpha one", "Beta two", "Gamma three", "Delta"]);
  });

  it("a cut in one pane pasted in the other within one pass: a move, Gamma keeps its ID", async () => {
    const before = await stateA(ctx.R);
    const ids = idsByTitle(before.md, before.tasks);
    await recordOps();
    await cutInPane(0, "Gamma three");
    await followed(1, "Gamma three");
    // What the paste will insert, as the system clipboard holds it (line endings included).
    evidence("PANES clipboard", {
      text: await inA(() => {
        try {
          return JSON.stringify(window.require("electron").clipboard.readText()).slice(0, 300);
        } catch (e) {
          return `unreadable: ${String(e)}`;
        }
      }),
    });
    await inPane(1, (e, leaf, app) => {
      app.workspace.setActiveLeaf(leaf, { focus: true });
      e.focus();
      const line = e.getValue().split("\n").findIndex((l) => l.includes("] Beta two"));
      e.setCursor({ line, ch: 0 });
    });
    await browser.keys([mod, "v"]);
    const s = await step("PANES cut-paste one pass");
    const ops = await opsA();
    evidence("PANES cut-paste one pass ops", { ops });
    expect(s.titles).toEqual(["Alpha one", "Gamma three", "Beta two", "Delta"]);
    expect(idsByTitle(s.md, s.tasks)).toEqual(ids);
    expect(ops.filter((o) => o.startsWith("task.create") || o.startsWith("node.create"))).toEqual([]);
  });

  it("a cut in one pane, its pass written, pasted in the other: Gamma keeps its ID", async () => {
    const before = await stateA(ctx.R);
    const ids = idsByTitle(before.md, before.tasks);
    await recordOps();
    await cutInPane(1, "Gamma three");
    const cut = await step("PANES cut");
    expect(cut.titles).toEqual(["Alpha one", "Beta two", "Delta"]);
    await focusPane(0);
    await caretInPane(0, "Delta", 0);
    await browser.keys([mod, "v"]);
    const s = await step("PANES paste other pane");
    const ops = await opsA();
    evidence("PANES cut, pass, paste ops", { ops });
    expect(s.titles).toEqual(["Alpha one", "Beta two", "Gamma three", "Delta"]);
    expect(idsByTitle(s.md, s.tasks)).toEqual(ids);
  });

  it("Move line in one pane while the other has focus: the Task moved is the one named", async () => {
    const before = await stateA(ctx.R);
    const ids = idsByTitle(before.md, before.tasks);
    await recordOps();
    await focusPane(1);
    await caretInPane(0, "Delta", 3);
    await inPane(0, (e) => e.exec("swapLineUp"));
    const focused = await inA(({ app }) => app.workspace.activeLeaf === window.__panes[1]);
    const s = await step("PANES move line, other pane focused");
    const ops = await opsA();
    const moved = ops.filter((o) => o.startsWith("node.move:")).map((o) => o.slice("node.move:".length));
    evidence("PANES move line ops", { ops, focused });
    expect(focused).toBe(true);
    expect(s.titles).toEqual(["Alpha one", "Beta two", "Delta", "Gamma three"]);
    expect(idsByTitle(s.md, s.tasks)).toEqual(ids);
    expect(moved).toEqual([ids.Delta]);
  });

  it("a pane closed with an edit its pass has not seen: the edit is kept and synced", async () => {
    const want = titles(sectionOf((await stateA(ctx.R)).md)).map((t) => (t === "Alpha one" ? "Alpha one four" : t));
    await focusPane(0);
    await caretInPane(0, "Alpha one", "end");
    await browser.keys(" four");
    await inA(() => {
      window.__panes[0].detach();
      window.__panes = window.__panes.slice(1);
    });
    const s = await step("PANES closed with an edit");
    expect(s.titles).toEqual(want);
  });

  it("a pane closed with a cut its pass has not seen, pasted in the other pane: a move, Beta keeps its ID", async () => {
    expect(await splitPane("Panes.md")).toBe(2);
    const before = await stateA(ctx.R);
    const ids = idsByTitle(before.md, before.tasks);
    // Beta goes right above the last Task.
    const order = titles(sectionOf(before.md)).filter((t) => t !== "Beta two");
    const last = order[order.length - 1];
    const want = [...order.slice(0, -1), "Beta two", last];
    await recordOps();
    await cutInPane(1, "Beta two");
    await inA(() => {
      window.__panes[1].detach();
      window.__panes = window.__panes.slice(0, 1);
    });
    await focusPane(0);
    await caretInPane(0, last, 0);
    await browser.keys([mod, "v"]);
    const s = await step("PANES closed with a cut, pasted");
    const ops = await opsA();
    evidence("PANES closed with a cut ops", { ops });
    expect(s.titles).toEqual(want);
    expect(idsByTitle(s.md, s.tasks)).toEqual(ids);
  });
});

describe("two copies of one shared section, in two notes side by side", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  /** A's two copies (from their editors), B's note: each sound, the same Tasks in the same order everywhere. */
  const copies = async (label) => {
    const a = await settle(ctx.R);
    let last = null;
    const same = await browser
      .waitUntil(
        async () => {
          await ctx.b.pass(ctx.bFile);
          const texts = await inA(({ app }) =>
            ["Copy one.md", "Copy two.md"].map(
              (f) => app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === f)?.view.editor.getValue() ?? null,
            ),
          );
          const tB = titles(sectionOf(ctx.b.files.get(ctx.bFile)));
          last = { texts, tB, t: texts.map((x) => titles(sectionOf(x ?? ""))) };
          return last.t.every((t) => JSON.stringify(t) === JSON.stringify(tB)) ? last : false;
        },
        { timeout: 30_000 },
      )
      .catch(() => null);
    const problems = (last?.texts ?? []).map((x) => markerProblems(x ?? "").problems);
    const model = await stateA(ctx.R);
    const orders = (last?.texts ?? []).map((x) => JSON.stringify(markerProblems(x ?? "").taskIds) === JSON.stringify(model.tasks));
    evidence(label, { titles: last?.t, titlesB: last?.tB, problems, badge: a.badge, orders });
    if (same === null || problems.some((p) => p.length > 0)) evidence(`${label} notes`, { texts: last?.texts });
    expect(same).not.toBe(null);
    expect(problems).toEqual([[], []]);
    expect(orders).toEqual([true, true]);
    expect(a.badge).toBe("CURRENT");
    return last.tB;
  };

  it("A shares the section in one note and inserts it in a second note; both side by side", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Copy one.md", "## Copies", NOTE.replace("## Panes", "## Copies")));
    await inA(async ({ app, obsidian }) => {
      await app.vault.create("Copy two.md", ["# Elsewhere", "", "Before the copy.", ""].join("\n"));
      const leaf = app.workspace.getLeaf("split");
      await leaf.openFile(app.vault.getFileByPath("Copy two.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.getValue().includes("Before the copy."); i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 3, ch: 0 });
      app.commands.executeCommandById("shared-tasks:insert-section");
    });
    await inA(async () => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes("Copies")).click();
      let ins;
      for (let i = 0; i < 200 && ins === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      ins.click();
    });
    await browser.waitUntil(async () => (await editorA((e) => e.getValue())).includes("<!-- /lfcp-section: "), {
      timeout: 30_000,
      timeoutMsg: "the second copy inserted",
    });
    await inA(({ app }) => {
      window.__panes = ["Copy one.md", "Copy two.md"].map((f) =>
        app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === f),
      );
    });
    expect(await copies("COPIES inserted")).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("typing in each copy alternately", async () => {
    await focusPane(0);
    await caretInPane(0, "Alpha", "end");
    await browser.keys(" in one");
    await browser.pause(1500);
    await focusPane(1);
    await caretInPane(1, "Beta", "end");
    await browser.keys(" in two");
    expect(await copies("COPIES typing")).toEqual(["Alpha in one", "Beta in two", "Gamma", "Delta"]);
  });

  it("a Task cut in one copy and pasted in the other: both copies show it moved, with its ID", async () => {
    const before = await stateA(ctx.R);
    await cutInPane(0, "Gamma");
    // The other copy follows the deletion (it is not taken for the cut's paste): Gamma
    // leaves it, and nothing is held or restored.
    const followed = await browser
      .waitUntil(async () => {
        const [one, two] = await paneTexts();
        return !titles(sectionOf(two)).includes("Gamma") && !titles(sectionOf(one)).includes("Gamma");
      }, { timeout: 15_000 })
      .catch(() => false);
    const afterCut = await stateA(ctx.R);
    evidence("COPIES after the cut", { followed, texts: (await paneTexts()).map((t) => titles(sectionOf(t))), recovery: afterCut.recovery, badge: afterCut.badge });
    expect(followed).toBe(true);
    expect(afterCut.recovery).toEqual([]);
    await focusPane(1);
    await caretInPane(1, "Alpha in one", 0);
    await browser.keys([mod, "v"]);
    expect(await copies("COPIES cut one, paste two")).toEqual(["Gamma", "Alpha in one", "Beta in two", "Delta"]);
    const after = await stateA(ctx.R);
    expect([...after.tasks].sort()).toEqual([...before.tasks].sort());
  });
});

describe("the last cut, after its paste", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  it("a Move line next to a Task cut and pasted earlier names the Task moved", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Cut once.md", "## Cut once", NOTE.replace("## Panes", "## Cut once")));
    await checkStep("STALE shared", ctx);
    const g = await lineOf("Gamma");
    await editorA((e, g) => {
      e.focus();
      e.setSelection({ line: g, ch: 0 }, { line: g + 2, ch: 0 });
    }, g);
    await browser.keys([mod, "x"]);
    await checkStep("STALE cut", ctx);
    await caret(await lineOf("Delta"), 0);
    await browser.keys([mod, "v"]);
    const back = await checkStep("STALE pasted back", ctx);
    expect(back.titles).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    const ids = idsByTitle(back.md, back.tasks);
    await recordOps();
    await caret(await lineOf("Delta"), 3);
    await browser.executeObsidianCommand("editor:swap-line-up");
    const s = await checkStep("STALE moved", ctx);
    const moved = (await opsA()).filter((o) => o.startsWith("node.move:")).map((o) => o.slice("node.move:".length));
    evidence("STALE moved ops", { moved });
    expect(s.titles).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    expect(moved).toEqual([ids.Delta]);
  });
});
