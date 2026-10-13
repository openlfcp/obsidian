// A restart of the plugin in the middle of a pass (coverage gap 5), in
// Obsidian: vault A (real Obsidian, Live Preview, real keys) owns a section,
// the headless peer B is a member. A types on a Task; its pass stops right
// after the journal (or the projection's base) reached a phase, the way a
// quit would leave it: the write is stored, nothing after it runs. The
// plugin is then disabled and enabled again on the same install database.
// The edit is then in the model once (B has it, not twice, not lost), both
// notes show the same Tasks, A is CURRENT, and nothing moves afterwards.
// The reference server at LFCP_SERVER_BIN.
import { caret, editorA, evidence, inA, lineOf, markerProblems, sectionOf, shareAndJoin, startPeers, titles } from "./support/section-checks.mjs";

const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);
const noteA = () => inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue());

/**
 * The next write of A's local state that matches `stop` is stored, then
 * throws: the process stopped there. One shot; `window.__lfcpStopped` says
 * it happened.
 */
const trap = (stop) =>
  inA(({ app }, stop) => {
    const ls = app.plugins.plugins["shared-tasks"].runtime.localState;
    window.__lfcpStopped = false;
    const put = ls.put.bind(ls);
    ls.put = async (key, value) => {
      await put(key, value);
      const hit = stop.startsWith("base") ? key.startsWith("section-base:") : key.startsWith("section-op:") && value?.phase === stop;
      if (hit && !window.__lfcpStopped) {
        window.__lfcpStopped = true;
        ls.put = put;
        throw new Error(`stopped at ${stop}`);
      }
    };
  }, stop);

/** The plugin disabled and enabled again: a new runtime and engine on the same stores. */
const restartA = () =>
  inA(async ({ app }) => {
    await app.plugins.disablePlugin("shared-tasks");
    await app.plugins.enablePlugin("shared-tasks");
    const q = app.plugins.plugins["shared-tasks"];
    const t0 = Date.now();
    for (let i = 0; i < 200 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    return { ms: Date.now() - t0, status: q.runtime === null || q.runtime === undefined ? null : JSON.stringify(q.runtime.status).slice(0, 300) };
  });

describe("a restart of the plugin in the middle of a pass", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  const titlesB = (R) => {
    const replica = b.runtime.sectionProfile(R)?.replica;
    return replica === undefined ? [] : replica.tree().tree.filter((e) => e.kind === "task").map((e) => replica.task(e.id)?.task?.title ?? e.id);
  };

  for (const stop of ["ids-allocated", "committed", "base", "projected"])
    it(`stopped once ${stop === "base" ? "the base was saved" : `the journal was at ${stop}`}: the edit is sent once, A ends current`, async () => {
      for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
        await browser.keys(["Escape"]);
        await browser.pause(200);
      }
      const heading = `## Restart ${stop}`;
      const { R: hex, bFile } = await shareAndJoin(b, `Restart ${stop}.md`, heading, [heading, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
      const R = fromHex(hex);
      await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
      await trap(stop);
      await caret(await lineOf("Beta"), "end");
      await browser.keys(" v2");
      await browser.pause(300);
      await editorA((e) => e.cm.contentDOM.blur());
      const stopped = await browser.waitUntil(() => inA(() => window.__lfcpStopped === true), { timeout: 20_000 }).catch(() => false);
      const restarted = await restartA();
      evidence(`RESTART ${stop} restarted`, restarted);
      const reached = await browser.waitUntil(async () => titlesB(R).includes("Beta v2"), { timeout: 45_000 }).catch(() => false);
      const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 45_000 }).catch(() => false);
      if (!current)
        evidence(`RESTART ${stop} stuck`, await inA(async ({ app }, hex) => {
          const p = app.plugins.plugins["shared-tasks"];
          const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
          const status = p.runtime?.status ?? null;
          const load = p.runtime?.sectionLoad?.(R) ?? null;
          const phase = p.runtime?.phase?.(R) ?? null;
          const queued = p.runtime?.storage == null ? null : (await p.runtime.storage.outbound.list(R)).map((i) => ({ kind: i.kind, attempts: i.attempts, blocked: i.blocked }));
          app.commands.executeCommandById("shared-tasks:open-section-details");
          let m;
          for (let i = 0; i < 100 && m === undefined; i++) {
            await new Promise((r) => setTimeout(r, 50));
            m = document.querySelector(".modal-container .modal");
          }
          const card = m?.textContent?.slice(0, 900) ?? null;
          for (const x of document.querySelectorAll(".modal-container .modal-close-button")) x.click();
          return { status: status === null ? null : JSON.stringify(status).slice(0, 400), load, phase, queued, card };
        }, hex));
      await b.pass(bFile);
      // Nothing moves afterwards: no correction sent at every pass, no title doubled.
      const md = await noteA();
      await browser.pause(4000);
      await b.pass(bFile);
      const out = {
        stopped,
        reached,
        current,
        badge: await badge(),
        a: titles(sectionOf(md)),
        aLater: titles(sectionOf(await noteA())),
        b: titlesB(R),
        bNote: titles(sectionOf(b.files.get(bFile))),
        problems: markerProblems(md).problems,
      };
      evidence(`RESTART ${stop}`, out);
      expect(out.stopped).toBe(true);
      expect(out.reached).toBe(true);
      expect(out.current).toBe(true);
      expect(out.a).toEqual(["Alpha", "Beta v2", "Gamma"]);
      expect(out.aLater).toEqual(out.a);
      expect(out.b).toEqual(out.a);
      expect(out.bNote).toEqual(out.a);
      expect(out.problems).toEqual([]);
    });

  it("the plugin reloaded 20 times in a row: it runs each time, the section ends current", async () => {
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    const heading = "## Reloaded";
    await shareAndJoin(b, "Reloaded.md", heading, [heading, "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n"));
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    const runs = [];
    for (let i = 0; i < 20; i++) {
      // Typing waits to be committed when the reload comes (the stop flushes it).
      await caret(await lineOf("Beta"), "end");
      await browser.keys(`${i % 10}`);
      runs.push(await restartA());
    }
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 45_000 }).catch(() => false);
    const out = { notReady: runs.filter((r) => !r.status?.includes('"ready"')).map((r) => r.status), slowest: Math.max(...runs.map((r) => r.ms)), current, badge: await badge() };
    evidence("RELOADED 20", out);
    expect(out.notReady).toEqual([]);
    expect(out.current).toBe(true);
  });
});
