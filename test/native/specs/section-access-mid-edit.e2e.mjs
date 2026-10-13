// Access changes in the middle of an edit (gap 8): vault A (real Obsidian)
// shares a section, the headless peer B joins it read-write, the reference
// server at LFCP_SERVER_BIN. B's network is switched off (its WebSocket, in
// this process; the server stays up for A) so that its work is pending when
// A removes its access with "Remove access…" in the section card. Then B
// comes back. B's pending work is held and reported (its batch blocked or
// rejected), never lost from B's note, never in A's; both notes stay sound.
// Cases: an edit pending, and a cut whose paste comes after the removal.
// Then the other way round, for the plugin's own UI: B shares, A joins
// read-write, A (its network switched off in the renderer) edits with real
// keys, B removes A's access, A comes back: the edit stays in A's note,
// held (blocked), A needs attention and its card says the server no longer
// accepts its changes; B never gets it.
//
// What the harness cannot do (no path in the plugin, the SDK or lfcp-admin):
// make an existing member read-only (grants come only from invitations, and
// a member's join answers "already-member"), and give access back to a
// removed member so that its pending work resumes. The first case records
// what a new invitation gives B after the removal.
import {
  checkStep,
  evidence,
  inA,
  installNetSwitch,
  inviteFromA,
  markerProblems,
  removeAccessFromA,
  sectionOf,
  shareAndJoin,
  startPeers,
  stateA,
  titles,
} from "./support/section-checks.mjs";

