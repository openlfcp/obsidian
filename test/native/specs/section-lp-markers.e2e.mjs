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
// Then Backspace at column 0 of a Task line, the line above it a hidden
// binding line (the start marker, the previous Task's ref): the Task must not
// be glued to that line.
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
  settle,
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

describe("Backspace at the very start of a Task's line, a binding line hidden above it", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  const CASES = [
    ["the first Task, the section's start marker above it", "Alpha", ["Alpha", "Beta", "Gamma"]],
    ["a middle Task, the previous Task's ref line above it", "Beta", ["Alpha", "Beta", "Gamma"]],
  ];
  CASES.forEach(([name, title], k) =>
    it(`${name}: never glues the Task to the binding line; the section stays sound and synced`, async () => {
      const heading = `## LP column zero ${k}`;
      Object.assign(ctx, await shareAndJoin(ctx.b, `LP0-${k}.md`, heading, NOTE.replace("## LP markers", heading)));
      await checkStep(`LP0-${k} shared`, ctx);
      await caret(await lineOf(title), 0);
      await browser.keys(["Backspace"]);
      const a = await settle(ctx.R);
      await ctx.b.pass(ctx.bFile);
      const { problems } = markerProblems(a.md);
      evidence(`LP0-${k} backspace line start`, {
        problems,
        badge: a.badge,
        titlesA: titles(sectionOf(a.md)),
        titlesB: titles(sectionOf(ctx.b.files.get(ctx.bFile))),
        lines: a.md.split("\n").slice(0, 5).map((l) => l.slice(0, 120)),
      });
      // Whatever happened, one Undo makes the section whole again (evidence; asserted below).
      await browser.keys([mod, "z"]);
      const undone = await checkStep(`LP0-${k} undone`, ctx).catch((e) => e);
      expect(problems).toEqual([]);
      expect(a.badge).toBe("CURRENT");
      expect(undone).not.toBeInstanceOf(Error);
    }),
  );
});
