// LFCP-03-068 (D31): screenshots of the 0.3 collaboration from a real
// Obsidian, for the launch material (site, release notes, README, demo). Not
// a spec and not a gate: wdio.conf.mjs picks it only with NATIVE_SHOWCASE=1
// (native.yml: -f showcase=true), never in the normal set.
//
// Two real Obsidian apps (as specs/two-hosts.e2e.mjs): A (shown as the vault
// "Alex") is the harness's own, B ("Sam") a second one of the same version.
// Everything is done from the Shared Tasks pane, its dialogs and the section
// card, never the command palette:
//   1. A opens the pane next to a note: first use, then the share preview.
//   2. A shares "Packing list" and invites; B joins with the link, inserts.
//   3. A edits, B sees it; B edits, A sees it.
//   4. A damages a boundary: the pane's problem row leads to the repair.
//   5. The section card; the pane's copy and detach actions.
// Each moment is shot in the light and the dark theme, 1440x900 (device
// pixel ratio 2 when the driver lets the script ask for it).
//
// Privacy (what a published frame must not show): the sync server's address
// (127.0.0.1:port) is rewritten on screen to https://sync.example.org, the
// vaults are named Alex and Sam on screen, the invitation link is never
// shown (the dialog keeps it hidden; the join field is a password field).
// Before each frame the page text, labels and values are scanned for the
// server address, the machine's user name and paths, the link and its
// secret; a hit fails the run. Frames go to
// $LFCP_SCREENSHOT_DIR/showcase/NN-name-{light,dark}.png (pairs:
// NN-name-{alex,sam}-{light,dark}.png); test/native/showcase/build-media.sh
// makes the side-by-side frames and the demo from them.
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startWdioSession } from "wdio-obsidian-service";
import { restartableServer } from "../peer.bundle.mjs";
import { cacheDir } from "../wdio.conf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const OUT = path.join(process.env.LFCP_SCREENSHOT_DIR ?? path.join(os.tmpdir(), "lfcp-native-screenshots"), "showcase");
const TOOLTIP = "Open Shared Tasks pane";
const SHOWN_SERVER = "https://sync.example.org";
const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const on = (h, fn, ...args) => h.executeObsidian(fn, ...args);

const A_FILE = "Team offsite.md";
const B_FILE = "Trip prep.md";
const TITLE = "Packing list";
const A_TEXT = [
  "# June offsite",
  "",
  "Planning notes for the June offsite.",
  "",
  `## ${TITLE}`,
  "",
  "- [ ] Book the venue 📅 2026-11-03",
  "- [ ] Order name badges 📅 2026-11-05",
  "- [ ] Pack the projector 📅 2026-11-07",
  "",
  "## Private notes",
  "",
  "Ideas that stay in this note.",
  "",
].join("\n");
const B_TEXT = ["# Trip prep", "", "Bring a charger.", ""].join("\n");
const HEADING_LINE = 4;

const hosts = { A: null, B: null };
const names = { A: "Alex", B: "Sam" };
let server;
let forbidden = [];

/** Rewrites what must not be on a frame: the server's address, the vault's name; keeps doing so. */
const mask = (h, who) =>
  on(
    h,
    ({ app }, serverUrl, shown, shownName) => {
      window.__lfcpMask?.disconnect();
      const real = app.vault.getName();
      const host = new URL(serverUrl).host;
      const fixText = (s) => s.split(serverUrl).join(shown).split(host).join(shown.replace(/^https?:\/\//, ""));
      const sweep = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const v = n.nodeValue ?? "";
          if (v.includes(host)) n.nodeValue = fixText(v);
          else if (v.trim() === real && !n.parentElement?.closest(".cm-content, .markdown-preview-view, .nav-file, .nav-folder"))
            n.nodeValue = shownName;
        }
        for (const t of document.querySelectorAll(".titlebar-text")) {
          if (t.textContent?.includes(real)) t.textContent = t.textContent.split(real).join(shownName);
        }
        for (const el of document.querySelectorAll("[aria-label], [title]")) {
          for (const a of ["aria-label", "title"]) {
            const v = el.getAttribute(a);
            if (v?.includes(host)) el.setAttribute(a, fixText(v));
          }
        }
      };
      const obs = new MutationObserver(sweep);
      obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "title"] });
      window.__lfcpMask = obs;
      const css = document.createElement("style");
      css.textContent = ".status-bar-item.plugin-sync, .inline-title { display: none !important; }";
      document.head.appendChild(css);
      sweep();
      return real;
    },
    server.url,
    SHOWN_SERVER,
    names[who],
  );

