// Live Preview around the hidden binding lines of a shared section: real keys
// and a real mouse in vault A, the headless peer B, the reference server at
// LFCP_SERVER_BIN. The section is Tasks only, so its first and last Tasks
// sit right under the hidden start marker and above the hidden end marker.
// Steps: typing at the start and the end of a Task line, Enter at the end of
// the last Task, a paste of two Task lines, a drag of the mouse onto a Task's
// hidden ref line (the selection snaps to the whole line, a copy takes no
// half marker), Backspace at the start of the first Task's text (no longer a
// Task: ATTENTION, nothing deleted at B, Undo makes it whole). After each:
// no stray marker text, every ID bound once, the section's start and end
// balanced, A's model has the note's Tasks in order and B's model is A's.
// Then one-character deletes next to a hidden binding line change nothing:
// Backspace at column 0 under the start marker or a ref (the caret goes to
// the end of the nearest visible line above), Delete at the end of the
// heading above the start marker or of the last ref above the end marker.
import {
  caret,
  checkStep,
  editorA,
  evidence,
  inA,
  lineOf,
  markerProblems,
  mod,
  shareAndJoin,
  startPeers,
  sectionOf,
  stateA,
  titles,
} from "./support/section-checks.mjs";

const NOTE = ["## LP markers", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n");

describe("Live Preview around hidden markers in a shared section", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  it("A shares the section in Live Preview, B joins", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "LP.md", "## LP markers", NOTE));
    const s = await checkStep("LP shared", ctx);
    expect(s.titles).toEqual(["Alpha", "Beta", "Gamma"]);
    const live = await inA(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).getState().source === false,
    );
    expect(live).toBe(true);
  });

  it("typing at the start and the end of a Task line", async () => {
    await caret(await lineOf("Beta"), "text");
    await browser.keys("St ");
    await browser.pause(300);
    await caret(await lineOf("St Beta"), "end");
    await browser.keys(" end");
    const s = await checkStep("LP type start/end", ctx);
    expect(s.titles).toEqual(["Alpha", "St Beta end", "Gamma"]);
  });

  it("Enter at the end of the last Task, then a title", async () => {
    await caret(await lineOf("Gamma"), "end");
    await browser.keys(["Enter"]);
    await browser.pause(300);
    await browser.keys("Delta");
    const s = await checkStep("LP enter last", ctx);
    expect(s.titles).toEqual(["Alpha", "St Beta end", "Gamma", "Delta"]);
  });

  it("a paste of two Task lines", async () => {
    await inA(() => window.require("electron").clipboard.writeText("- [ ] Paste one\n- [ ] Paste two\n"));
    await caret(await lineOf("Gamma"), 0);
    await browser.keys([mod, "v"]);
    const s = await checkStep("LP paste two", ctx);
    expect(s.titles).toEqual(["Alpha", "St Beta end", "Paste one", "Paste two", "Gamma", "Delta"]);
  });

  it("a drag of the mouse across a Task's hidden ref line snaps to whole binding lines", async () => {
    const before = await editorA((e) => e.getValue());
    /** Viewport coordinates of `ch` on `line` (or the middle of the line's text when ch is null). */
    const at = (line, ch) =>
      inA(
        ({ app, obsidian }, line, ch) => {
          const cm = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.cm;
          const l = cm.state.doc.line(line + 1);
          const pos = ch === null ? l.from + Math.floor(l.length / 2) : l.from + ch;
          const c = cm.coordsAtPos(pos);
          return c === null ? null : { x: Math.round(c.left) + 1, y: Math.round((c.top + c.bottom) / 2) };
        },
        line,
        ch,
      );
    // Ref hidden, Beta's line is right under Alpha's; once the selection
    // touches the ref line it shows there, between them.
    const alpha = await lineOf("Alpha");
    const a = await at(alpha, 8);
    const start = await at(await lineOf("St Beta end"), 9);
    expect(a).not.toBe(null);
    expect(start).not.toBe(null);
    const ref = { x: a.x + 60, y: a.y + (start.y - a.y) };
    // From Beta's text up to Alpha's (the ref line shows), then down onto the ref line's middle.
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: start.x, y: start.y, origin: "viewport" })
      .down({ button: 0 })
      .pause(100)
      .move({ x: a.x, y: a.y, origin: "viewport", duration: 300 })
      .pause(300)
      .move({ x: ref.x, y: ref.y, origin: "viewport", duration: 300 })
      .pause(300)
      .up({ button: 0 })
      .perform();
    await browser.pause(300);
    const sel = await editorA((e) => {
      const cm = e.cm;
      const r = cm.state.selection.main;
      const line = cm.state.doc.lineAt(r.head);
      return {
        anchor: r.anchor,
        head: r.head,
        headLine: line.number - 1,
        headLineText: line.text,
        atEdge: r.head === line.from || r.head === line.to,
        refShown: [...cm.contentDOM.querySelectorAll(".cm-line")].some((el) => el.textContent.includes("lfcp-ref:")),
      };
    });
    await browser.keys([mod, "c"]);
    await browser.pause(300);
    const copied = await inA(() => window.require("electron").clipboard.readText());
    evidence("LP drag", { sel, copied: copied.split("\n") });
    const binding = /^[ \t]*<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->[ \t]*$/.test(sel.headLineText);
    // A selection never ends inside a binding line, and a copy never takes half a marker.
    expect(binding && !sel.atEdge).toBe(false);
    // The drag did end on the ref line: the selection snapped to its start (going up).
    expect(binding).toBe(true);
    expect(sel.atEdge).toBe(true);
    expect(sel.anchor).not.toBe(sel.head);
    const strays = copied.split("\n").filter((l) => /lfcp-|<!--|-->/.test(l.replace(/<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*?-->/g, "")));
    expect(strays).toEqual([]);
    await caret(await lineOf("Delta"), "end");
    expect(await editorA((e) => e.getValue())).toBe(before);
    const s = await checkStep("LP drag after", ctx);
    expect(s.titles).toEqual(["Alpha", "St Beta end", "Paste one", "Paste two", "Gamma", "Delta"]);
  });

  it("Backspace at the start of the first Task's text: no longer a Task, kept at B; Undo makes it whole", async () => {
    await caret(await lineOf("Alpha"), "text");
    await browser.keys(["Backspace"]);
    // "- [ ]Alpha" is no Task in Markdown: its ref stays below it; the plugin
    // says ATTENTION and deletes nothing at B.
    await browser.waitUntil(async () => (await stateA(ctx.R)).badge === "ATTENTION", {
      timeout: 20_000,
      timeoutMsg: "A: ATTENTION",
    });
    const a = await stateA(ctx.R);
    await ctx.b.pass(ctx.bFile);
    const { problems } = markerProblems(a.md);
    evidence("LP backspace text start", { line: a.md.split("\n").find((l) => l.includes("Alpha")), problems, badge: a.badge, titlesB: titles(sectionOf(ctx.b.files.get(ctx.bFile))) });
    expect(problems.filter((p) => !p.startsWith("orphaned ref"))).toEqual([]);
    expect(titles(sectionOf(ctx.b.files.get(ctx.bFile)))).toContain("Alpha");
    await browser.keys([mod, "z"]);
    const s = await checkStep("LP backspace text start undone", ctx);
    expect(s.titles).toEqual(["Alpha", "St Beta end", "Paste one", "Paste two", "Gamma", "Delta"]);
  });
});

