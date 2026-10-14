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
        return seen;
      }, line);
    // Obsidian's close button (1.13 and 1.14): the modal's first child,
    // `.modal-header-button` with the "x" icon (`.mod-cta` and `.mod-start`
    // are phone-only form-sheet buttons). It is clicked and the modal must be
    // gone, so the next case never sees it. Escape is only the fallback, so
    // that a broken button fails this check and not the next case; whether
    // it was needed is in the evidence.
    const closeByButton = async (label) => {
      const before = await inA(() =>
        [...document.querySelectorAll(".modal-container > .modal")].map((m) => {
          const button = m.querySelector(":scope > .modal-header-button:not(.mod-cta):not(.mod-start)");
          button?.click();
          return { title: m.querySelector(".modal-title")?.textContent ?? null, button: button !== null };
        }),
      );
      const gone = () => inA(() => document.querySelector(".modal-container") === null);
      let closedBy = before.length === 0 ? "none open" : "button";
      try {
        await browser.waitUntil(gone, { timeout: 5_000, interval: 100 });
      } catch {
        closedBy = "Escape";
        await browser.keys("Escape");
        await browser.waitUntil(gone, { timeout: 5_000, interval: 100, timeoutMsg: `the modals after ${label} closed` });
      }
      evidence(`F-05 modals after ${label}`, { before, closedBy });
      return closedBy;
    };
    const out = {};
    out.inside = await run(lines.findIndex((l) => l.startsWith("- [ ] Alpha")));
    out.insideClosedBy = await closeByButton("inside");
    out.outside = await run(lines.findIndex((l) => l.startsWith("- [ ] Outside")));
    out.outsideClosedBy = await closeByButton("outside");
    evidence("F-05 dispatch", out);
    expect(out.inside.title).toBe('Conflicts in "Dispatch"');
    expect(out.inside.body).toContain("Nothing needs a choice now.");
    expect(out.insideClosedBy).toBe("button");
    expect(out.inside.notices.join(" ")).not.toContain("newer version");
    expect(out.outside.title).toBe(null);
    expect(out.outsideClosedBy).toBe("none open");
    expect(out.outside.notices).toEqual(["Shared Tasks: put the cursor on a shared task to resolve its conflicts."]);
  });
});
