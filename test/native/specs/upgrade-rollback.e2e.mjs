// Upgrade from the released 0.4.x to this build and rollback to 0.4.2
// (LFCP-03-026, U03-21; docs/devel/reports/upgrade-rollback-0.4-to-0.5.md).
// Each step leaves the state a user has, never a cleared one: vault A (real
// Obsidian) shares a section that the headless peer B joins (keys, identity,
// journals), then with the server down A edits the section (a pending
// queue) and shares a second section, which is created and bound on this
// device but not hosted (an operation left unfinished in its journal). The
// other version is installed as an update installs it, the server comes
// back, and the spec checks:
// - the same identity (Principal), the same Resources, none added;
// - the pending edit reaches B, and B's later edit reaches A (the keys);
// - the unfinished creation goes on under its own operation ID and hosts
//   its own Resource (reconciled, not run again as a new one);
// - no marker problem, no section doubled;
// - no notice about a newer version or an upgrade (rollback).
// The older versions are their GitHub release assets in the harness cache
// (releases/<version>/; native.yml fetches them); a case without them is
// skipped, and a CI run fails on any skip. The reference server at
// LFCP_SERVER_BIN.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { closeModals, evidence, inA, markerProblems, sectionOf, shareAndJoin, titles } from "./support/section-checks.mjs";
import { badge, disable, freshVault, install, noteText, open, outboundA, releaseFiles, typeAfter } from "./support/upgrade.mjs";

