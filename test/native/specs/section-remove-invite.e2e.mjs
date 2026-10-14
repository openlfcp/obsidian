// Remove someone, invite someone new (the soak of 0.4.0-beta.17, finding
// #3): vault A (real Obsidian) shares a section, the headless peer B joins
// it, A removes B's access with "Remove access…" in the section card (the
// Data Epoch rotates), and, with no edit since, A invites a new identity C
// with its own UI. C receives only the new epoch's key: it loads the
// section through a Snapshot of the new epoch, which A publishes by itself
// and the invitation waits for. C must hold the whole section within
// seconds. Then the same after a reload of A's plugin between the removal
// and the invitation. Reference server at LFCP_SERVER_BIN.
import { peer } from "../peer.bundle.mjs";
import {
  checkStep,
  evidence,
  inA,
  inviteFromA,
  removeAccessFromA,
  sectionOf,
  shareAndJoin,
  startPeers,
  titles,
} from "./support/section-checks.mjs";

const NOTE = (heading) => [heading, "- [ ] Alpha", "- [ ] Beta", "  - [ ] Beta one", "- [ ] Gamma", "", "A paragraph.", ""].join("\n");
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

/** A's open Data Epoch of the section (hex Resource), as a string. */
const epochA = (R) =>
  inA(async ({ app }, R) => {
    const runtime = app.plugins.plugins["shared-tasks"].runtime;
    const id = Uint8Array.from(R.match(/../g).map((h) => Number.parseInt(h, 16)));
    const open = (await runtime.storage.control.epochs(id)).find((e) => e.closedBy === null);
    return open === undefined ? null : String(open.epoch);
  }, R);

describe("remove someone, invite someone new: the newcomer loads the section", () => {
  const ctx = {};
  let server;
  const peers = [];

  before(async () => {
    ({ server, b: ctx.b } = await startPeers());
    peers.push(ctx.b);
  });

  after(async () => {
    for (const p of peers) await p.stop().catch(() => undefined);
    await server?.stop();
  });

  /** A new identity joins with `link` and inserts the section: its titles, and how long it took. */
  async function newcomer(link, label) {
    const c = await peer(server.url);
    peers.push(c);
    const file = `${label}.md`;
    c.files.set(file, ["# New", "", "Insert below.", ""].join("\n"));
    const started = Date.now();
    await c.joinAndInsert(link, file, 3);
    const ms = Date.now() - started;
    const snapshots = (await c.runtime.storage.snapshots.list(bytes(ctx.R))).map((s) => String(s.dataEpoch));
    return { c, titles: titles(sectionOf(c.files.get(file))), ms, snapshots };
  }

  it("removed, then invited with no edit since: the newcomer holds the whole section", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Newcomer one.md", "## Newcomer one", NOTE("## Newcomer one")));
    const first = await checkStep("NEWCOMER1 shared", ctx);
    await removeAccessFromA();
    const epoch = await browser.waitUntil(async () => ((await epochA(ctx.R)) === "1" ? "1" : false), {
      timeout: 60_000,
      timeoutMsg: "A's epoch 1",
    });
    const link = await inviteFromA("Newcomer one");
    const c = await newcomer(link, "C one");
    evidence("NEWCOMER1 C", { epoch, titles: c.titles, ms: c.ms, snapshots: c.snapshots });
    expect(c.titles).toEqual(first.titles);
    expect(c.snapshots).toContain("1");
    expect(c.ms).toBeLessThan(30_000);
  });

  it("A's plugin reloaded between the removal and the invitation: the newcomer loads too", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Newcomer two.md", "## Newcomer two", NOTE("## Newcomer two")));
    const first = await checkStep("NEWCOMER2 shared", ctx);
    await removeAccessFromA();
    // The plugin reloads at once (disabled and enabled), before its Snapshot may be out.
    await inA(async ({ app }) => {
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 200 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    });
    await browser.waitUntil(async () => (await epochA(ctx.R)) === "1", { timeout: 60_000, timeoutMsg: "A's epoch 1" });
    // An invitation refuses to start while the removal's records are not at the server: retried as a user would.
    let link = null;
    for (let i = 0; i < 20 && link === null; i++) {
      link = await inviteFromA("Newcomer two").catch(async () => {
        await inA(() => {
          for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
        });
        await browser.pause(1000);
        return null;
      });
    }
    expect(link).not.toBe(null);
    const c = await newcomer(link, "C two");
    evidence("NEWCOMER2 C", { titles: c.titles, ms: c.ms, snapshots: c.snapshots });
    expect(c.titles).toEqual(first.titles);
    expect(c.snapshots).toContain("1");
    expect(c.ms).toBeLessThan(30_000);
  });
});
