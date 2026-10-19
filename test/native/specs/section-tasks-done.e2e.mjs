// LFCP-03-062 (native matrix P2, C-7): the Obsidian Tasks plugin (8.4.0)
// completes a Task of a shared section in Live Preview. Its edit (setLine on
// the Task's line, then setCursor) must leave the Task's binding line
// hidden and the Task bound. Evidence: where the caret is and whether a
// `lfcp-ref` comment is drawn after the toggle, for a plain and a recurring Task.
import { checkStep, editorA, evidence, inA, lineOf, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const NOTE = ["## Tasks done", "- [ ] Alpha", "- [ ] Water 🔁 every day 📅 2026-11-01", "- [ ] Gamma", ""].join("\n");

const drawn = () =>
  inA(({ app, obsidian }) => {
    const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
    const cm = e.cm;
    return {
      caret: e.getCursor().line,
      refDrawn: [...cm.contentDOM.querySelectorAll(".cm-line")].some((el) => el.textContent.includes("lfcp-ref")),
      text: e.getValue(),
    };
  });

describe("Tasks completes a Task of a shared section", () => {
  const ctx = {};
  let server;

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    await inA(async ({ app }) => {
      await app.plugins.enablePlugin("obsidian-tasks-plugin");
    });
    Object.assign(ctx, await shareAndJoin(ctx.b, "Done.md", "## Tasks done", NOTE));
  });

  after(async () => {
    await ctx.b?.stop();
    await server?.stop();
  });

  for (const title of ["Alpha", "Water"]) {
    it(`${title}: the binding line stays hidden after Tasks' toggle`, async () => {
      const line = await lineOf(title);
      await editorA((e, line) => {
        e.focus();
        e.setCursor({ line, ch: 6 });
      }, line);
      await browser.pause(200);
      const before = await drawn();
      expect(before.refDrawn).toBe(false);
      await inA(({ app }) => app.commands.executeCommandById("obsidian-tasks-plugin:toggle-done"));
      await browser.pause(800);
      const after = await drawn();
      evidence("TASKS-DONE", { title, before: before.caret, after: after.caret, refDrawn: after.refDrawn, text: after.text });
      expect(after.text).toMatch(/✅ \d{4}-\d{2}-\d{2}/);
      expect(after.refDrawn).toBe(false);
      const s = await checkStep(`Tasks done ${title}`, ctx);
      expect(s.titles).toContain(title);
    });
  }
});