/** What a frame may not show: found in the page's text, labels and values. */
const leaks = (h) =>
  on(
    h,
    (_o, words) => {
      const seen = [document.body.innerText];
      for (const el of document.querySelectorAll("[aria-label], [title], input, textarea")) {
        for (const a of ["aria-label", "title"]) seen.push(el.getAttribute(a) ?? "");
        if (el instanceof HTMLInputElement && el.type !== "password") seen.push(el.value);
      }
      const text = seen.join("\n");
      return words.filter((w) => w !== "" && text.toLowerCase().includes(w.toLowerCase()));
    },
    forbidden,
  );

const setTheme = (h, mode) =>
  on(
    h,
    async ({ app }, mode) => {
      const dark = mode === "dark";
      const is = () => document.body.classList.contains("theme-dark") === dark;
      const wait = async () => {
        for (let i = 0; i < 40 && !is(); i++) await new Promise((r) => setTimeout(r, 50));
        return is();
      };
      const tries = [
        () => app.setTheme?.(dark ? "obsidian" : "moonstone"),
        () => {
          app.vault.setConfig("theme", dark ? "obsidian" : "moonstone");
          app.updateTheme?.();
        },
        () => app.setTheme?.(dark ? "dark" : "light"),
        // Last resort: the classes Obsidian's own stylesheet keys on.
        () => {
          document.body.classList.toggle("theme-dark", dark);
          document.body.classList.toggle("theme-light", !dark);
        },
      ];
      for (let i = 0; i < tries.length; i++) {
        try {
          tries[i]();
        } catch {}
        if (await wait()) return { ok: true, method: i };
      }
      return { ok: false, method: -1 };
    },
    mode,
  );

/** One moment, both themes: a frame of each host in `who`. Ends in the light theme. */
async function snap(name, who = ["A"]) {
  // A toast over the pane's header hides a frame's point: wait until none is left (it goes after a few seconds).
  for (const w of who)
    await hosts[w].waitUntil(() => on(hosts[w], () => document.querySelector(".notice") === null), { timeout: 12_000, interval: 300 }).catch(() => undefined);
  for (const mode of ["light", "dark"]) {
    for (const w of who) {
      const r = await setTheme(hosts[w], mode);
      if (r.method !== 0) evidence("SHOWCASE theme method", { w, mode, ...r });
      expect(r.ok).toBe(true);
    }
    await hosts.A.pause(500);
    for (const w of who) {
      const hit = await leaks(hosts[w]);
      if (hit.length > 0) evidence("SHOWCASE leak", { name, w, hit: hit.map((x) => (x.length > 40 ? `${x.slice(0, 6)}…(${x.length})` : x)) });
      expect(hit.length).toBe(0);
      const file = who.length === 1 ? `${name}-${mode}.png` : `${name}-${names[w].toLowerCase()}-${mode}.png`;
      await hosts[w].saveScreenshot(path.join(OUT, file));
    }
  }
  for (const w of who) await setTheme(hosts[w], "light");
  await hosts.A.pause(300);
  evidence("SHOWCASE frame", { name, who });
}