describe("a one-character delete next to a hidden binding line changes nothing", () => {
  const ctx = {};
  let server;
  const HEADING = "## LP joins";

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    Object.assign(ctx, await shareAndJoin(ctx.b, "LP-joins.md", HEADING, NOTE.replace("## LP markers", HEADING)));
    await checkStep("LP joins shared", ctx);
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  const line = (test) => editorA((e, src) => e.getValue().split("\n").findIndex((0, eval)(`(${src})`)), test.toString());
  const CASES = [
    {
      name: "Backspace at column 0 of the first Task, the start marker hidden above: the caret goes to the heading's end",
      at: async () => ({ line: await lineOf("Alpha"), ch: 0 }),
      key: "Backspace",
      caret: async () => ({ line: await line((l) => l.startsWith("## ")), ch: HEADING.length }),
    },
    {
      name: "Backspace at column 0 of a middle Task, Alpha's ref hidden above: the caret goes to Alpha's end",
      at: async () => ({ line: await lineOf("Beta"), ch: 0 }),
      key: "Backspace",
      caret: async () => ({ line: await lineOf("Alpha"), ch: "- [ ] Alpha".length }),
    },
    {
      name: "Delete at the end of the heading above the start marker: the caret stays",
      at: async () => ({ line: await line((l) => l.startsWith("## ")), ch: "end" }),
      key: "Delete",
      caret: async () => ({ line: await line((l) => l.startsWith("## ")), ch: HEADING.length }),
    },
    {
      name: "Delete at the end of the last Task's ref above the end marker: the caret stays",
      at: async () => ({ line: (await line((l) => l.startsWith("<!-- /lfcp-section:"))) - 1, ch: "end" }),
      key: "Delete",
      caret: async () => {
        const n = (await line((l) => l.startsWith("<!-- /lfcp-section:"))) - 1;
        return { line: n, ch: await editorA((e, n) => e.getLine(n).length, n) };
      },
    },
  ];
  CASES.forEach((c, k) =>
    it(c.name, async () => {
      const at = await c.at();
      await caret(at.line, at.ch);
      const before = await editorA((e) => e.getValue());
      await browser.keys([c.key]);
      await browser.pause(300);
      const after = await editorA((e) => ({ md: e.getValue(), cursor: e.getCursor() }));
      const want = await c.caret();
      evidence(`LP join ${k}`, { key: c.key, at, cursor: after.cursor, want, unchanged: after.md === before });
      expect(after.md).toBe(before);
      expect({ line: after.cursor.line, ch: after.cursor.ch }).toEqual(want);
      const s = await checkStep(`LP join ${k} after`, ctx);
      expect(s.titles).toEqual(["Alpha", "Beta", "Gamma"]);
    }),
  );
});
