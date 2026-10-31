// The install and upgrade path in Obsidian (069, support matrix 0.2): a
// fresh vault each time (reloadObsidian with no plugin enabled: Shared
// Tasks installed, never run), the plugin's files written into it as an
// update writes them, then enabled.
// - A fresh install of this build.
// - 0.3.4, the catalog's version, with 0.1 shared tasks joined from the
//   headless peer B and an edit pending (the server down), updated to this
//   build: the data upgraded, the pending edit sent, the tasks keep
//   syncing both ways, none lost or doubled.
// - 0.4.0-beta.15 with a shared section and an edit pending, updated to
//   this build.
// - Disabled and enabled, uninstalled and installed again: the identity
//   and the collaborations kept.
// The older versions are their GitHub release assets, cached under the
// harness cache (releases/<version>/); a case without them is skipped.
// The reference server at LFCP_SERVER_BIN.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { editorA, evidence, inA, markerProblems, sectionOf, shareAndJoin, titles } from "./support/section-checks.mjs";
import { badge, freshVault, install, noteText, open, outboundA, releaseFiles, typeAfter } from "./support/upgrade.mjs";

/** Answers the open text prompt with `text` (input, then OK). */
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
    await new Promise((r) => setTimeout(r, 300));
  }, text);

/** Picks the suggestion containing `label` in the open chooser. */
const pick = (label) =>
  inA(async ({}, label) => {
    let items = [];
    for (let i = 0; i < 100 && items.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      items = [...document.querySelectorAll(".prompt .suggestion-item")];
    }
    items.find((x) => x.textContent.includes(label)).click();
  }, label);

const closeModals = async () => {
  for (let i = 0; i < 4 && (await inA(() => document.querySelectorAll(".modal-container").length)) > 0; i++) {
    await browser.keys(["Escape"]);
    await browser.pause(200);
  }
};

const count = (md, title) => md.split("\n").filter((l) => l.includes(`] ${title}`)).length;

