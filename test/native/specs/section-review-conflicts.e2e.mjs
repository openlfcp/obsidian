// Review conflicts beyond placement (coverage gap 7), in Obsidian: vault A
// (real Obsidian, Live Preview, real keys) owns a section, the headless peer
// B is a member with the section in a note of its own. B, offline, and A
// change the same Task; B comes back; the conflict is in both models and A
// needs attention. One of them resolves it, A in "Review conflicts…" or B
// as the host applies a choice, and the other finds it resolved. Then both
// notes show the same Tasks, A's badge is CURRENT, and B has nothing to
// review or send. A Task's title changed by both, and a Task A deleted
// while B changed it (Keep it deleted, Restore it). The reference server at
// LFCP_SERVER_BIN.
import { caret, editorA, evidence, inA, installNetSwitch, lineOf, markerProblems, sectionOf, shareAndJoin, startPeers, titles } from "./support/section-checks.mjs";

const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);
const noteA = () => inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue());
const outboundA = (hex) =>
  inA(async ({ app }, hex) => {
    const p = app.plugins.plugins["shared-tasks"];
    return (await p.runtime.storage.outbound.list(Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16))))).length;
  }, hex);

const TEXT = (heading) => [heading, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n");

describe("Review conflicts beyond placement, A and B in each order", () => {
  let server;
  let b;
  let net;

  before(async () => {
    net = installNetSwitch();
    ({ server, b } = await startPeers());
  });

  after(async () => {
    net?.on();
    await b?.stop();
    await server?.stop();
    net?.restore();
  });

  /** The section's ID in B's model (as the plugin reads it). */
  const sectionIdOf = (R) => b.runtime.sectionProfile(R)?.replica.toJSON()?.section?.id;

  /**
   * A shares [Alpha, Beta, Gamma] under `heading`, B joins; B, offline,
   * makes `onB`; A makes `onA` (accepted); B comes back: the item of `kind`
   * is in both models, and A needs attention.
   */
  async function conflict(heading, onA, onB, kind) {
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    const file = `${heading.slice(3)}.md`;
    const { R: hex, bFile } = await shareAndJoin(b, file, heading, TEXT(heading));
    const R = fromHex(hex);
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    const sectionId = sectionIdOf(R);
    net.off();
    await browser.waitUntil(async () => b.runtime.phase(R) !== "LIVE", { timeout: 30_000, timeoutMsg: "B offline" });
    b.files.set(bFile, onB(b.files.get(bFile)));
    await b.pass(bFile);
    await onA();
    await browser.waitUntil(async () => (await outboundA(hex)) === 0, { timeout: 30_000, timeoutMsg: "A's change accepted" });
    net.on();
    const item = await browser
      .waitUntil(async () => b.review(R, sectionId).find((i) => i.kind === kind) ?? false, { timeout: 45_000 })
      .catch(() => null);
    const attention = await browser.waitUntil(async () => (await badge()) === "ATTENTION", { timeout: 30_000 }).catch(() => false);
    evidence(`${heading} conflict`, { item, attention, a: titles(sectionOf(await noteA())), b: titles(sectionOf(b.files.get(bFile))) });
    expect(item).not.toBe(null);
    expect(attention).toBe(true);
    return { hex, R, bFile, sectionId, item };
  }

  /** A's choice in "Review conflicts…": the item whose question has `question`, the choice labelled `label`. */
  const chooseInA = (question, label) =>
    inA(
      async ({ app }, question, label) => {
        app.commands.executeCommandById("shared-tasks:open-section-details");
        const find = async (pred) => {
          for (let i = 0; i < 300; i++) {
            const hit = pred();
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };
        const review = await find(() => [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Review conflicts…"));
        if (review === null) return { missing: "no Review conflicts…" };
        review.click();
        const item = await find(() => [...document.querySelectorAll(".openlfcp-recovery-item")].find((x) => x.textContent.includes(question)));
        if (item === null) {
          const items = [...document.querySelectorAll(".openlfcp-recovery-item")].map((x) => x.textContent.slice(0, 200));
          for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
          return { missing: "no item", items };
        }
        const choice = [...item.querySelectorAll(".openlfcp-recovery-choice")].find((l) => l.textContent.trim() === label);
        if (choice === undefined) {
          const choices = [...item.querySelectorAll(".openlfcp-recovery-choice")].map((l) => l.textContent.trim());
          for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
          return { missing: "no choice", choices };
        }
        choice.querySelector("input").click();
        item.querySelector("button").click();
        const done = await find(() => document.querySelector(".openlfcp-recovery")?.textContent.includes("Nothing needs a choice now") ?? false);
        for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
        return { question: item.textContent.slice(0, 200), done: done === true };
      },
      question,
      label,
    );

  /** Both settled: A CURRENT, B with nothing to review or send, the same Tasks in both notes. */
  async function settled(id, s) {
    const bSettled = await browser
      .waitUntil(
        async () => {
          await b.pass(s.bFile);
          const queued = (await b.runtime.storage.outbound.list(s.R)).length;
          return b.review(s.R, s.sectionId).length === 0 && queued === 0;
        },
        { timeout: 45_000 },
      )
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 45_000 }).catch(() => false);
    await browser
      .waitUntil(async () => {
        await b.pass(s.bFile);
        return JSON.stringify(titles(sectionOf(await noteA()))) === JSON.stringify(titles(sectionOf(b.files.get(s.bFile))));
      }, { timeout: 30_000 })
      .catch(() => false);
    const md = await noteA();
    const again = await b.pass(s.bFile);
    const out = {
      bSettled,
      current,
      badge: await badge(),
      a: titles(sectionOf(md)),
      b: titles(sectionOf(b.files.get(s.bFile))),
      bReview: b.review(s.R, s.sectionId),
      problems: markerProblems(md).problems,
      bAgain: again.pass.changes.length,
    };
    evidence(id, out);
    expect(out.bSettled).toBe(true);
    expect(out.current).toBe(true);
    expect(out.a).toEqual(out.b);
    expect(out.problems).toEqual([]);
    expect(out.bAgain).toBe(0);
    return out;
  }

  /** A types `typed` at the end of Beta's line. */
  const typeOnBeta = (typed) => async () => {
    await caret(await lineOf("Beta"), "end");
    await browser.keys(typed);
    await browser.pause(300);
    await editorA((e) => e.cm.contentDOM.blur());
  };

  /** A deletes Beta with its ref line: from the end of Alpha's ref line to the end of Beta's, Backspace. */
  const deleteBeta = async () => {
    const at = await lineOf("Beta");
    await editorA(
      (e, at) => {
        e.focus();
        e.setSelection({ line: at - 1, ch: e.getLine(at - 1).length }, { line: at + 1, ch: e.getLine(at + 1).length });
      },
      at,
    );
    await browser.keys(["Backspace"]);
    await browser.pause(300);
    await editorA((e) => e.cm.contentDOM.blur());
  };

  const titleConflict = (heading) =>
    conflict(heading, typeOnBeta(" by A"), (md) => md.replace("- [ ] Beta", "- [ ] Beta by B"), "field");

  it("a Task's title changed by both: A chooses B's in Review conflicts, B finds it resolved", async () => {
    const s = await titleConflict("## Titles one");
    expect(s.item).toMatchObject({ field: "title", values: ["Beta by A", "Beta by B"] });
    const chosen = await chooseInA("the title of", "Beta by B");
    evidence("TITLE1 chosen", chosen);
    expect(chosen.done).toBe(true);
    const out = await settled("TITLE1", s);
    expect(out.a).toEqual(["Alpha", "Beta by B", "Gamma"]);
    expect((await b.resolve(s.R, s.sectionId, s.item.key, { value: "Beta by A" })).applied).toBe(false);
  });

  it("a Task's title changed by both: B chooses A's first, A finds it resolved and ends current", async () => {
    const s = await titleConflict("## Titles two");
    expect((await b.resolve(s.R, s.sectionId, s.item.key, { value: "Beta by A" })).applied).toBe(true);
    const out = await settled("TITLE2", s);
    expect(out.a).toEqual(["Alpha", "Beta by A", "Gamma"]);
  });

  const deletedChanged = (heading) =>
    conflict(heading, deleteBeta, (md) => md.replace("- [ ] Beta", "- [ ] Beta changed by B"), "retained");

  it("a Task A deleted while B changed it: A chooses Keep it deleted, B finds it resolved", async () => {
    const s = await deletedChanged("## Deleted one");
    const chosen = await chooseInA("while it was deleted", "Keep it deleted");
    evidence("DELETED1 chosen", chosen);
    expect(chosen.done).toBe(true);
    const out = await settled("DELETED1", s);
    expect(out.a).toEqual(["Alpha", "Gamma"]);
  });

  it("a Task A deleted while B changed it: B chooses Restore first, A shows B's change and ends current", async () => {
    const s = await deletedChanged("## Deleted two");
    expect((await b.resolve(s.R, s.sectionId, s.item.key, { restore: true })).applied).toBe(true);
    const out = await settled("DELETED2", s);
    expect(out.a).toEqual(["Alpha", "Beta changed by B", "Gamma"]);
  });
});
