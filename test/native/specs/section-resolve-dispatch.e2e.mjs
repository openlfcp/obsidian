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
    const lines = await inA(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue().split("\n"),
    );
    const run = (line) =>
      inA(async ({ app, obsidian }, line) => {
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
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
        return seen;
      }, line);
    // Every modal closed before the next case, so that it never sees this
    // one's: the close buttons clicked (Escape as well, once that was not
    // enough) until none is left. What was open is kept as evidence.
    const closeAll = async (label) => {
      const seen = [];
      try {
        await browser.waitUntil(
          async () => {
            const open = await inA(() => {
              const modals = [...document.querySelectorAll(".modal-container .modal")].map((m) => ({
                title: m.querySelector(".modal-title")?.textContent ?? null,
                closeButton: m.querySelector(".modal-close-button") !== null,
                html: m.outerHTML.slice(0, 300),
              }));
              for (const x of document.querySelectorAll(".modal-container .modal-close-button")) x.click();
              return modals;
            });
            if (open.length === 0) return true;
            seen.push(open);
            if (seen.length > 1) await browser.keys("Escape");
            return false;
          },
          { timeout: 10_000, interval: 250, timeoutMsg: `the modals after ${label} closed` },
        );
      } finally {
        evidence(`F-05 modals after ${label}`, { polls: seen.length, first: seen[0] ?? [], last: seen.at(-1) ?? [] });
      }
    };
    const out = {};
    out.inside = await run(lines.findIndex((l) => l.startsWith("- [ ] Alpha")));
    await closeAll("inside");
    out.outside = await run(lines.findIndex((l) => l.startsWith("- [ ] Outside")));
    await closeAll("outside");
    evidence("F-05 dispatch", out);
    expect(out.inside.title).toBe('Conflicts in "Dispatch"');
    expect(out.inside.body).toContain("Nothing needs a choice now.");
    expect(out.inside.notices.join(" ")).not.toContain("newer version");
    expect(out.outside.title).toBe(null);
    expect(out.outside.notices).toEqual(["Shared Tasks: put the cursor on a shared task to resolve its conflicts."]);
  });
});
