// "Resolve shared task conflict" by where the cursor is (F-05, U03-24), in
// Obsidian: A shares a section (the headless peer B joins it). With the
// cursor on a Task of the section, the command opens that section's
// "Review conflicts…", never the 0.1 resolver and its "needs a newer
// version" advice. On a plain Task below the section, the 0.1 command
// answers as it always did. The reference server at LFCP_SERVER_BIN.
import { evidence, inA, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);

const TEXT = ["## Dispatch", "", "- [ ] Alpha", "", "# Elsewhere", "", "- [ ] Outside", ""].join("\n");

describe("Resolve shared task conflict in and out of a shared section (F-05)", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it("inside: the section's Review conflicts; outside: the 0.1 resolver; no update advice", async () => {
    await shareAndJoin(b, "Dispatch.md", "## Dispatch", TEXT);
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    const out = await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const lines = view.editor.getValue().split("\n");
      const run = async (line) => {
        for (const n of document.querySelectorAll(".notice")) n.remove();
        view.editor.setCursor({ line, ch: 0 });
        app.commands.executeCommandById("shared-tasks:resolve-shared-conflict");
        let modal = null;
        for (let i = 0; i < 20 && modal === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          modal = document.querySelector(".modal-container .modal");
        }
        const seen = {
          line,
          title: modal?.querySelector(".modal-title")?.textContent ?? null,
          body: modal?.textContent.slice(0, 300) ?? null,
          notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent),
        };
        for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
        await new Promise((r) => setTimeout(r, 200));
        return seen;
      };
      return {
        inside: await run(lines.findIndex((l) => l.startsWith("- [ ] Alpha"))),
        outside: await run(lines.findIndex((l) => l.startsWith("- [ ] Outside"))),
      };
    });
    evidence("F-05 dispatch", out);
    expect(out.inside.title).toBe('Conflicts in "Dispatch"');
    expect(out.inside.body).toContain("Nothing needs a choice now.");
    expect(out.inside.notices.join(" ")).not.toContain("newer version");
    expect(out.outside.title).toBe(null);
    expect(out.outside.notices).toEqual(["Shared Tasks: put the cursor on a shared task to resolve its conflicts."]);
  });
});