describe("install and upgrade", () => {
  let server;
  let b;

  before(async () => {
    server = await restartableServer();
    b = await peer(server.url);
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it("a fresh install of this build runs, shares a section and ends current", async () => {
    await freshVault(server);
    const installed = await install("main");
    const { R, bFile } = await shareAndJoin(b, "Fresh.md", "## Fresh", ["## Fresh", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n"));
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000 }).catch(() => false);
    const out = { installed, current, a: titles(sectionOf(await noteText("Fresh.md"))), b: titles(sectionOf(b.files.get(bFile))) };
    evidence("FRESH", out);
    expect(installed.status).toBe("ready");
    expect(installed.upgradedLocalData).toBe(false);
    expect(current).toBe(true);
    expect(out.b).toEqual(out.a);
    void R;
  });

  // Two steps (one test may take 120 s at most): 0.3.4 with its state, then the update.
  let legacyCase = null;
  it("0.3.4 with 0.1 shared tasks joined, syncing, and an edit pending (the server down)", async function () {
    if (releaseFiles("0.3.4") === null) this.skip();
    const t0 = Date.now();
    const at = {};
    await freshVault(server);
    const old = await install("0.3.4");
    expect(old).toMatchObject({ version: "0.3.4", status: "ready" });
    // B's 0.1 collaboration; A joins it and inserts its tasks into a note.
    const L = await b.legacy("Errands", server.url, ["Alpha", "Beta", "Gamma"]);
    await open("Errands.md", "# Errands\n\n", 2);
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:join-collaboration"));
    await answer(L.link);
    await answer("Errands");
    await browser.waitUntil(
      () => inA(async ({ app }) => (await app.plugins.plugins["shared-tasks"].runtime.registry()).length > 0),
      { timeout: 30_000, timeoutMsg: "A joined" },
    );
    await closeModals();
    await open("Errands.md", "# Errands\n\n", 2);
    // Right after the join A may not have B's tasks yet ("no shared tasks yet"): inserted again until they are.
    const inserted = async () => (await noteText("Errands.md")).split("lfcp-ref:").length - 1 === 3;
    for (let i = 0; i < 6 && !(await inserted()); i++) {
      await closeModals();
      await open("Errands.md", "# Errands\n\n", 2);
      await inA(({ app }) => app.commands.executeCommandById("shared-tasks:insert-all-tasks"));
      await pick("Errands");
      await browser.waitUntil(inserted, { timeout: 5_000 }).catch(() => false);
    }
    await browser.waitUntil(inserted, { timeout: 5_000, timeoutMsg: "tasks inserted" });
    at.inserted = Date.now() - t0;
    // 0.1 sync works on 0.3.4: B's rename reaches A.
    await b.legacyRetitle(L.resource, L.ids.Alpha, "Alpha from B");
    await browser.waitUntil(async () => (await noteText("Errands.md")).includes("Alpha from B"), { timeout: 30_000, timeoutMsg: "B's rename on 0.3.4" });
    // The server down: A's edit stays pending.
    await server.down();
    await typeAfter("Beta", " edited offline");
    await inA(({ app }) => app.commands.executeCommandById("editor:save-file"));
    await browser.waitUntil(async () => (await outboundA()) > 0, { timeout: 30_000, timeoutMsg: "A's edit pending" });
    const pending = await outboundA();
    at.pending = Date.now() - t0;
    legacyCase = { old, L, pending, at };
    evidence("FROM 0.3.4 before", { old, pending, at });
  });

  it("… updated to this build: the data upgraded, the pending edit sent, both ways, nothing lost or doubled", async function () {
    if (legacyCase === null) this.skip();
    const { old, L, pending } = legacyCase;
    // The update: this build's files, the plugin enabled again.
    const t0 = Date.now();
    const now = await install("main");
    const state = () =>
      inA(async ({ app }) => {
        const rt = app.plugins.plugins["shared-tasks"]?.runtime;
        if (rt === null || rt === undefined) return { runtime: null };
        const reg = await rt.registry();
        return {
          status: rt.status.kind,
          registry: reg.map((e) => ({ name: e.name ?? e.localName ?? null, state: e.state, profile: e.profile })),
          phases: reg.map((e) => rt.phase(e.resourceId)),
          outbound: rt.storage === null ? null : (await Promise.all(reg.map((e) => rt.storage.outbound.list(e.resourceId)))).map((l) => l.length),
        };
      });
    evidence("FROM 0.3.4 installed", { now, ms: Date.now() - t0, state: await state() });
    if (now.status !== "ready") {
      // Stuck: why, and whether it ends by itself or after Obsidian restarts.
      const why = () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : null;
          return {
            runtimeError: p?.runtimeError ?? null,
            runtime: p?.runtime === null || p?.runtime === undefined ? null : p.runtime.status.kind,
            dbs: dbs?.filter((d) => d.name?.includes("openlfcp")).map((d) => [d.name?.slice(0, 24), d.version]) ?? null,
          };
        });
      evidence("FROM 0.3.4 stuck", { at: Date.now() - t0, ...(await why()) });
      await browser.pause(45_000);
      evidence("FROM 0.3.4 stuck later", { at: Date.now() - t0, ...(await why()) });
      await browser.reloadObsidian();
      const p = await inA(async ({ app }) => {
        // The harness keeps its own plugin list across a reboot: enabled again, as Obsidian would.
        if (!app.plugins.enabledPlugins.has("shared-tasks")) await app.plugins.enablePlugin("shared-tasks");
        const p = app.plugins.plugins["shared-tasks"];
        for (let i = 0; i < 300 && p?.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
        return { runtime: p?.runtime?.status?.kind ?? null, upgraded: p?.runtime?.upgradedLocalData === true };
      });
      evidence("FROM 0.3.4 after Obsidian restart", { at: Date.now() - t0, ...p });
      throw new Error(`stuck after the update: ${JSON.stringify(p)}`);
    }
    await server.up();
    const sent = await browser.waitUntil(async () => (await b.legacyTitles(L.resource)).includes("Beta edited offline"), { timeout: 25_000 }).catch(() => false);
    evidence("FROM 0.3.4 sent", { sent, ms: Date.now() - t0, state: await state(), b: await b.legacyTitles(L.resource) });
    // And after the update, B's change still reaches A.
    await b.legacyRetitle(L.resource, L.ids.Gamma, "Gamma from B");
    const received = await browser.waitUntil(async () => (await noteText("Errands.md")).includes("Gamma from B"), { timeout: 25_000 }).catch(() => false);
    evidence("FROM 0.3.4 received", { received, ms: Date.now() - t0, note: (await noteText("Errands.md")).split("\n").filter((l) => l.includes("- [")) });
    const drained = await browser.waitUntil(async () => (await outboundA()) === 0, { timeout: 20_000 }).catch(() => false);
    const md = await noteText("Errands.md");
    const out = {
      old,
      now,
      pending,
      sent,
      received,
      drained,
      a: ["Alpha from B", "Beta edited offline", "Gamma from B"].map((t) => [t, count(md, t)]),
      refs: md.split("lfcp-ref:").length - 1,
      b: await b.legacyTitles(L.resource),
    };
    evidence("FROM 0.3.4", out);
    expect(now.status).toBe("ready");
    expect(now.upgradedLocalData).toBe(true);
    expect(now.principal).toBe(old.principal);
    expect(sent).toBe(true);
    expect(received).toBe(true);
    expect(drained).toBe(true);
    expect(out.a.every(([, n]) => n === 1)).toBe(true);
    expect(out.refs).toBe(3);
    expect(out.b).toEqual(["Alpha from B", "Beta edited offline", "Gamma from B"]);
  });

  it("0.4.0-beta.15 with a shared section and an edit pending, updated to this build", async function () {
    if (releaseFiles("0.4.0-beta.15") === null) this.skip();
    await freshVault(server);
    const old = await install("0.4.0-beta.15");
    expect(old).toMatchObject({ version: "0.4.0-beta.15", status: "ready" });
    const { R, bFile } = await shareAndJoin(b, "Beta.md", "## Beta", ["## Beta", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "beta.15 current" });
    await server.down();
    await typeAfter("Beta", " edited offline");
    await browser.waitUntil(async () => (await outboundA()) > 0, { timeout: 30_000, timeoutMsg: "A's edit pending" });
    const now = await install("main");
    await server.up();
    await open("Beta.md", "", 0);
    const reached = await browser
      .waitUntil(
        async () => {
          await b.pass(bFile);
          return titles(sectionOf(b.files.get(bFile))).includes("Beta edited offline");
        },
        { timeout: 45_000 },
      )
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 45_000 }).catch(() => false);
    // The typed text reaches the file by Obsidian's own save, about 2 s after
    // the last key; B may have it sooner: the file is read once it shows what
    // A's editor shows.
    const shown = async () => titles(sectionOf(await editorA((e) => e.getValue())));
    const saved = await browser
      .waitUntil(async () => JSON.stringify(titles(sectionOf(await noteText("Beta.md")))) === JSON.stringify(await shown()), { timeout: 10_000 })
      .catch(() => false);
    const md = await noteText("Beta.md");
    const out = { old, now, reached, current, saved, editor: await shown(), a: titles(sectionOf(md)), b: titles(sectionOf(b.files.get(bFile))), problems: markerProblems(md).problems };
    evidence("FROM 0.4.0-beta.15", out);
    expect(now.status).toBe("ready");
    expect(now.principal).toBe(old.principal);
    expect(reached).toBe(true);
    expect(current).toBe(true);
    expect(saved).toBe(true);
    expect(out.a).toEqual(["Alpha", "Beta edited offline", "Gamma"]);
    expect(out.b).toEqual(out.a);
    expect(out.problems).toEqual([]);
    void R;
  });

  it("disabled and enabled, uninstalled and installed again: the identity and the section kept", async () => {
    await freshVault(server);
    const first = await install("main");
    const { bFile } = await shareAndJoin(b, "Kept.md", "## Kept", ["## Kept", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n"));
    await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: "current" });
    // Disabled and enabled.
    const again = await inA(async ({ app }) => {
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const p = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 300 && p.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      return p.runtime.status.kind;
    });
    // Uninstalled (its folder, data.json included, removed), then installed again.
    await inA(async ({ app }) => {
      await app.plugins.uninstallPlugin("shared-tasks");
    });
    const gone = await inA(({ app }) => app.vault.adapter.exists(`${app.vault.configDir}/plugins/shared-tasks`));
    const reinstalled = await install("main");
    await open("Kept.md", "", 0);
    await typeAfter("Beta", " after reinstall");
    const reached = await browser
      .waitUntil(
        async () => {
          await b.pass(bFile);
          return titles(sectionOf(b.files.get(bFile))).includes("Beta after reinstall");
        },
        { timeout: 45_000 },
      )
      .catch(() => false);
    const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 45_000 }).catch(() => false);
    const editorA = await inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue());
    const out = { first, again, gone, reinstalled, reached, current, a: titles(sectionOf(editorA)), b: titles(sectionOf(b.files.get(bFile))) };
    evidence("KEPT", out);
    expect(again).toBe("ready");
    expect(gone).toBe(false);
    expect(reinstalled.status).toBe("ready");
    expect(reinstalled.principal).toBe(first.principal);
    expect(reached).toBe(true);
    expect(current).toBe(true);
    expect(out.b).toEqual(out.a);
  });
});
