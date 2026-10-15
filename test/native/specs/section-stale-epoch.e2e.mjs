// Offline work in vault A across an unrelated removal (§19.1, 0.4.0-beta.15):
// the headless peer B owns a section, A (real Obsidian, Live Preview, real
// keys) and the headless peer C are members. A, its network switched off in
// the renderer, edits a Task's title; B removes C, so the Data Epoch
// rotates; A comes back. A's stale work is re-applied: the edit stays in
// A's note and reaches B, and A ends current. When B changed the same title
// meanwhile, A's edit is not sent on its own: A needs attention, the card
// says so, and "Review conflicts…" offers Keep (send again) or Discard;
// Keep sends it. Up to 0.4.0-beta.14 the edit was silently undone in A's
// note. The reference server at LFCP_SERVER_BIN.
import { peer } from "../peer.bundle.mjs";
import { closeModals, evidence, inA, markerProblems, sectionOf, startPeers, titles } from "./support/section-checks.mjs";

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

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
const noteA = () => inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue());
const outboundA = (hex) =>
  inA(async ({ app }, hex) => {
    const p = app.plugins.plugins["shared-tasks"];
    return (await p.runtime.storage.outbound.list(Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16))))).length;
  }, hex);

describe("offline edits in vault A across an unrelated removal (§19.1)", () => {
  let server;
  let b;
  let c;

  before(async () => {
    await installANet();
    ({ server, b } = await startPeers());
    c = await peer(server.url);
  });

  after(async () => {
    await inA(() => window.__aNet?.on());
    await c?.stop();
    await b?.stop();
    await server?.stop();
  });

  /** B shares [Alpha, Beta, Gamma] under `heading`; A joins and inserts it into `file`; C joins. */
  async function shared(heading, file, { online = true } = {}) {
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    const bFile = `B-${file}`;
    b.files.set(bFile, [heading, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
    const { resource } = await b.share(bFile, heading);
    const R = Buffer.from(resource).toString("hex");
    const link = (await b.collab.invite(resource, "read-write")).link.reveal();
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
    await answer(heading.slice(3));
    await browser.waitUntil(
      () => inA((_, h) => [...document.querySelectorAll(".notice")].some((n) => n.textContent.includes(`joined the shared section "${h}"`)), heading.slice(3)),
      { timeout: 30_000, timeoutMsg: "A joined" },
    );
    await inA(async ({ app, obsidian }, file) => {
      await app.vault.create(file, ["# Joined", "", "Above.", ""].join("\n"));
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && !view.editor.getValue().includes("Above."); i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 2, ch: 0 });
      app.commands.executeCommandById("shared-tasks:insert-section");
    }, file);
    await inA(async ({}, title) => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes(title)).click();
      let ins;
      for (let i = 0; i < 200 && ins === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      ins.click();
    }, heading.slice(3));
    await browser.waitUntil(async () => (await noteA()).includes("<!-- /lfcp-section: "), { timeout: 30_000, timeoutMsg: "inserted" });
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    c.files.set(`C-${file}`, ["# C", "", "Insert below.", ""].join("\n"));
    await c.joinAndInsert((await b.collab.invite(resource, "read-write")).link.reveal(), `C-${file}`, 3);
    for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
      await browser.keys(["Escape"]);
      await browser.pause(200);
    }
    if (online) {
      // One edit of A accepted before it goes offline (A's units chain on it).
      await inA(async ({ app, obsidian }) => {
        const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
        for (let i = 0; i < 40 && !e.hasFocus(); i++) {
          e.focus();
          await new Promise((r) => setTimeout(r, 50));
        }
        const line = e.getValue().split("\n").findIndex((l) => l.includes("] Alpha"));
        e.setCursor({ line, ch: e.getLine(line).length });
      });
      await browser.pause(200);
      await browser.keys(" by A");
      const replica = () => b.runtime.sectionProfile(resource)?.replica;
      await browser.waitUntil(
        async () => JSON.stringify(replica()?.toJSON() ?? {}).includes("Alpha by A"),
        { timeout: 30_000, timeoutMsg: "A's online edit at B" },
      );
      await browser.waitUntil(async () => (await outboundA(R)) === 0, { timeout: 30_000, timeoutMsg: "A's online edit accepted" });
    }
    return { R, resource, bFile };
  }

  /** A offline types `typed` at the end of Beta's line; `meanwhile`; B removes C; A comes back. */
  async function offlineThenRotation(s, typed, meanwhile = async () => undefined) {
    await inA(() => window.__aNet.off());
    await browser.waitUntil(async () => (await badge()) === "OFFLINE", { timeout: 60_000, timeoutMsg: "A offline" });
    await inA(async ({ app, obsidian }) => {
      const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
      for (let i = 0; i < 40 && !e.hasFocus(); i++) {
        e.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      const line = e.getValue().split("\n").findIndex((l) => l.includes("] Beta"));
      e.setCursor({ line, ch: e.getLine(line).length });
    });
    await browser.pause(200);
    await browser.keys(typed);
    await browser.waitUntil(async () => (await outboundA(s.R)) > 0, { timeout: 20_000, timeoutMsg: "A's edit pending" });
    await meanwhile();
    let removed = await b.runtime.revokeSectionAccess(s.resource, c.principal);
    for (let i = 0; i < 40 && removed.kind !== "queued"; i++) {
      await browser.pause(500);
      removed = await b.runtime.revokeSectionAccess(s.resource, c.principal);
    }
    expect(removed.kind).toBe("queued");
    await browser.pause(2000);
    await inA(() => window.__aNet.on());
  }

  const titlesB = (s) => {
    const replica = b.runtime.sectionProfile(s.resource)?.replica;
    return replica === undefined
      ? []
      : replica.tree().tree.filter((e) => e.kind === "task").map((e) => replica.task(e.id)?.task?.title ?? e.id);
  };

  it("a title edit stays in A's note and reaches B; A ends current", async () => {
    const s = await shared("## Stale one", "Stale one.md");
    await offlineThenRotation(s, " edited offline");
    const got = await browser
      .waitUntil(async () => titlesB(s).includes("Beta edited offline"), { timeout: 30_000 })
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 40_000 }).catch(() => false);
    const md = await noteA();
    const diag = await inA(async ({ app }, hex) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
      const b64 = btoa(String.fromCharCode(...R)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const own = (await p.runtime.localState.get(`section-own-ops:${b64}`)) ?? [];
      const open = (await p.runtime.localState.get("section-stale-open")) ?? [];
      const stale = [];
      for (const o of own) {
        const st = await p.runtime.localState.get(`section-stale:${o.operationId}`);
        const units = [];
        for (const u of o.unitIds) units.push((await p.runtime.storage.dataUnits.get(Uint8Array.from(u.match(/../g).map((h) => Number.parseInt(h, 16)))))?.status ?? null);
        stale.push({ op: o.operationId.slice(0, 8), intents: o.intents.map((i) => i.intent), units, state: st?.state ?? null, reason: st?.reason ?? null });
      }
      const access = await p.runtime.canWriteSection(R).catch((e) => ({ error: String(e) }));
      const items = (await p.runtime.storage.outbound.list(R)).map((i) => ({ kind: i.kind, blocked: i.blocked ?? null, attempts: i.attempts ?? null }));
      return { controller: p.sections.staleDiagnostics(b64), own: own.length, open, stale, outbound: items, access: { allowed: access.allowed, reason: access.reason ?? access.error ?? null }, phase: p.runtime.phase(R) };
    }, s.R);
    evidence("STALE1 diag", diag);
    evidence("STALE1", { got, current, titlesA: titles(sectionOf(md)), titlesB: titlesB(s), badge: await badge(), problems: markerProblems(md).problems });
    expect(titles(sectionOf(md))).toEqual(["Alpha by A", "Beta edited offline", "Gamma"]);
    expect(got).toBe(true);
    expect(current).toBe(true);
    expect(markerProblems(md).problems).toEqual([]);
  });

  it("B changed the same title meanwhile: A needs attention, Review conflicts keeps A's edit and sends it", async () => {
    const s = await shared("## Stale two", "Stale two.md");
    const beta = /#task:([0-9a-f-]{36})/.exec((await noteA()).split("\n").find((l, i, L) => L[i - 1]?.includes("] Beta") && l.includes("lfcp-ref")) ?? "")?.[1];
    expect(beta).toBeDefined();
    await offlineThenRotation(s, " by A", async () => {
      await b.port.commit(b.b64(s.resource), [{ intent: "task.set_title", id: beta, title: "Beta by B" }], {
        operationId: crypto.randomUUID(),
      });
    });
    const attention = await browser.waitUntil(async () => (await badge()) === "ATTENTION", { timeout: 30_000 }).catch(() => false);
    // A's offline edit is stale work waiting for review (not a concurrent edit the rotation left in).
    const inReview = await browser
      .waitUntil(
        () =>
          inA(({ app }, hex) => {
            const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
            const b64 = btoa(String.fromCharCode(...R)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const d = app.plugins.plugins["shared-tasks"].sections.staleDiagnostics(b64);
            return (d?.open ?? []).some((o) => o[1] === "review");
          }, s.R),
        { timeout: 30_000 },
      )
      .catch(() => false);
    // The status the card is drawn from follows (LFCP-03-036): it is refreshed
    // a moment after the controller moved the work to review, never left behind.
    const statusReview = await browser
      .waitUntil(
        () =>
          inA(({ app, obsidian }, hex) => {
            const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
            const b64 = btoa(String.fromCharCode(...R)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const md = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue();
            const id = /<!-- lfcp-section: [^#\s]+#section:(\S+) -->/.exec(md)?.[1];
            const v = id === undefined ? undefined : app.plugins.plugins["shared-tasks"].sections.sectionStatus(`${b64}#${id}`);
            return (v?.conditions ?? []).some((c) => c.kind === "stale-work" && c.review > 0 && c.pending === 0);
          }, s.R),
        { timeout: 10_000 },
      )
      .catch(() => false);
    const before = await noteA();
    evidence("STALE2 diag", await inA(async ({ app }, hex) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
      const b64 = btoa(String.fromCharCode(...R)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const own = (await p.runtime.localState.get(`section-own-ops:${b64}`)) ?? [];
      const units = [];
      for (const o of own)
        for (const u of o.unitIds)
          units.push([o.operationId.slice(0, 8), o.intents.map((i) => i.title ?? i.intent).join(","), (await p.runtime.storage.dataUnits.get(Uint8Array.from(u.match(/../g).map((h) => Number.parseInt(h, 16)))))?.status ?? null]);
      return { controller: p.sections.staleDiagnostics(b64), units, outbound: (await p.runtime.storage.outbound.list(R)).length };
    }, s.R));
    const reviewed = await inA(async ({ app }) => {
      app.commands.executeCommandById("shared-tasks:open-section-details");
      const find = async (pred) => {
        for (let i = 0; i < 300; i++) {
          const hit = pred();
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      };
      const card = await find(() => document.querySelector(".modal-container .modal"));
      const cardText = card?.textContent ?? "";
      const review = await find(() => [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Review conflicts…"));
      if (review === null) return { missing: "no Review conflicts…", cardText };
      review.click();
      const keep = await find(() => [...document.querySelectorAll(".openlfcp-recovery-choice")].find((l) => l.textContent.includes("Keep (send again)")));
      if (keep === null) {
        const items = [...document.querySelectorAll(".openlfcp-recovery-item")].map((x) => x.textContent.slice(0, 200));
        return { missing: "no Keep", cardText, items };
      }
      const question = keep.closest(".openlfcp-recovery-item")?.textContent ?? "";
      keep.querySelector("input").click();
      keep.closest(".openlfcp-recovery-item").querySelector("button").click();
      const done = await find(() => document.querySelector(".openlfcp-recovery")?.textContent.includes("Nothing needs a choice now") ?? false);
      return { cardText, question, done };
    });
    await closeModals("Review conflicts");
    const got = await browser
      .waitUntil(async () => titlesB(s).includes("Beta by A"), { timeout: 30_000 })
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 20_000 }).catch(() => false);
    evidence("STALE2", { inReview, statusReview, attention, before: titles(sectionOf(before)), reviewed, got, current, titlesB: titlesB(s), titlesA: titles(sectionOf(await noteA())) });
    expect(attention).toBe(true);
    expect(inReview).toBe(true);
    expect(statusReview).toBe(true);
    // Never overwritten while it waited: A's note kept A's title.
    expect(titles(sectionOf(before))).toEqual(["Alpha by A", "Beta by A", "Gamma"]);
    expect(reviewed.cardText).toContain("could not be sent after an access change");
    expect(reviewed.question).toContain('task title "Beta by A"');
    expect(got).toBe(true);
    expect(current).toBe(true);
  });

  it("a member's first edit, made offline, across the removal: sent again like the others; A ends current", async () => {
    // SDK 0.2.0-beta.8 (§26.2): after a first unit gone stale, the next unit
    // names no previous unit. With 0.2.0-beta.7 it was refused, and the edit
    // stayed in A's note with the section at attention.
    const s = await shared("## Stale three", "Stale three.md", { online: false });
    await offlineThenRotation(s, " first offline");
    const got = await browser
      .waitUntil(async () => titlesB(s).includes("Beta first offline"), { timeout: 30_000 })
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 40_000 }).catch(() => false);
    const md = await noteA();
    evidence("STALE3", { got, current, titlesA: titles(sectionOf(md)), titlesB: titlesB(s), badge: await badge() });
    expect(got).toBe(true);
    expect(current).toBe(true);
    expect(titles(sectionOf(md))).toEqual(["Alpha", "Beta first offline", "Gamma"]);
    expect(markerProblems(md).problems).toEqual([]);
  });
});