/** What A holds: identity, Resources (hosting, queue), open creations, data.json. */
const stateA = () =>
  inA(async ({ app }) => {
    const p = app.plugins.plugins["shared-tasks"];
    const rt = p?.runtime;
    if (rt === null || rt === undefined || rt.storage === null) return { runtime: null };
    const b64 = (u8) => Buffer.from(u8).toString("base64url");
    const hex = (u8) => Buffer.from(u8).toString("hex");
    const resources = [];
    for (const e of await rt.registry())
      resources.push({
        r: b64(e.resourceId),
        profile: e.profile,
        name: e.localName ?? null,
        hosting: (await rt.localState.get(`collab-hosting:${hex(e.resourceId)}`)) ?? null,
        outbound: (await rt.storage.outbound.list(e.resourceId)).length,
      });
    const creations = [];
    for (const id of (await rt.localState.get("section-creates")) ?? []) {
      const e = await rt.localState.get(`section-create:${id}`);
      creations.push({ id, resource: e?.resource ?? null, phase: e?.phase ?? null, path: e?.path ?? null, reason: e?.reason ?? null });
    }
    const data = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/plugins/shared-tasks/data.json`));
    return {
      status: rt.status.kind,
      principal: rt.status.principalId === undefined ? null : hex(rt.status.principalId),
      resources: resources.sort((a, b) => (a.r < b.r ? -1 : 1)),
      creations,
      settings: { keys: Object.keys(data).sort(), dismissedHints: data.dismissedHints ?? null, settingsVersion: data.settingsVersion ?? null },
    };
  });

/** Creation `id` as the journal holds it, and its Resource's hosting mark. */
const creationA = (id) =>
  inA(async ({ app }, id) => {
    const rt = app.plugins.plugins["shared-tasks"]?.runtime;
    if (rt === null || rt === undefined || rt.storage === null) return null;
    const e = await rt.localState.get(`section-create:${id}`);
    if (e === undefined) return { phase: null };
    const hex = Buffer.from(e.resource, "base64url").toString("hex");
    const open = ((await rt.localState.get("section-creates")) ?? []).includes(id);
    return { phase: e.phase, resource: e.resource, open, hosting: (await rt.localState.get(`collab-hosting:${hex}`)) ?? null };
  }, id);

/** Every notice shown from now on is recorded (watchNotices), read by notices(). */
const watchNotices = () =>
  inA(() => {
    window.__lfcpNoticeObserver?.disconnect();
    const seen = new WeakSet();
    const out = [];
    window.__lfcpNotices = out;
    const take = () => {
      for (const n of document.querySelectorAll(".notice"))
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n.textContent ?? "");
        }
    };
    const o = new MutationObserver(take);
    o.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__lfcpNoticeObserver = o;
  });
const notices = () => inA(() => [...(window.__lfcpNotices ?? [])]);
/** A notice a rollback must not show: a newer version needed, an update, local data upgraded. */
const UPDATE_NOTICE = /newer version|update the plugin|upgraded|can no longer|cannot read/i;

/**
 * Shares the section `heading` of a new note `file` with the server down:
 * created and bound on this device, its hosting not done, its creation
 * left open in the journal. The creation's ID, Resource and reason.
 */
async function shareOffline(file, heading, text) {
  await inA(
    async ({ app, obsidian }, file, text) => {
      await app.vault.create(file, text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line: 0, ch: 0 });
      app.commands.executeCommandById("shared-tasks:share-section");
      let share;
      for (let i = 0; i < 80 && share === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        share = [...document.querySelectorAll(".modal-container .modal button")].find((x) => x.textContent === "Share");
      }
      share.click();
    },
    file,
    text,
  );
  const entry = await browser.waitUntil(
    () =>
      inA(async ({ app }, file) => {
        const rt = app.plugins.plugins["shared-tasks"].runtime;
        if (!(await app.vault.adapter.read(file)).includes("<!-- /lfcp-section: ")) return false;
        for (const id of (await rt.localState.get("section-creates")) ?? []) {
          const e = await rt.localState.get(`section-create:${id}`);
          if (e?.path === file && e.phase === "projected" && typeof e.reason === "string")
            return { operationId: id, resource: e.resource, phase: e.phase, reason: e.reason };
        }
        return false;
      }, file),
    { timeout: 90_000, interval: 250, timeoutMsg: `${file}: shared offline, bound, not hosted` },
  );
  await closeModals(`offline share of ${file}`);
  return entry;
}

const TEXT = (heading) => [heading, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n");
const SECOND = (heading) => [heading, "", "- [ ] Later one", "- [ ] Later two", ""].join("\n");

/** The state before a version change: A's section joined by B and current, then offline, an edit pending and a second share unfinished. */
async function prepare(server, b, tag, from) {
  const t0 = Date.now();
  await freshVault(server);
  const old = await install(from);
  expect(old).toMatchObject({ status: "ready" });
  const file = `Plan-${tag}.md`;
  const { R, bFile } = await shareAndJoin(b, file, "## Plan", TEXT("## Plan"));
  await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000, timeoutMsg: `${from}: current` });
  await server.down();
  await typeAfter("Beta", " edited offline");
  await browser.waitUntil(async () => (await outboundA()) > 0, { timeout: 30_000, timeoutMsg: `${from}: A's edit pending` });
  const second = await shareOffline(`Second-${tag}.md`, "## Later", SECOND("## Later"));
  const before = await stateA();
  evidence(`${tag} before`, { from, old, R, second, before, ms: Date.now() - t0 });
  return { from, old, file, R, bFile, second, before };
}

/**
 * `to` installed over the prepared state (disabled, the server back, the
 * new files, enabled), then the checks of the header. The evidence.
 */
async function change(server, b, tag, s, to) {
  const t0 = Date.now();
  // As an update runs: the old plugin stops first; the server is back before the new one starts.
  await disable();
  await server.up();
  await watchNotices();
  const now = await install(to);
  await open(s.file, "", 0);
  const reached = await browser
    .waitUntil(
      async () => {
        await b.pass(s.bFile);
        return titles(sectionOf(b.files.get(s.bFile))).includes("Beta edited offline");
      },
      { timeout: 60_000, interval: 500 },
    )
    .catch(() => false);
  const reconciled = await browser
    .waitUntil(
      async () => {
        const c = await creationA(s.second.operationId);
        return c?.phase === "hosted" && c.hosting === "hosted" && !c.open;
      },
      { timeout: 60_000, interval: 500 },
    )
    .catch(() => false);
  // B's edit reaches A: the section's keys still open it on A.
  b.files.set(s.bFile, b.files.get(s.bFile).replace("] Gamma", "] Gamma from B"));
  await b.pass(s.bFile);
  const received = await browser.waitUntil(async () => (await noteText(s.file)).includes("Gamma from B"), { timeout: 45_000, interval: 500 }).catch(() => false);
  const drained = await browser.waitUntil(async () => (await outboundA()) === 0, { timeout: 30_000, interval: 500 }).catch(() => false);
  const current = await browser.waitUntil(async () => (await badge()) === "CURRENT", { timeout: 30_000 }).catch(() => false);
  await browser.pause(2_000);
  const after = await stateA();
  const mdA = await noteText(s.file);
  const md2 = await noteText(`Second-${tag}.md`);
  const shown = await notices();
  const out = {
    to,
    now,
    reached,
    reconciled,
    received,
    drained,
    current,
    creation: await creationA(s.second.operationId),
    after,
    a: titles(sectionOf(mdA)),
    b: titles(sectionOf(b.files.get(s.bFile))),
    second: titles(sectionOf(md2)),
    sections: { a: mdA.split("<!-- /lfcp-section: ").length - 1, second: md2.split("<!-- /lfcp-section: ").length - 1 },
    problems: [...markerProblems(mdA).problems, ...markerProblems(md2).problems],
    notices: shown,
    ms: Date.now() - t0,
  };
  evidence(`${tag} after`, out);
  expect(now.status).toBe("ready");
  expect(now.upgradedLocalData).toBe(false);
  expect(now.principal).toBe(s.old.principal);
  expect(after.principal).toBe(s.before.principal);
  // The same Resources: none lost, none added (the unfinished creation reused its own).
  expect(after.resources.map((r) => r.r)).toEqual(s.before.resources.map((r) => r.r));
  expect(after.resources.map((r) => r.r)).toContain(s.second.resource);
  expect(out.creation).toMatchObject({ phase: "hosted", resource: s.second.resource, open: false, hosting: "hosted" });
  expect(after.creations).toEqual([]);
  expect(reached).toBe(true);
  expect(reconciled).toBe(true);
  expect(received).toBe(true);
  expect(drained).toBe(true);
  expect(current).toBe(true);
  expect(out.a).toEqual(["Alpha", "Beta edited offline", "Gamma from B"]);
  expect(out.b).toEqual(out.a);
  expect(out.second).toEqual(["Later one", "Later two"]);
  expect(out.sections).toEqual({ a: 1, second: 1 });
  expect(out.problems).toEqual([]);
  expect(shown.filter((n) => UPDATE_NOTICE.test(n))).toEqual([]);
  return out;
}

describe("upgrade from 0.4.x and rollback to 0.4.2 (LFCP-03-026)", () => {
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

  // Two steps per version (a step may take a few minutes): the old state, then the update.
  for (const from of ["0.4.1", "0.4.2"]) {
    const tag = `from-${from}`;
    let s = null;
    it(`${from}: a section shared and joined, then offline: an edit pending, a second share not hosted`, async function () {
      if (releaseFiles(from) === null) this.skip();
      this.timeout(240_000);
      s = await prepare(server, b, tag, from);
      expect(s.old.version).toBe(from);
    });

    it(`… ${from} updated to this build: identity, Resources and keys kept, the edit sent, the share hosted under its own operation`, async function () {
      if (s === null) this.skip();
      this.timeout(300_000);
      await change(server, b, tag, s, "main");
    });
  }

  let back = null;
  it("this build: a section shared and joined, tips hidden, then offline: an edit pending, a second share not hosted", async function () {
    if (releaseFiles("0.4.2") === null) this.skip();
    this.timeout(240_000);
    back = await prepare(server, b, "rollback", "main");
    // A setting only this build has (data.json dismissedHints): 0.4.2 must start with it.
    await inA(({ app }) => app.plugins.plugins["shared-tasks"].setDismissedHints(["first-use"]));
    back.before = await stateA();
    evidence("rollback settings", back.before.settings);
    expect(back.before.settings.dismissedHints).toEqual(["first-use"]);
  });

  it("… rolled back to 0.4.2: identity, Resources and keys kept, the edit sent, the share hosted, no update notice", async function () {
    if (back === null) this.skip();
    this.timeout(300_000);
    const out = await change(server, b, "rollback", back, "0.4.2");
    expect(out.now.version).toBe("0.4.2");
  });

  it("… and this build again: still the same identity and Resources, editing both ways", async function () {
    if (back === null) this.skip();
    this.timeout(240_000);
    const before = await stateA();
    await disable();
    await watchNotices();
    const now = await install("main");
    await open(back.file, "", 0);
    await typeAfter("Alpha", " after the round trip");
    const reached = await browser
      .waitUntil(
        async () => {
          await b.pass(back.bFile);
          return titles(sectionOf(b.files.get(back.bFile))).includes("Alpha after the round trip");
        },
        { timeout: 60_000, interval: 500 },
      )
      .catch(() => false);
    const after = await stateA();
    const md = await noteText(back.file);
    const out = { now, reached, before, after, a: titles(sectionOf(md)), problems: markerProblems(md).problems, notices: await notices() };
    evidence("round trip", out);
    expect(now.status).toBe("ready");
    expect(now.principal).toBe(back.old.principal);
    expect(after.resources.map((r) => r.r)).toEqual(before.resources.map((r) => r.r));
    expect(after.creations).toEqual([]);
    expect(reached).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.notices.filter((n) => UPDATE_NOTICE.test(n))).toEqual([]);
  });
});
