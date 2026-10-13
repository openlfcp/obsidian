// Backspace at the start of a Task line in Live Preview, the ways the owner
// may place the caret. Their report for 0.4.0-beta.14 (two Tasks joined onto
// the ref lines above them, ATTENTION) came from an older build in their
// vaults; these cases stay as the guard's defence in depth.
// Real keys and a real mouse in vault A, the headless peer B, the reference
// server at LFCP_SERVER_BIN, the owner's note.
// 1. The caret placed four ways (column 0 before the list marker, as the
//    owner had it; a click at the start of the Task's text; End then Home;
//    a click left of the checkbox), on a middle Task and on
//    the first one, then Backspace: no binding line glued to text, B keeps
//    the Task, and Undo makes the note whole when it changed.
// 2. Joins in other shapes a user's edit may take (the line break and the
//    list marker replaced by the marker, as a Backspace; the line break
//    alone as typing; two at once): the note stays, and a Backspace takes
//    the caret to the end of the nearest visible line above.
import {
  checkStep,
  editorA,
  evidence,
  inA,
  lineOf,
  markerProblems,
  mod,
  sectionOf,
  shareAndJoin,
  startPeers,
  stateA,
  titles,
} from "./support/section-checks.mjs";

const HEADING = "## Tasks";
const NOTE = [HEADING, "- [ ] Alpha 4", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta", "", "paragraph 1.", ""].join("\n");
const TITLES = ["Alpha 4", "Beta", "Gamma", "Delta"];

/** Viewport point for `pos` on line `line` (0-based): its text start, or the content's left edge. */
const point = (line, where) =>
  inA(
    ({ app, obsidian }, line, where) => {
      const cm = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.cm;
      const l = cm.state.doc.line(line + 1);
      const block = cm.lineBlockAt(l.from);
      const y = Math.round(cm.documentTop + block.top + block.height / 2);
      // Left of the content, outside the line: never on the checkbox itself.
      if (where === "left") return { x: Math.round(cm.contentDOM.getBoundingClientRect().left) - 8, y };
      const c = cm.coordsAtPos(l.from + (/^[ \t]*[-*+] \[.\] /.exec(l.text)?.[0].length ?? 0), 1);
      return c === null ? null : { x: Math.round(c.left) + 1, y };
    },
    line,
    where,
  );

const click = async ({ x, y }) => {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ x, y, origin: "viewport" })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
  await browser.pause(300);
};

const head = () =>
  editorA((e) => {
    const s = e.cm.state;
    const line = s.doc.lineAt(s.selection.main.head);
    return { line: line.number - 1, ch: s.selection.main.head - line.from };
  });

const PLACE = {
  "column 0, before the list marker": async (title) => {
    await editorA((e, n) => {
      e.focus();
      e.setCursor({ line: n, ch: 0 });
    }, await lineOf(title));
    await browser.pause(150);
  },
  "a click at the start of the Task's text": async (title) => click(await point(await lineOf(title), "text")),
  "End then Home": async (title) => {
    await click(await point(await lineOf(title), "text"));
    await browser.keys(["End"]);
    await browser.pause(100);
    await browser.keys(["Home"]);
    await browser.pause(200);
  },
  "a click left of the checkbox": async (title) => click(await point(await lineOf(title), "left")),
};

const glued = (md) => markerProblems(md).problems.filter((p) => /glued|stray/.test(p));

describe("Backspace at the start of a Task line in Live Preview, the owner's way", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    Object.assign(ctx, await shareAndJoin(ctx.b, "Owner.md", HEADING, NOTE));
    const s = await checkStep("owner shared", ctx);
    expect(s.titles).toEqual(TITLES);
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  for (const [how, place] of Object.entries(PLACE))
    for (const title of ["Beta", "Alpha 4"])
      it(`${how}, ${title}: Backspace glues no binding line to text`, async () => {
        const before = await editorA((e) => e.getValue());
        await place(title);
        const at = await head();
        await browser.keys(["Backspace"]);
        await browser.pause(800);
        const md = await editorA((e) => e.getValue());
        const after = await head();
        evidence(`owner backspace ${how} ${title}`, {
          at,
          after,
          changed: md !== before,
          line: md.split("\n").find((l) => l.includes(title.split(" ")[0])),
          glued: glued(md),
          badge: (await stateA(ctx.R)).badge,
        });
        expect(glued(md)).toEqual([]);
        await ctx.b.pass(ctx.bFile);
        expect(titles(sectionOf(ctx.b.files.get(ctx.bFile)))).toContain(title);
        for (let k = 0; k < 3 && (await editorA((e) => e.getValue())) !== before; k++) {
          await browser.keys([mod, "z"]);
          await browser.pause(500);
        }
        expect(await editorA((e) => e.getValue())).toBe(before);
        const s = await checkStep(`owner backspace ${how} ${title} after`, ctx);
        expect(s.titles).toEqual(TITLES);
      });

  /** Dispatches `make(state)` as the editor would, from a caret at the start of Beta's text. */
  const dispatched = (shape) =>
    editorA((e, shape) => {
      const cm = e.cm;
      const doc = cm.state.doc;
      const lineOfText = (re) => {
        for (let n = 1; n <= doc.lines; n++) if (re.test(doc.line(n).text)) return doc.line(n);
        throw new Error(`no line ${re}`);
      };
      const beta = lineOfText(/^- \[.\] Beta$/);
      const alpha = lineOfText(/^- \[.\] Alpha 4$/);
      const ref = doc.line(beta.number - 1);
      cm.dispatch({ selection: { anchor: beta.from + 6 } });
      const spec =
        shape === "marker kept"
          ? { changes: { from: ref.to, to: beta.from + 6, insert: "- [ ] " }, userEvent: "delete.backward" }
          : shape === "input"
              ? { changes: { from: beta.from - 1, to: beta.from }, userEvent: "input" }
              : {
                  changes: [
                    { from: alpha.from - 1, to: alpha.from },
                    { from: beta.from - 1, to: beta.from },
                  ],
                  userEvent: "delete.backward",
                };
      cm.dispatch(spec);
    }, shape);

  for (const shape of ["marker kept", "input", "two at once"])
    it(`a join dispatched as "${shape}": the note stays`, async () => {
      const before = await editorA((e) => e.getValue());
      await dispatched(shape);
      await browser.pause(300);
      const md = await editorA((e) => e.getValue());
      const after = await head();
      evidence(`owner join ${shape}`, { unchanged: md === before, after });
      expect(md).toBe(before);
      if (shape === "marker kept")
        // A Backspace: the caret at the end of Alpha's line (its ref hidden between).
        expect(after).toEqual({ line: await lineOf("Alpha 4"), ch: "- [ ] Alpha 4".length });
      const s = await checkStep(`owner join ${shape} after`, ctx);
      expect(s.titles).toEqual(TITLES);
    });
});