/** 1440x900 at device pixel ratio 2, through the driver's DevTools endpoint when it has one. */
async function sizeHost(h, who) {
  // (The window's own size cannot be set through this driver; the DevTools override below fixes the viewport.)
  let cdp = null;
  try {
    const o = h.options;
    const base = `http://${o.hostname ?? "127.0.0.1"}:${o.port}${o.path === undefined || o.path === "/" ? "" : o.path}`;
    const res = await fetch(`${base}/session/${h.sessionId}/goog/cdp/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "Emulation.setDeviceMetricsOverride", params: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false } }),
    });
    cdp = res.status;
  } catch (e) {
    cdp = String(e).slice(0, 200);
  }
  await h.pause(500);
  const view = await h.execute(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
  evidence("SHOWCASE viewport", { who, cdp, ...view });
}

/** The plugin at the server, sections on; the vault emptied of the test vault's notes; the runtime ready. */
const prepare = (h, url) =>
  on(
    h,
    async ({ app }, url) => {
      if (!app.plugins.enabledPlugins.has("shared-tasks")) await app.plugins.enablePlugin("shared-tasks");
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = url;
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 200 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      app.workspace.detachLeavesOfType("markdown");
      for (const f of app.vault.getFiles()) await app.vault.delete(f);
      return q.runtime?.status.kind ?? null;
    },
    url,
  );

/** Creates `file` (if new), opens it in Live Preview with the caret at line/ch; the editor focused. */
const openNote = (h, file, text, line, ch = 0) =>
  on(
    h,
    async ({ app, obsidian }, file, text, line, ch) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      let leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      if (leaf === undefined) {
        leaf = app.workspace.getLeaf("tab");
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      }
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = leaf.view;
      for (let i = 0; i < 60 && !(view instanceof obsidian.MarkdownView && view.editor.getValue() !== ""); i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line, ch });
      view.editor.focus();
    },
    file,
    text,
    line,
    ch,
  );

/** The caret on the first line of `file` that starts with `prefix`. */
const caretOn = (h, file, prefix, ch = 0) =>
  on(
    h,
    ({ app }, file, prefix, ch) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const e = leaf.view.editor;
      const line = e.getValue().split("\n").findIndex((l) => l.startsWith(prefix));
      e.setCursor({ line, ch });
      return line;
    },
    file,
    prefix,
    ch,
  );

const noteOf = (h, file) =>
  on(
    h,
    async ({ app }, file) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      return leaf !== undefined ? leaf.view.editor.getValue() : await app.vault.adapter.read(file);
    },
    file,
  );
const badgeOf = (h, file) =>
  on(
    h,
    ({ app }, file) =>
      app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file)?.view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
    file,
  );

/** An edit of the note as a user's (replaceRange: a user transaction to the engine). */
const editNote = (h, file, fn) =>
  on(
    h,
    ({ app }, src, file) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const e = leaf.view.editor;
      const next = new Function("md", `return (${src})(md)`)(e.getValue());
      e.replaceRange(next, { line: 0, ch: 0 }, { line: e.lineCount(), ch: 0 });
      e.setCursor({ line: 0, ch: 0 });
    },
    fn.toString(),
    file,
  );

const paneText = (h) => on(h, () => document.querySelector(".openlfcp-pane")?.textContent ?? "");
const primary = (h) =>
  on(h, () => {
    const b = document.querySelector(".openlfcp-pane .openlfcp-pane-primary button");
    return b === null ? null : { label: b.textContent, disabled: b.getAttribute("aria-disabled") === "true" };
  });
const clickPrimary = (h) => on(h, () => document.querySelector(".openlfcp-pane .openlfcp-pane-primary button")?.click());
const clickPane = (h, label) =>
  on(
    h,
    (_o, label) => {
      const b = [...document.querySelectorAll(".openlfcp-pane button")].find((x) => x.textContent === label);
      b?.click();
      return b !== undefined;
    },
    label,
  );
const openPane = async (h) => {
  const how = await on(
    h,
    (_o, label) => {
      if (document.querySelector(".openlfcp-pane") !== null) return "open";
      const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
      icon?.click();
      return icon !== null ? "ribbon" : "no ribbon icon";
    },
    TOOLTIP,
  );
  expect(how).not.toBe("no ribbon icon");
  await h.waitUntil(() => on(h, () => document.querySelector(".openlfcp-pane") !== null), { timeout: 10_000, timeoutMsg: "the pane" });
};
const modalWith = (h, part) =>
  h.waitUntil(
    () => on(h, (_o, part) => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 30_000, timeoutMsg: `a dialog with "${part}"` },
  );
const clickIn = (h, part, label) =>
  on(
    h,
    (_o, part, label) => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes(part));
      const b = m && [...m.querySelectorAll("button")].find((x) => x.textContent === label);
      b?.click();
      return b !== undefined && b !== null;
    },
    part,
    label,
  );
const closeModals = async (h) => {
  await on(h, () => {
    for (const m of document.querySelectorAll(".modal-container > .modal"))
      (m.querySelector(":scope > .modal-header-button:not(.mod-cta):not(.mod-start)") ?? m.querySelector(":scope > .modal-close-button"))?.click();
  });
  for (let i = 0; i < 4 && (await on(h, () => document.querySelector(".modal-container") !== null)); i++) {
    await h.pause(300);
    if (await on(h, () => document.querySelector(".modal-container") !== null)) await h.keys("Escape");
  }
};

/** The section titled `title`'s Resource (hex) in `h`, once `file` holds it and it is hosted. */
const resourceOf = (h, file, title) =>
  h.waitUntil(
    () =>
      on(
        h,
        async ({ app }, file, title) => {
          const p = app.plugins.plugins["shared-tasks"];
          if (!(await app.vault.adapter.read(file)).includes("<!-- /lfcp-section: ")) return false;
          for (const e of await p.runtime.registry()) {
            if (!e.profile.includes("section") || e.localName !== title) continue;
            const hex = Buffer.from(e.resourceId).toString("hex");
            return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted" ? hex : false;
          }
          return false;
        },
        file,
        title,
      ),
    { timeout: 90_000, timeoutMsg: `"${title}" shared and hosted` },
  );

/** Both notes show the same Tasks and both badges are CURRENT. */
const converged = (what) =>
  browser.waitUntil(
    async () => {
      const [a, b] = [await noteOf(hosts.A, A_FILE), await noteOf(hosts.B, B_FILE)];
      const tasks = (md) => md.split("\n").filter((l) => /^[ \t]*[-*+] \[.\] /.test(l)).map((l) => l.replace(/\s*<!--.*-->\s*$/, ""));
      return (
        JSON.stringify(tasks(a)) === JSON.stringify(tasks(b)) &&
        (await badgeOf(hosts.A, A_FILE)) === "CURRENT" &&
        (await badgeOf(hosts.B, B_FILE)) === "CURRENT"
      );
    },
    { timeout: 90_000, interval: 500, timeoutMsg: `A and B equal and current: ${what}` },
  );

describe("LFCP-03-068: showcase frames from two real Obsidian apps", function () {
  this.timeout(300_000);
  const ctx = { broken: false, link: null };

  before(async function () {
    this.timeout(600_000);
    mkdirSync(OUT, { recursive: true });
    hosts.A = browser;
    const caps = browser.requestedCapabilities;
    const o = caps["wdio:obsidianOptions"] ?? {};
    const version = o.appVersion ?? process.env.NATIVE_OBSIDIAN;
    hosts.B = await startWdioSession({
      cacheDir,
      logLevel: "warn",
      capabilities: {
        browserName: "obsidian",
        browserVersion: version,
        "wdio:obsidianOptions": {
          installerVersion: o.installerVersion ?? version,
          plugins: [root],
          vault: path.join(here, "../vaults/basic"),
        },
      },
    });
    server = await restartableServer();
    const ready = { A: await prepare(hosts.A, server.url), B: await prepare(hosts.B, server.url) };
    expect(ready).toEqual({ A: "ready", B: "ready" });
    const real = { A: await mask(hosts.A, "A"), B: await mask(hosts.B, "B") };
    const base = await Promise.all(
      ["A", "B"].map((w) => on(hosts[w], ({ app }) => app.vault.adapter.basePath ?? "")),
    );
    forbidden = [
      new URL(server.url).host,
      "127.0.0.1",
      "localhost",
      "#secret=",
      os.userInfo().username,
      os.homedir(),
      os.tmpdir(),
      ...base,
      ...Object.values(real),
    ].filter((w) => w.length >= 4 && !["Alex", "Sam"].includes(w));
    // The vault names are only shown as Alex and Sam; keep them out of the scan's words when they are the same.
    await sizeHost(hosts.A, "A");
    await sizeHost(hosts.B, "B");
    evidence("SHOWCASE hosts", { platform: process.platform, version });
  });

  beforeEach(function () {
    if (ctx.broken) throw new Error("an earlier step failed");
  });
  afterEach(function () {
    if (this.currentTest?.state === "failed") ctx.broken = true;
  });

  after(async function () {
    this.timeout(120_000);
    for (const h of [hosts.A, hosts.B]) if (h !== null) await closeModals(h).catch(() => undefined);
    // The menus setting the pane step changed goes back to what it was.
    if (hosts.A !== null)
      await on(hosts.A, () => {
        if (window.__lfcpNativeMenus === undefined) return;
        window.app.vault.setConfig("nativeMenus", window.__lfcpNativeMenus.value);
        delete window.__lfcpNativeMenus;
      }).catch(() => undefined);
    await hosts.B?.deleteSession().catch(() => undefined);
    hosts.B = null;
    await server?.stop();
  });

  it("01-02 A: the pane next to a note, first use, then the share preview", async () => {
    await openNote(hosts.A, A_FILE, A_TEXT, 2);
    await openPane(hosts.A);
    await openNote(hosts.A, A_FILE, A_TEXT, 2);
    await hosts.A.waitUntil(async () => (await paneText(hosts.A)).includes("put the cursor on its heading"), {
      timeout: 30_000,
      timeoutMsg: "the first-use tip in A's pane",
    });
    await snap("01-pane-first-use");
    await caretOn(hosts.A, A_FILE, `## ${TITLE}`, 3);
    await hosts.A.waitUntil(async () => (await primary(hosts.A))?.label === "Share section…", { timeout: 30_000, timeoutMsg: "Share section… in A's pane" });
    expect(await paneText(hosts.A)).toContain("3 tasks");
    await snap("02-share-preview");
  });

  it("03-05 A: Share section…, the role, the one-time invitation (link hidden, copied)", async () => {
    await clickPrimary(hosts.A);
    await modalWith(hosts.A, `Share section "${TITLE}"`);
    await snap("03-share-dialog");
    expect(await clickIn(hosts.A, `Share section "${TITLE}"`, "Share")).toBe(true);
    await resourceOf(hosts.A, A_FILE, TITLE);
    await hosts.A.waitUntil(
      async () => (await primary(hosts.A))?.label === "Invite collaborator…" && (await paneText(hosts.A)).includes("ready to invite"),
      { timeout: 90_000, timeoutMsg: "A's pane ready to invite" },
    );
    await clickPrimary(hosts.A);
    await hosts.A.waitUntil(() => on(hosts.A, () => document.querySelectorAll(".prompt .suggestion-item").length > 0), { timeout: 20_000, timeoutMsg: "the role choice" });
    await snap("04-invite-role");
    await on(hosts.A, () => [...document.querySelectorAll(".prompt .suggestion-item")].find((x) => x.textContent.startsWith("Read + write"))?.click());
    const invitation = await modalWith(hosts.A, "Invitation (");
    expect(invitation).not.toContain("lfcp://join/");
    const copied = await on(hosts.A, async () => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes("Invitation ("));
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Copy link").click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const notices = [...document.querySelectorAll(".notice")].map((n) => n.textContent);
        if (notices.some((n) => n.includes("link copied"))) return true;
        if (notices.some((n) => n.includes("could not copy"))) return false;
      }
      return null;
    });
    evidence("SHOWCASE link copied", { copied });
    await snap("05-invite-link");
    // The link, as a user would carry it to the other app (read from the dialog, never on a frame).
    ctx.link = await on(hosts.A, () => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes("Invitation ("));
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const value = m.querySelector("input").value;
      [...m.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return value;
    });
    expect(ctx.link.startsWith("lfcp://join/")).toBe(true);
    // From here a frame may show neither the link's secret nor its address.
    forbidden.push(ctx.link.slice(ctx.link.indexOf("#secret=") + 8), ctx.link.slice(0, 40));
    await closeModals(hosts.A);
  });

  it("06-09 B: Join with a link…, the note to insert into, the preview, the result", async () => {
    await openNote(hosts.B, B_FILE, B_TEXT, 3);
    await openPane(hosts.B);
    await openNote(hosts.B, B_FILE, B_TEXT, 3);
    expect(await clickPane(hosts.B, "Join with a link…")).toBe(true);
    // A paste, as a user's: an input event into the masked field.
    const typed = await on(
      hosts.B,
      async (_o, link) => {
        let input = null;
        for (let i = 0; i < 100 && input === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          input = document.querySelector(".openlfcp-pane input.openlfcp-pane-join-input");
        }
        if (input === null) return false;
        input.focus();
        input.value = link;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input.type;
      },
      ctx.link,
    );
    expect(typed).toBe("password");
    await snap("06-join-field", ["B"]);
    await on(hosts.B, () => [...document.querySelectorAll(".openlfcp-pane form button")].find((x) => x.textContent === "Join")?.click());
    await hosts.B.waitUntil(async () => (await primary(hosts.B))?.label === "Insert into a note…" && (await paneText(hosts.B)).includes("Not inserted yet"), {
      timeout: 90_000,
      timeoutMsg: "B's pane: joined, not inserted yet",
    });
    await snap("07-join-ready-to-insert", ["B"]);
    await openNote(hosts.B, B_FILE, B_TEXT, 3);
    await clickPrimary(hosts.B);
    const modalText = await hosts.B.waitUntil(
      () => on(hosts.B, () => [...document.querySelectorAll(".modal-container .modal")].find((m) => [...m.querySelectorAll("button")].some((b) => b.textContent === "Insert"))?.textContent ?? false),
      { timeout: 30_000, timeoutMsg: "the insert preview" },
    );
    evidence("SHOWCASE insert preview", { text: modalText.slice(0, 500) });
    await snap("08-insert-preview", ["B"]);
    expect(await clickIn(hosts.B, modalText.slice(0, 30), "Insert")).toBe(true);
    await hosts.B.waitUntil(async () => (await noteOf(hosts.B, B_FILE)).includes("<!-- /lfcp-section: "), { timeout: 30_000, timeoutMsg: "the section inserted in B's note" });
    await converged("after the insert");
    await caretOn(hosts.B, B_FILE, "- [ ] Book the venue", 6);
    await snap("09-inserted", ["B"]);
  });

  it("10-11 A's edit reaches B; B's edit reaches A (a frame of each window, the same moment)", async () => {
    await openNote(hosts.A, A_FILE, A_TEXT, 6);
    await on(
      hosts.A,
      ({ app }, file) => {
        const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const e = leaf.view.editor;
        const lines = e.getValue().split("\n");
        const at = lines.findLastIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l));
        e.replaceRange("\n- [ ] Bring the speakers 📅 2026-11-06", { line: at, ch: lines[at].length });
        e.setCursor({ line: at + 1, ch: 0 });
      },
      A_FILE,
    );
    await hosts.B.waitUntil(async () => (await noteOf(hosts.B, B_FILE)).includes("Bring the speakers"), { timeout: 60_000, timeoutMsg: "A's new Task in B's note" });
    await converged("A's edit");
    await snap("10-sync-a-to-b", ["A", "B"]);
    await on(
      hosts.B,
      ({ app }, file) => {
        const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const e = leaf.view.editor;
        const line = e.getValue().split("\n").findIndex((l) => l.includes("] Order name badges"));
        e.replaceRange("x", { line, ch: 3 }, { line, ch: 4 });
        e.setCursor({ line, ch: 0 });
      },
      B_FILE,
    );
    await hosts.A.waitUntil(async () => /\[x\] Order name badges/.test(await noteOf(hosts.A, A_FILE)), { timeout: 60_000, timeoutMsg: "B's ticked Task in A's note" });
    await converged("B's edit");
    await snap("11-sync-b-to-a", ["A", "B"]);
  });

  it("12-14 A: a damaged boundary is a problem row in the pane; Repair shared sections… fixes it", async () => {
    await caretOn(hosts.A, A_FILE, "- [ ] Book the venue", 6);
    await editNote(hosts.A, A_FILE, (md) =>
      md
        .split("\n")
        .filter((l) => !l.startsWith("<!-- /lfcp-section: "))
        .join("\n")
        .replace("Book the venue", "Book the venue (confirm capacity)"),
    );
    const rows = () =>
      on(hosts.A, () =>
        [...document.querySelectorAll(".openlfcp-pane li.openlfcp-pane-problem")].map((li) => ({
          id: li.dataset.problem,
          text: li.querySelector(".openlfcp-pane-problem-text")?.textContent ?? "",
          button: li.querySelector("button")?.textContent ?? null,
        })),
      );
    const row = await hosts.A.waitUntil(async () => (await rows()).find((r) => /start marker and no end/.test(r.text)) ?? false, {
      timeout: 30_000,
      timeoutMsg: "the damaged boundary listed in the pane",
    });
    evidence("SHOWCASE problem row", row);
    await snap("12-problem-hub");
    expect(
      await on(hosts.A, (_o, id) => {
        const b = [...document.querySelectorAll(".openlfcp-pane button[data-problem]")].find((x) => x.dataset.problem === id);
        b?.click();
        return b !== undefined;
      }, row.id),
    ).toBe(true);
    const repair = await hosts.A.waitUntil(
      () =>
        on(hosts.A, () => {
          const m = document.querySelector(".openlfcp-repair");
          return m === null ? false : [...m.querySelectorAll(".openlfcp-repair-choice")].map((c) => c.textContent.trim());
        }),
      { timeout: 10_000, timeoutMsg: "the repair opened from the pane" },
    );
    await snap("13-problem-repair");
    const md = await noteOf(hosts.A, A_FILE);
    const later = md.split("\n").indexOf("## Private notes");
    const pick = repair.filter((c) => Number(/^After line (\d+):/.exec(c)?.[1] ?? 0) < later + 1).at(-1);
    expect(pick).toBeDefined();
    await on(
      hosts.A,
      (_o, pick) => {
        const m = document.querySelector(".openlfcp-repair");
        [...m.querySelectorAll(".openlfcp-repair-choice")].find((c) => c.textContent.trim() === pick).querySelector("input").click();
        [...m.querySelectorAll("button")].find((x) => x.textContent === "Apply").click();
      },
      pick,
    );
    await hosts.A.waitUntil(async () => !(await rows()).some((r) => r.id === row.id), { timeout: 20_000, timeoutMsg: "the row gone after the repair" });
    await hosts.A.waitUntil(async () => (await badgeOf(hosts.A, A_FILE)) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current after the repair" });
    await hosts.B.waitUntil(async () => (await noteOf(hosts.B, B_FILE)).includes("confirm capacity"), { timeout: 60_000, timeoutMsg: "the held edit in B's note" });
    await closeModals(hosts.A);
    await caretOn(hosts.A, A_FILE, "- [ ] Book the venue", 6);
    await hosts.A.pause(1000);
    await snap("14-problem-resolved");
  });

  it("15-16 A: the section card (status, access); the pane's copy and detach actions", async () => {
    await caretOn(hosts.A, A_FILE, "- [ ] Pack the projector", 6);
    await hosts.A.waitUntil(async () => (await paneText(hosts.A)).includes("Synced"), { timeout: 60_000, timeoutMsg: "the pane's card, synced" });
    // The card: the pane's own action when it has one, else the badge in the note.
    const opened = await on(hosts.A, () => {
      const b = document.querySelector('.openlfcp-pane button[data-action="open-details"]');
      if (b !== null) {
        b.click();
        return "pane";
      }
      const badge = document.querySelector(".openlfcp-status");
      badge?.click();
      return badge !== null ? "badge" : "none";
    });
    evidence("SHOWCASE card opened by", { opened });
    expect(opened).not.toBe("none");
    await modalWith(hosts.A, "Shared section");
    await hosts.A.pause(800);
    await snap("15-section-card");
    await closeModals(hosts.A);
    // The destructive actions are in the pane's "More actions" menu: opened, as a user does.
    await on(hosts.A, () => {
      window.__lfcpNativeMenus ??= { value: window.app.vault.getConfig("nativeMenus") };
      window.app.vault.setConfig("nativeMenus", false);
      document.querySelector('.openlfcp-pane button[data-pane-key="menu"]')?.click();
    });
    await hosts.A.pause(500);
    await snap("16-pane-copy-detach");
  });
});
