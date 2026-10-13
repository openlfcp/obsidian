// A collaborator's edits arriving in a row while vault A is idle (0.4.0-beta.13):
// A shares a section in Live Preview, the headless peer B edits a Task's
// title four times, A never touches the editor. Each edit shows in A, and A
// sends no Data Unit of its own (no DATA_PUT): it projects, it never commits.
// Up to 0.4.0-beta.13, every second edit was reverted: the pass read the
// text from before the plugin's own last write, took the difference for the
// user's edit and sent the old title back. Once with the server running,
// once restarted before each edit. The reference server at LFCP_SERVER_BIN.
import { evidence, inA, sectionOf, shareAndJoin, startPeers, stateA, titles } from "./support/section-checks.mjs";

const wire = await import("../../../node_modules/@openlfcp/wire/dist/index.js");
const DATA_PUT = wire.MESSAGE_TYPE.DATA_PUT;

/** Counts the Data Units A puts from now on (its WebSocket, in the renderer; new sockets only). */
const countPuts = () =>
  inA(() => {
    window.__lfcpPuts = [];
    if (window.__lfcpPutsHooked) return;
    window.__lfcpPutsHooked = true;
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      send(data) {
        const u = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (u !== null) {
          let s = "";
          for (const x of u) s += String.fromCharCode(x);
          window.__lfcpPuts.push(btoa(s));
        }
        return super.send(data);
      }
    };
  });
const puts = async () =>
  (await inA(() => window.__lfcpPuts ?? []))
    .map((b) => {
      try {
        return wire.decodeEnvelope(Uint8Array.from(Buffer.from(b, "base64"))).code;
      } catch {
        return null;
      }
    })
    .filter((code) => code === DATA_PUT).length;
const badge = () =>
  inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);

for (const restart of [false, true]) {
  describe(`B's edits in a row while A is idle${restart ? ", the server restarted before each" : ""}`, () => {
    const ctx = {};
    let server;

    before(async () => {
      // Before the plugin restarts with the server: its sockets are counted.
      await countPuts();
      ({ server, b: ctx.b } = await startPeers());
      const heading = restart ? "## Idle restarted" : "## Idle";
      Object.assign(
        ctx,
        await shareAndJoin(ctx.b, `${heading.slice(3)}.md`, heading, [heading, "- [ ] Alpha", "- [ ] Beta", ""].join("\n")),
      );
      await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    });

    after(async () => {
      await ctx.b?.stop();
      await server?.stop();
    });

    for (let k = 1; k <= 4; k++)
      it(`edit ${k} of B shows in A; A sends nothing`, async () => {
        if (restart) {
          await server.down();
          await browser.waitUntil(async () => (await badge()) === "OFFLINE", { timeout: 60_000, timeoutMsg: "A offline" });
          await server.up();
          await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 60_000, timeoutMsg: "A current again" });
          await browser.waitUntil(
            async () => ctx.b.runtime.phase(Uint8Array.from(Buffer.from(ctx.R, "hex"))) === "LIVE",
            { timeout: 60_000, timeoutMsg: "B live again" },
          );
        }
        await countPuts();
        const title = `Alpha, edit ${k} by B`;
        ctx.b.files.set(ctx.bFile, ctx.b.files.get(ctx.bFile).replace(/- \[ \] Alpha.*/, `- [ ] ${title}`));
        await ctx.b.pass(ctx.bFile);
        const shown = await browser
          .waitUntil(async () => (await stateA(ctx.R)).md.includes(title), { timeout: 20_000 })
          .catch(() => false);
        // A few more seconds for anything A would send back.
        await browser.pause(3000);
        await ctx.b.pass(ctx.bFile);
        const a = await stateA(ctx.R);
        const sent = await puts();
        const titlesB = titles(sectionOf(ctx.b.files.get(ctx.bFile)));
        evidence(`IDLE${restart ? " restart" : ""} ${k}`, { shown, sent, titlesA: titles(sectionOf(a.md)), titlesB, badge: a.badge });
        expect(shown).toBe(true);
        expect(titles(sectionOf(a.md))).toEqual([title, "Beta"]);
        expect(titlesB).toEqual([title, "Beta"]);
        expect(sent).toBe(0);
      });
  });
}