/** One pass of B's engine with the hints a user's cut and paste give (the peer's pass gives none). */
async function passB(b, file, ctx) {
  const md = b.files.get(file);
  const p = await b.engine.pass(file, md, { caretLine: null, deletedIds: new Set(), origin: "other", ...ctx });
  let out = md;
  for (const c of [...p.changes].sort((x, y) => y.from - x.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  b.files.set(file, out);
  await b.engine.written(p, out);
  return p;
}

const NOTE = (heading) => [heading, "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n");
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("access removed while the member's work is pending", () => {
  const ctx = {};
  let server;
  let net;

  before(async () => {
    net = installNetSwitch();
    ({ server, b: ctx.b } = await startPeers());
  });

  afterEach(async () => {
    net?.on();
    await inA(() => {
      for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
    });
  });

  after(async () => {
    net?.on();
    await ctx.b?.stop();
    await server?.stop();
    net?.restore();
  });

  /** B offline: its sockets closed, its Resource no longer live. */
  async function bOffline() {
    net.off();
    const phase = await browser
      .waitUntil(async () => {
        const p = ctx.b.runtime.phase(bytes(ctx.R));
        return p !== "LIVE" ? p : false;
      }, { timeout: 30_000 })
      .catch(() => "LIVE");
    expect(phase).not.toBe("LIVE");
  }

  /** B's pending outbound units, and its batches' statuses. */
  const bWork = async () => {
    const R = bytes(ctx.R);
    const snap = await ctx.b.runtime.sectionStatusSnapshot(R).catch((e) => ({ error: String(e?.message ?? e) }));
    return {
      outbound: (await ctx.b.runtime.storage.outbound.list(R)).length,
      batches: (snap.batches ?? []).map((x) => x.status),
      error: snap.error ?? null,
    };
  };

  /** After B is back: it knows it lost access, and its pending batch is final (held, not accepted). */
  async function bBackRefused(label) {
    const R = bytes(ctx.R);
    net.on();
    const access = await browser
      .waitUntil(async () => {
        const a = await ctx.b.runtime.canWriteSection(R).catch(() => undefined);
        return a !== undefined && a.allowed === false ? a.reason : false;
      }, { timeout: 60_000 })
      .catch(() => null);
    let work = await bWork();
    for (let i = 0; i < 40 && !work.batches.some((s) => s === "blocked" || s === "rejected"); i++) {
      await browser.pause(500);
      work = await bWork();
    }
    evidence(`${label} B back`, { access, work, phase: ctx.b.runtime.phase(R) });
    expect(access).toMatch(/revoked|not-member|server-refused/);
    expect(work.batches.some((s) => s === "accepted")).toBe(false);
    expect(work.batches.some((s) => s === "blocked" || s === "rejected")).toBe(true);
    return work;
  }

  it("an edit pending at B when A removes its access: held at B, reported, kept in B's note, never in A's", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Access one.md", "## Access one", NOTE("## Access one")));
    await checkStep("ACCESS1 shared", ctx);
    await bOffline();
    ctx.b.files.set(ctx.bFile, ctx.b.files.get(ctx.bFile).replace("- [ ] Beta", "- [ ] Beta edited by B"));
    await ctx.b.pass(ctx.bFile);
    const pending = await bWork();
    evidence("ACCESS1 pending at B", pending);
    expect(pending.outbound).toBeGreaterThan(0);
    const removed = await removeAccessFromA();
    evidence("ACCESS1 removed", { notices: removed.notices });
    await bBackRefused("ACCESS1");
    // B's note keeps its edit, sound; A never gets it.
    await ctx.b.pass(ctx.bFile);
    const mdB = ctx.b.files.get(ctx.bFile);
    const a = await checkStep("ACCESS1 A after", ctx, { withB: false });
    evidence("ACCESS1 notes", { titlesB: titles(sectionOf(mdB)), problemsB: markerProblems(mdB).problems, titlesA: a.titles });
    expect(titles(sectionOf(mdB))).toEqual(["Alpha", "Beta edited by B", "Gamma"]);
    expect(markerProblems(mdB).problems).toEqual([]);
    expect(a.titles).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(a.json).not.toContain("edited by B");
    // Probe for the report: what a new invitation gives a removed member (no assertion).
    const link = await inviteFromA("Access one");
    const again = await ctx.b.collab.join(link, { name: "Again" }).catch((e) => ({ kind: "threw", message: String(e?.message ?? e) }));
    evidence("ACCESS1 invited again", { again: again.kind, access: await ctx.b.runtime.canWriteSection(bytes(ctx.R)).catch(() => null) });
  });

  it("a cut pending at B, A removes its access, then B pastes: nothing moves or goes at A; B's note keeps the Task", async () => {
    Object.assign(ctx, await shareAndJoin(ctx.b, "Access two.md", "## Access two", NOTE("## Access two")));
    const first = await checkStep("ACCESS2 shared", ctx);
    await bOffline();
    // B cuts Gamma (with its ref line) and its pass runs: a deletion, pending.
    const L = ctx.b.files.get(ctx.bFile).split("\n");
    const at = L.findIndex((l) => l.includes("] Gamma"));
    const gamma = L.splice(at, 2);
    const gammaId = /#task:([0-9a-f-]{36})/.exec(gamma[1])[1];
    ctx.b.files.set(ctx.bFile, L.join("\n"));
    await passB(ctx.b, ctx.bFile, { deletedIds: new Set([gammaId]), cut: new Set([gammaId]) });
    const cut = await bWork();
    evidence("ACCESS2 cut pending at B", cut);
    expect(cut.outbound).toBeGreaterThan(0);
    await removeAccessFromA();
    // Then B pastes it above Beta, and its pass runs.
    const P = ctx.b.files.get(ctx.bFile).split("\n");
    P.splice(
      P.findIndex((l) => l.includes("] Beta")),
      0,
      ...gamma,
    );
    ctx.b.files.set(ctx.bFile, P.join("\n"));
    await passB(ctx.b, ctx.bFile, { cut: new Set([gammaId]), inserted: new Set([gammaId]) });
    await bBackRefused("ACCESS2");
    await ctx.b.pass(ctx.bFile);
    const mdB = ctx.b.files.get(ctx.bFile);
    const a = await checkStep("ACCESS2 A after", ctx, { withB: false });
    evidence("ACCESS2 notes", { titlesB: titles(sectionOf(mdB)), problemsB: markerProblems(mdB).problems, titlesA: a.titles });
    expect(titles(sectionOf(mdB))).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(markerProblems(mdB).problems).toEqual([]);
    expect(a.titles).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(a.tasks).toEqual(first.tasks);
    expect((await stateA(ctx.R)).recovery).toEqual([]);
  });
});

describe("vault A loses its access while its own edit is pending", () => {
  const ctx = {};
  let server;

  /** A's network, switchable in the renderer (its runtime takes window.WebSocket at each connection). */
  const installANet = () =>
    inA(() => {
      if (window.__aNet !== undefined) return;
      const Real = window.WebSocket;
      const open = new Set();
      let offline = false;
      window.WebSocket = class extends Real {
        constructor(url, protocols) {
          super(offline ? "ws://127.0.0.1:9/v1/ws" : url, protocols);
          open.add(this);
          this.addEventListener("close", () => open.delete(this));
        }
      };
      window.__aNet = {
        off() {
          offline = true;
          for (const s of open) s.close();
        },
        on() {
          offline = false;
        },
      };
    });
  const badge = () =>
    inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null);
  const aWork = () =>
    inA(async ({ app }, hex) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
      const snap = await p.runtime.sectionStatusSnapshot(R).catch((e) => ({ error: String(e?.message ?? e) }));
      const access = await p.runtime.canWriteSection(R).catch(() => null);
      return {
        outbound: (await p.runtime.storage.outbound.list(R)).length,
        batches: (snap.batches ?? []).map((x) => x.status),
        access: access?.allowed === false ? access.reason : access?.allowed === true ? "allowed" : null,
      };
    }, ctx.R);

  before(async () => {
    await installANet();
    ({ server, b: ctx.b } = await startPeers());
  });

  after(async () => {
    await inA(() => window.__aNet?.on());
    await ctx.b?.stop();
    await server?.stop();
  });

  it("A, offline with an edit, is removed by B: the edit is kept in A's note, held and said, never sent", async () => {
    // B shares a section and invites A to edit it; A joins and inserts it into a note.
    ctx.bFile = "B-own.md";
    ctx.b.files.set(ctx.bFile, ["## From B", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
    const shared = await ctx.b.share(ctx.bFile, "## From B");
    ctx.R = Buffer.from(shared.resource).toString("hex");
    const link = (await ctx.b.collab.invite(shared.resource, "read-write")).link.reveal();
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:join-collaboration"));
    const answer = (text) =>
      inA(async ({}, text) => {
        let input = null;
        for (let i = 0; i < 100 && input === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          input = document.querySelector(".modal-container .modal input");
        }
        input.value = text;
        input.dispatchEvent(new Event("input"));
        [...document.querySelectorAll(".modal-container .modal button")].find((x) => x.textContent === "OK").click();
        await new Promise((r) => setTimeout(r, 200));
      }, text);
    await answer(link);
    await answer("From B");
    await browser.waitUntil(
      () => inA(() => [...document.querySelectorAll(".notice")].some((n) => n.textContent.includes("joined the shared section"))),
      { timeout: 30_000, timeoutMsg: "A joined" },
    );
    await inA(async ({ app, obsidian }) => {
      await app.vault.create("Joined.md", ["# Joined", "", "Above.", ""].join("\n"));
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Joined.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.getValue().includes("Above."); i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 2, ch: 0 });
      app.commands.executeCommandById("shared-tasks:insert-section");
    });
    await inA(async () => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes("From B")).click();
      let ins;
      for (let i = 0; i < 200 && ins === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      ins.click();
    });
    await browser.waitUntil(async () => (await stateA(ctx.R)).md.includes("<!-- /lfcp-section: "), {
      timeout: 30_000,
      timeoutMsg: "the section inserted",
    });
    const joined = await checkStep("ACCESS3 joined", ctx);
    expect(joined.titles).toEqual(["Alpha", "Beta", "Gamma"]);

    // A offline; it edits Beta with real keys; the edit waits.
    await inA(() => window.__aNet.off());
    await browser.waitUntil(async () => (await badge()) === "OFFLINE", { timeout: 60_000, timeoutMsg: "A offline" });
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    await inA(async ({ app, obsidian }) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === "Joined.md");
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
      for (let i = 0; i < 40 && !e.hasFocus(); i++) {
        e.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      const line = e.getValue().split("\n").findIndex((l) => l.includes("] Beta"));
      e.setCursor({ line, ch: e.getLine(line).length });
    });
    await browser.pause(200);
    const focusBefore = await inA(({ app, obsidian }) => ({
      has: app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.hasFocus() ?? null,
      active: `${document.activeElement?.tagName}.${String(document.activeElement?.className ?? "").slice(0, 60)}`,
      modals: document.querySelectorAll(".modal-container").length,
      file: app.workspace.getActiveFile()?.path ?? null,
    }));
    await browser.keys(" edited in A");
    await browser.pause(300);
    evidence("ACCESS3 typed", {
      focusBefore,
      line: (await stateA(ctx.R)).md.split("\n").find((l) => l.includes("] Beta")),
      notices: await inA(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent)),
    });
    let pending = await aWork();
    for (let i = 0; i < 30 && pending.outbound === 0; i++) {
      await browser.pause(500);
      pending = await aWork();
    }
    const betaLine = (await stateA(ctx.R)).md.split("\n").find((l) => l.includes("] Beta"));
    evidence("ACCESS3 pending at A", { ...pending, badge: await badge(), betaLine });
    expect(pending.outbound).toBeGreaterThan(0);

    // B removes A's access; then A comes back.
    const principal = await inA(({ app }) => Buffer.from(app.plugins.plugins["shared-tasks"].runtime.status.principalId).toString("hex"));
    const revoked = await ctx.b.runtime.revokeSectionAccess(shared.resource, Uint8Array.from(Buffer.from(principal, "hex")));
    evidence("ACCESS3 revoked", { kind: revoked.kind });
    expect(revoked.kind).toBe("queued");
    await browser.pause(3000);
    await inA(() => window.__aNet.on());
    let work = await aWork();
    for (let i = 0; i < 120 && !work.batches.some((s) => s === "blocked" || s === "rejected"); i++) {
      await browser.pause(500);
      work = await aWork();
    }
    await browser.pause(2000);
    const a = await stateA(ctx.R);
    const card = await inA(async ({ app }) => {
      app.commands.executeCommandById("shared-tasks:open-section-details");
      let modal;
      for (let i = 0; i < 100 && modal === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = document.querySelector(".modal-container .modal");
      }
      const text = modal?.textContent ?? null;
      for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click();
      return text;
    });
    await ctx.b.pass(ctx.bFile);
    const { problems } = markerProblems(a.md);
    evidence("ACCESS3 A back", { work, badge: a.badge, card: card?.slice(0, 400), titlesA: titles(sectionOf(a.md)), problems, titlesB: titles(sectionOf(ctx.b.files.get(ctx.bFile))) });
    // Kept in A's note, sound; never in B's; held and said, not shown as current.
    expect(titles(sectionOf(a.md))).toEqual(["Alpha", "Beta edited in A", "Gamma"]);
    expect(problems).toEqual([]);
    expect(work.batches.some((s) => s === "accepted")).toBe(false);
    expect(work.batches.some((s) => s === "blocked" || s === "rejected")).toBe(true);
    expect(a.badge).not.toBe("CURRENT");
    expect(card ?? "").toMatch(/not sent|access|removed|refused/i);
    expect(titles(sectionOf(ctx.b.files.get(ctx.bFile)))).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(JSON.stringify(ctx.b.runtime.sectionProfile(shared.resource).replica.toJSON())).not.toContain("edited in A");
  });
});
