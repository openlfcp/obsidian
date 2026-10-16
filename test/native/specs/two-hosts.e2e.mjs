// LFCP-03-025 (U03-29, U03-01, U03-08, U03-16, U03-17): the core flow on
// two real Obsidian apps. A is the harness's own Obsidian (wdio.conf.mjs);
// B is a second Obsidian of the same version, started here with
// wdio-obsidian-service's standalone session: its own process, its own
// configuration directory (so its own install database and identity) and its
// own copy of the test vault. Both run the built plugin against the
// reference server at LFCP_SERVER_BIN; no headless peer takes part.
//
// Twice, with Obsidian Tasks 8.4.0 disabled on both and then enabled on
// both, each time with a section of its own:
// 1. A shares a section from the pane (ribbon, no palette) and invites with
//    an explicit role; the link goes from A's invitation dialog to B as a
//    user would carry it (the test reads it from the dialog; both apps share
//    one system clipboard, so the clipboard is not the channel).
// 2. B opens the pane from the ribbon, joins with the link and inserts the
//    section into its own note from the pane.
// 3. Edits with real keys on each side reach the other; a Task is checked
//    off (Obsidian's own command with Tasks off, Tasks' toggle with it on).
// 4. A problem: B goes offline (its renderer's WebSocket), both change the
//    same Task (a title on both; with Tasks on, A deletes the Task B
//    changes); B comes back; the conflict is resolved in the UI of one host
//    (A's "Review conflicts…", then B's) and both end CURRENT and equal.
// 5. B's Obsidian restarts (a new process on the same configuration
//    directory) while A edits; after the restart B shows A's edit and B's
//    own edit reaches A.
// 6. A removes B's access in the section card. B's own UI says so (badge,
//    card), B's next edit stays in B's note, held, and never reaches A.
// Screenshots of both windows at each step go to $LFCP_SCREENSHOT_DIR/two-hosts.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startWdioSession } from "wdio-obsidian-service";
import { restartableServer } from "../peer.bundle.mjs";
import { cacheDir } from "../wdio.conf.mjs";
import { evidence, markerProblems, sectionOf, titles } from "./support/section-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const OUT = path.join(process.env.LFCP_SCREENSHOT_DIR ?? path.join(os.tmpdir(), "lfcp-native-screenshots"), "two-hosts");
const TASKS = "obsidian-tasks-plugin";
const TOOLTIP = "Open Shared Tasks pane";
const D = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` in host `h`'s Obsidian (as executeObsidian does). */
const on = (h, fn, ...args) => h.executeObsidian(fn, ...args);

const hosts = { A: null, B: null };
let server;
let version;

/** The window of `h` in front, as far as the platform lets a script do it; whether its document has focus. */
const front = (h) =>
  h.execute(() => {
    try {
      window.require?.("electron")?.remote?.getCurrentWindow()?.focus();
    } catch {}
    window.focus();
    return document.hasFocus();
  });

const shot = async (name) => {
  for (const [n, h] of Object.entries(hosts)) {
    if (h === null) continue;
    await h.saveScreenshot(path.join(OUT, `${version}-${name}-${n}.png`)).catch((e) => evidence("screenshot failed", { name, host: n, error: String(e) }));
  }
};

/** What says that `h` is its own Obsidian: version, process, vault, identity. */
const factsOf = async (h) => {
  const f = await on(h, ({ app, obsidian }) => ({
    obsidian: obsidian.apiVersion,
    userAgent: navigator.userAgent.match(/obsidian\/[\d.]+/i)?.[0] ?? null,
    electron: process.versions.electron,
    platform: process.platform,
    pid: process.pid,
    vault: app.vault.getName(),
    base: app.vault.adapter.basePath ?? null,
    principal: Buffer.from(app.plugins.plugins["shared-tasks"]?.runtime?.status?.principalId ?? []).toString("hex"),
    plugin: app.plugins.manifests["shared-tasks"]?.version ?? null,
    tasks: app.plugins.manifests["obsidian-tasks-plugin"]?.version ?? null,
  }));
  return { ...f, base: f.base === null ? null : createHash("sha256").update(f.base).digest("hex").slice(0, 12) };
};

/** A switch for `h`'s network in its renderer (its runtime takes window.WebSocket at each connection). */
const installNet = (h) =>
  on(h, () => {
    if (window.__lfcpNet !== undefined) return;
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
    window.__lfcpNet = {
      off() {
        offline = true;
        for (const s of open) s.close();
      },
      on() {
        offline = false;
      },
    };
  });
const net = (h, up) => on(h, (_o, up) => (up ? window.__lfcpNet.on() : window.__lfcpNet.off()), up);

/** The plugin restarted at the server, sections on; Tasks enabled or disabled; the runtime ready. */
const prepare = (h, url, tasks) =>
  on(
    h,
    async ({ app }, url, tasks) => {
      if (tasks) await app.plugins.enablePlugin("obsidian-tasks-plugin");
      else await app.plugins.disablePlugin("obsidian-tasks-plugin");
      if (!app.plugins.enabledPlugins.has("shared-tasks")) await app.plugins.enablePlugin("shared-tasks");
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = url;
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 200 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      return {
        runtime: q.runtime?.status.kind ?? null,
        tasksEnabled: app.plugins.enabledPlugins.has("obsidian-tasks-plugin"),
        tasksLoaded: app.plugins.plugins["obsidian-tasks-plugin"] !== undefined,
      };
    },
    url,
    tasks,
  );

/** Creates `file` (if new) and opens it in a tab of its own in Live Preview, the caret on `line`. */
const openNote = (h, file, text, line) =>
  on(
    h,
    async ({ app, obsidian }, file, text, line) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      let leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      if (leaf === undefined) {
        leaf = app.workspace.getLeaf("tab");
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      }
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = leaf.view;
      for (let i = 0; i < 60 && !(view instanceof obsidian.MarkdownView && view.editor.getValue() !== ""); i++) await new Promise((r) => setTimeout(r, 50));
      // A line number, or the title of a Task: the caret on that Task's line.
      const at =
        typeof line === "number"
          ? line
          : view.editor
              .getValue()
              .split("\n")
              .findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${line}`));
      view.editor.setCursor({ line: Math.max(0, at), ch: 0 });
    },
    file,
    text,
    line,
  );

/** The text of `file` as `h`'s editor shows it (the file when no view shows it). */
const noteOf = (h, file) =>
  on(
    h,
    async ({ app }, file) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      return leaf !== undefined ? leaf.view.editor.getValue() : await app.vault.adapter.read(file);
    },
    file,
  );
/** The badge of `file`'s view in `h`. */
const badgeOf = (h, file) =>
  on(
    h,
    ({ app }, file) =>
      app.workspace
        .getLeavesOfType("markdown")
        .find((l) => l.view.file?.path === file)
        ?.view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
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
/** The pane, from the ribbon when it is not open. */
const openPane = async (h) => {
  const clicked = await on(
    h,
    (_o, label) => {
      if (document.querySelector(".openlfcp-pane") !== null) return "open";
      const icon = document.querySelector(`.side-dock-ribbon-action[aria-label="${label}"]`);
      icon?.click();
      return icon !== null ? "ribbon" : "no ribbon icon";
    },
    TOOLTIP,
  );
  expect(clicked).not.toBe("no ribbon icon");
  await h.waitUntil(() => on(h, () => document.querySelector(".openlfcp-pane") !== null), { timeout: 10_000, timeoutMsg: "the pane" });
  return clicked;
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
/** Closes the open modals with their own close button (Escape when that fails). */
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

/** `h`'s outbound queue for the section `hex`. */
const outbound = (h, hex) =>
  on(
    h,
    async ({ app }, hex) => {
      const p = app.plugins.plugins["shared-tasks"];
      return (await p.runtime.storage.outbound.list(Uint8Array.from(hex.match(/../g).map((x) => Number.parseInt(x, 16))))).length;
    },
    hex,
  );

/**
 * The caret at the end of the Task titled `title` in `file` (`h`'s editor
 * focused, its window in front), then real keys.
 */
async function typeAt(h, file, title, keys) {
  const at = await on(
    h,
    async ({ app }, file, title) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const e = leaf.view.editor;
      for (let i = 0; i < 40 && !e.hasFocus(); i++) {
        e.focus();
        await new Promise((r) => setTimeout(r, 50));
      }
      const line = e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${title}`));
      e.setCursor({ line, ch: e.getLine(line).length });
      return { line, focused: e.hasFocus() };
    },
    file,
    title,
  );
  const focused = await front(h);
  await h.pause(200);
  await h.keys(keys);
  await h.pause(400);
  return { ...at, windowFocus: focused };
}

/** Runs an editor command of `h` with the caret on the Task titled `title`; the line after it. */
const commandOnTask = (h, file, title, command) =>
  on(
    h,
    async ({ app }, file, title, command) => {
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const e = leaf.view.editor;
      e.focus();
      const line = e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${title}`));
      e.setCursor({ line, ch: 6 });
      const ran = app.commands.executeCommandById(command);
      await new Promise((r) => setTimeout(r, 500));
      return { ran, line: e.getLine(line) };
    },
    file,
    title,
    command,
  );

/**
 * Waits until both notes show the same Tasks (`want`, when given: each
 * title starts with its entry) and both badges are CURRENT; the markers of
 * both notes sound. Returns what it saw last.
 */
async function bothCurrent(label, ctx, want) {
  let last = {};
  const ok = await browser
    .waitUntil(
      async () => {
        const [a, b] = [await noteOf(hosts.A, ctx.aFile), await noteOf(hosts.B, ctx.bFile)];
        last = {
          titlesA: titles(sectionOf(a)),
          titlesB: titles(sectionOf(b)),
          badgeA: await badgeOf(hosts.A, ctx.aFile),
          badgeB: await badgeOf(hosts.B, ctx.bFile),
          problemsA: markerProblems(a).problems,
          problemsB: markerProblems(b).problems,
        };
        const same = JSON.stringify(last.titlesA) === JSON.stringify(last.titlesB);
        const wanted = want === undefined || (last.titlesA.length === want.length && want.every((w, i) => last.titlesA[i].startsWith(w)));
        return same && wanted && last.badgeA === "CURRENT" && last.badgeB === "CURRENT";
      },
      { timeout: 90_000, interval: 500 },
    )
    .catch(() => false);
  evidence(label, { mode: ctx.mode, converged: ok, ...last });
  expect(last.problemsA).toEqual([]);
  expect(last.problemsB).toEqual([]);
  expect(ok).toBe(true);
  return last;
}

/** `h`'s "Review conflicts…" on the active note's card: the item whose question has `question`, the choice starting with `label`. */
const choose = async (h, question, label) => {
  const result = await on(
    h,
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
      if (review === null) return { missing: "no Review conflicts…", card: [...document.querySelectorAll(".modal")].map((m) => m.textContent).join(" | ").slice(0, 600) };
      review.click();
      const item = await find(() => [...document.querySelectorAll(".openlfcp-recovery-item")].find((x) => x.textContent.includes(question)));
      if (item === null) return { missing: "no item", items: [...document.querySelectorAll(".openlfcp-recovery-item")].map((x) => x.textContent.slice(0, 200)) };
      const choice = [...item.querySelectorAll(".openlfcp-recovery-choice")].find((l) => l.textContent.trim().startsWith(label));
      if (choice === undefined) return { missing: "no choice", choices: [...item.querySelectorAll(".openlfcp-recovery-choice")].map((l) => l.textContent.trim()) };
      choice.querySelector("input").click();
      item.querySelector("button").click();
      const done = await find(() => document.querySelector(".openlfcp-recovery")?.textContent.includes("Nothing needs a choice now") ?? false);
      return { question: item.textContent.slice(0, 200), choice: choice.textContent.trim(), done: done === true };
    },
    question,
    label,
  );
  await closeModals(h);
  return result;
};

/** The card of the active note in `h`, its text. */
const cardText = async (h) => {
  const text = await on(h, async ({ app }) => {
    app.commands.executeCommandById("shared-tasks:open-section-details");
    let modal;
    for (let i = 0; i < 200 && !(modal?.textContent ?? "").includes("Shared section"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      modal = document.querySelector(".modal-container .modal");
    }
    return modal?.textContent ?? null;
  });
  return text;
};

for (const tasks of [false, true]) {
  const mode = tasks ? "tasks-on" : "tasks-off";
  const title = tasks ? "Core with Tasks" : "Core without Tasks";
  const ctx = { mode, aFile: `${title}.md`, bFile: `B ${title}.md`, R: null, link: null, broken: false };
  const TEXT = [`## ${title}`, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n");

  describe(`LFCP-03-025: two real Obsidian, ${mode}`, function () {
    this.timeout(300_000);

    before(async function () {
      this.timeout(600_000);
      mkdirSync(OUT, { recursive: true });
      hosts.A = browser;
      if (hosts.B === null) {
        const caps = browser.requestedCapabilities;
        // The app's own version (browserVersion becomes Chrome's once the session runs).
        const o = caps["wdio:obsidianOptions"] ?? {};
        version = o.appVersion ?? process.env.NATIVE_OBSIDIAN;
        evidence("TWO-HOSTS A options", { appVersion: o.appVersion ?? null, installerVersion: o.installerVersion ?? null });
        hosts.B = await startWdioSession({
          cacheDir,
          logLevel: "warn",
          capabilities: {
            browserName: "obsidian",
            browserVersion: version,
            "wdio:obsidianOptions": {
              installerVersion: o.installerVersion ?? version,
              plugins: [root, { id: TASKS, version: "8.4.0", enabled: false }],
              vault: path.join(here, "../vaults/basic"),
            },
          },
        });
      }
      if (server === undefined) server = await restartableServer();
      for (const h of [hosts.A, hosts.B]) await installNet(h);
      const prepared = { A: await prepare(hosts.A, server.url, tasks), B: await prepare(hosts.B, server.url, tasks) };
      const facts = { A: await factsOf(hosts.A), B: await factsOf(hosts.B) };
      evidence("TWO-HOSTS hosts", { mode, version, runner: process.platform, prepared, facts });
      // Two apps: two processes, two vault copies, two identities, one version.
      expect(facts.A.pid).not.toBe(facts.B.pid);
      expect(facts.A.base).not.toBe(facts.B.base);
      expect(facts.A.principal).not.toBe(facts.B.principal);
      expect(facts.A.principal).not.toBe("");
      expect(facts.A.obsidian).toBe(facts.B.obsidian);
      expect(prepared.A.runtime).toBe("ready");
      expect(prepared.B.runtime).toBe("ready");
      expect(prepared.A.tasksLoaded).toBe(tasks);
      expect(prepared.B.tasksLoaded).toBe(tasks);
    });

    afterEach(function () {
      if (this.currentTest?.state === "failed") ctx.broken = true;
    });
    beforeEach(function () {
      // A step after a failed one would only fail for its predecessor.
      if (ctx.broken) throw new Error("an earlier step of this flow failed");
    });

    after(async function () {
      this.timeout(120_000);
      for (const h of [hosts.A, hosts.B]) {
        if (h === null) continue;
        await net(h, true).catch(() => undefined);
        await closeModals(h).catch(() => undefined);
      }
      if (tasks) {
        await hosts.B?.deleteSession().catch((e) => evidence("TWO-HOSTS B close", { error: String(e) }));
        hosts.B = null;
        if (server !== undefined) await prepare(hosts.A, server.url, false).catch(() => undefined);
        await server?.stop();
        server = undefined;
      }
    });

    it("A shares from the pane and invites with an explicit role", async () => {
      await openNote(hosts.A, ctx.aFile, TEXT, 0);
      const pane = await openPane(hosts.A);
      await openNote(hosts.A, ctx.aFile, TEXT, 0);
      await hosts.A.waitUntil(async () => (await primary(hosts.A))?.label === "Share section…", { timeout: 30_000, timeoutMsg: "Share section… in A's pane" });
      const preview = await paneText(hosts.A);
      await clickPrimary(hosts.A);
      const dialog = await modalWith(hosts.A, `Share section "${title}"`);
      expect(await clickIn(hosts.A, `Share section "${title}"`, "Share")).toBe(true);
      ctx.R = await resourceOf(hosts.A, ctx.aFile, title);
      await hosts.A.waitUntil(
        async () => (await primary(hosts.A))?.label === "Invite collaborator…" && (await paneText(hosts.A)).includes("ready to invite"),
        { timeout: 90_000, timeoutMsg: "A's pane ready to invite" },
      );
      await clickPrimary(hosts.A);
      const roles = await hosts.A.waitUntil(
        () =>
          on(hosts.A, () => {
            const items = [...document.querySelectorAll(".prompt .suggestion-item")].map((x) => x.textContent);
            return items.length > 0 ? items : false;
          }),
        { timeout: 20_000, timeoutMsg: "the role choice" },
      );
      await on(hosts.A, () => [...document.querySelectorAll(".prompt .suggestion-item")].find((x) => x.textContent.startsWith("Read + write"))?.click());
      const invitation = await modalWith(hosts.A, "Invitation (");
      expect(invitation).not.toContain("lfcp://join/");
      ctx.link = await on(hosts.A, () => {
        const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes("Invitation ("));
        [...m.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
        const value = m.querySelector("input").value;
        [...m.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
        return value;
      });
      evidence("TWO-HOSTS share+invite", {
        mode,
        pane,
        preview: preview.slice(0, 300),
        dialog: dialog.slice(0, 200),
        roles,
        linkShape: ctx.link.startsWith("lfcp://join/"),
        paneAfter: (await paneText(hosts.A)).slice(0, 300),
      });
      expect(roles.length).toBe(2);
      expect(ctx.link.startsWith("lfcp://join/")).toBe(true);
      await shot(`${mode}-1-shared`);
    });

    it("B joins from its pane with the link and inserts the section into its own note", async () => {
      await openNote(hosts.B, ctx.bFile, ["# B", "", "My own text.", ""].join("\n"), 2);
      await openPane(hosts.B);
      await openNote(hosts.B, ctx.bFile, ["# B", "", "My own text.", ""].join("\n"), 2);
      // The join button as B's pane draws it, then the click; when no field opens, what the pane shows, and again.
      const attempts = [];
      for (let i = 0; i < 3; i++) {
        const before = await on(hosts.B, () => {
          const b = [...document.querySelectorAll(".openlfcp-pane button")].find((x) => x.textContent === "Join with a link…");
          const id = b?.getAttribute("aria-describedby");
          return {
            drawn: b !== undefined,
            disabled: b?.getAttribute("aria-disabled") === "true",
            reason: id ? (document.getElementById(id)?.textContent ?? null) : null,
            panes: document.querySelectorAll(".openlfcp-pane").length,
          };
        });
        const clicked = await clickPane(hosts.B, "Join with a link…");
        const opened = await hosts.B
          .waitUntil(() => on(hosts.B, () => document.querySelector(".openlfcp-pane input.openlfcp-pane-join-input") !== null), { timeout: 5_000, interval: 100 })
          .catch(() => false);
        attempts.push({ before, clicked, opened, pane: opened ? null : (await paneText(hosts.B)).slice(0, 400) });
        if (opened) break;
      }
      evidence("TWO-HOSTS join button", { mode, attempts });
      // A first click that opens nothing is a finding (in the evidence); the flow goes on when a later one opens it.
      expect(attempts.some((a) => a.opened)).toBe(true);
      const field = await on(
        hosts.B,
        async (_o, link) => {
          let input = null;
          for (let i = 0; i < 100 && input === null; i++) {
            await new Promise((r) => setTimeout(r, 50));
            input = document.querySelector(".openlfcp-pane input.openlfcp-pane-join-input");
          }
          if (input === null) return { field: false };
          const type = input.type;
          input.focus();
          input.value = link;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          [...document.querySelectorAll(".openlfcp-pane form button")].find((x) => x.textContent === "Join").click();
          return { field: true, type, typeAfter: input.type, cleared: input.value === "", connected: input.isConnected };
        },
        ctx.link,
      );
      evidence("TWO-HOSTS join field", { mode, field });
      expect(field.field).toBe(true);
      expect(field.type).toBe("password");
      const steps = [];
      await hosts.B.waitUntil(
        async () => {
          const step = await on(hosts.B, () => document.querySelector(".openlfcp-pane .openlfcp-pane-step.is-current")?.textContent ?? null);
          if (step !== null && steps.at(-1) !== step) steps.push(step);
          return (await primary(hosts.B))?.label === "Insert into a note…" && (await paneText(hosts.B)).includes("Not inserted yet");
        },
        { timeout: 90_000, interval: 100, timeoutMsg: "B joined, not inserted yet" },
      );
      const joined = await paneText(hosts.B);
      expect(joined).toContain("Access: read and write.");
      expect(joined).toContain(title);
      expect(joined).not.toContain(ctx.link.slice(ctx.link.indexOf("#secret=") + 8));
      await clickPrimary(hosts.B);
      const asked = await on(hosts.B, async () => {
        let ins;
        for (let i = 0; i < 200 && ins === undefined; i++) {
          await new Promise((r) => setTimeout(r, 50));
          ins = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
        }
        const asked = document.querySelector(".prompt .suggestion-item") !== null;
        ins.click();
        return asked;
      });
      expect(asked).toBe(false);
      await hosts.B.waitUntil(async () => (await noteOf(hosts.B, ctx.bFile)).includes("<!-- /lfcp-section: "), { timeout: 30_000, timeoutMsg: "inserted at B" });
      evidence("TWO-HOSTS join+insert", { mode, field, steps, joined: joined.slice(0, 500) });
      const s = await bothCurrent("TWO-HOSTS joined", ctx, ["Alpha", "Beta", "Gamma"]);
      expect((await noteOf(hosts.B, ctx.bFile)).includes("My own text.")).toBe(true);
      expect(s.titlesB).toEqual(["Alpha", "Beta", "Gamma"]);
      await shot(`${mode}-2-joined`);
    });

    it("real keys on each side reach the other; a Task checked off reaches the other", async () => {
      const typedA = await typeAt(hosts.A, ctx.aFile, "Gamma", ["Enter", ..."Delta from A"]);
      await bothCurrent("TWO-HOSTS A typed", ctx, ["Alpha", "Beta", "Gamma", "Delta from A"]);
      const typedB = await typeAt(hosts.B, ctx.bFile, "Alpha", " edited in B");
      await bothCurrent("TWO-HOSTS B typed", ctx, ["Alpha edited in B", "Beta", "Gamma", "Delta from A"]);
      // Checked off: Tasks' own toggle with Tasks on (it adds its done date), Obsidian's command without.
      const toggled = await commandOnTask(hosts.A, ctx.aFile, "Alpha", tasks ? "obsidian-tasks-plugin:toggle-done" : "editor:toggle-checklist-status");
      const seen = await browser
        .waitUntil(async () => (await noteOf(hosts.B, ctx.bFile)).split("\n").find((l) => l.includes("] Alpha edited in B"))?.includes("[x]") ?? false, { timeout: 60_000 })
        .catch(() => false);
      const after = await bothCurrent("TWO-HOSTS checked off", ctx);
      evidence("TWO-HOSTS edits", { mode, typedA, typedB, toggled, seenAtB: seen, lineB: (await noteOf(hosts.B, ctx.bFile)).split("\n").find((l) => l.includes("Alpha edited in B")) });
      expect(toggled.ran).not.toBe(false);
      expect(toggled.line).toContain("[x]");
      if (tasks) expect(toggled.line).toMatch(/✅ \d{4}-\d{2}-\d{2}/);
      expect(seen).toBe(true);
      expect(after.titlesA[0]).toMatch(/^Alpha edited in B/);
      await shot(`${mode}-3-edited`);
    });

    it("a conflict while B is offline is shown and resolved in a host's own UI; both end current", async () => {
      await net(hosts.B, false);
      const offline = await browser.waitUntil(async () => (await badgeOf(hosts.B, ctx.bFile)) === "OFFLINE", { timeout: 60_000 }).catch(() => false);
      const typedB = await typeAt(hosts.B, ctx.bFile, "Beta", tasks ? " changed by B" : " by B");
      await browser.waitUntil(async () => (await outbound(hosts.B, ctx.R)) > 0, { timeout: 30_000, timeoutMsg: "B's change queued" });
      let changedA;
      if (tasks) {
        // A deletes Beta with its ref line (from the end of Alpha's ref line to the end of Beta's).
        changedA = await on(
          hosts.A,
          async ({ app }, file) => {
            const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
            app.workspace.setActiveLeaf(leaf, { focus: true });
            const e = leaf.view.editor;
            e.focus();
            const at = e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] Beta/.test(l));
            e.setSelection({ line: at - 1, ch: e.getLine(at - 1).length }, { line: at + 1, ch: e.getLine(at + 1).length });
            return { at };
          },
          ctx.aFile,
        );
        await front(hosts.A);
        await hosts.A.keys(["Backspace"]);
        await hosts.A.pause(400);
      } else changedA = await typeAt(hosts.A, ctx.aFile, "Beta", " by A");
      await browser.waitUntil(async () => (await outbound(hosts.A, ctx.R)) === 0, { timeout: 30_000, timeoutMsg: "A's change accepted" });
      await net(hosts.B, true);
      const attention = await browser
        .waitUntil(
          async () => {
            const a = await badgeOf(hosts.A, ctx.aFile);
            const b = await badgeOf(hosts.B, ctx.bFile);
            return a === "ATTENTION" || b === "ATTENTION" ? { a, b } : false;
          },
          { timeout: 60_000 },
        )
        .catch(() => null);
      await browser.pause(2000);
      const badges = { a: await badgeOf(hosts.A, ctx.aFile), b: await badgeOf(hosts.B, ctx.bFile) };
      await shot(`${mode}-4-conflict`);
      // Without Tasks A (the owner) resolves the title in its UI, keeping B's; with Tasks B restores the Task in its UI.
      const resolver = tasks ? hosts.B : hosts.A;
      const chosen = tasks ? await choose(resolver, "deleted", "Restore it") : await choose(resolver, "the title of", "Beta by B");
      evidence("TWO-HOSTS conflict", { mode, offline, typedB, changedA, attention, badges, chosen });
      expect(offline).toBe(true);
      expect(attention).not.toBe(null);
      expect(chosen.done).toBe(true);
      const out = await bothCurrent("TWO-HOSTS resolved", ctx, tasks ? ["Alpha", "Beta changed by B", "Gamma", "Delta from A"] : ["Alpha", "Beta by B", "Gamma", "Delta from A"]);
      expect(out.badgeA).toBe("CURRENT");
      await shot(`${mode}-5-resolved`);
    });

    it("B's Obsidian restarts while A edits; then each side's edit reaches the other", async function () {
      this.timeout(600_000);
      const before = await factsOf(hosts.B);
      const restart = hosts.B.reloadObsidian({ plugins: tasks ? ["shared-tasks", TASKS] : ["shared-tasks"] });
      const typedA = await typeAt(hosts.A, ctx.aFile, "Gamma", " while B restarts");
      await restart;
      const ready = await on(hosts.B, async ({ app }) => {
        if (!app.plugins.enabledPlugins.has("shared-tasks")) await app.plugins.enablePlugin("shared-tasks");
        const p = app.plugins.plugins["shared-tasks"];
        for (let i = 0; i < 300 && p?.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
        return { runtime: p?.runtime?.status?.kind ?? null, server: p?.settings?.defaultServer ?? null };
      });
      await installNet(hosts.B);
      const afterFacts = await factsOf(hosts.B);
      await openNote(hosts.B, ctx.bFile, "", 0);
      await bothCurrent("TWO-HOSTS after restart", ctx);
      const seen = (await noteOf(hosts.B, ctx.bFile)).includes("Gamma while B restarts");
      const typedB = await typeAt(hosts.B, ctx.bFile, "Delta from A", " and B after restart");
      const out = await bothCurrent("TWO-HOSTS B typed after restart", ctx);
      evidence("TWO-HOSTS restart", { mode, typedA, ready, pidBefore: before.pid, pidAfter: afterFacts.pid, sameIdentity: before.principal === afterFacts.principal, seen, typedB, titles: out.titlesA });
      expect(ready.runtime).toBe("ready");
      expect(ready.server).toBe(server.url);
      expect(afterFacts.principal).toBe(before.principal);
      expect(seen).toBe(true);
      expect(out.titlesA.some((t) => t.startsWith("Delta from A and B after restart"))).toBe(true);
      await shot(`${mode}-6-restarted`);
    });

    it("A removes B's access; B's own UI says so; B's next edit stays in B's note and never reaches A", async () => {
      await openNote(hosts.A, ctx.aFile, "", "Beta");
      const removing = await on(hosts.A, async ({ app }) => {
        app.commands.executeCommandById("shared-tasks:open-section-details");
        let row;
        for (let i = 0; i < 200 && row === undefined; i++) {
          await new Promise((r) => setTimeout(r, 50));
          row = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access…");
        }
        if (row === undefined) return { error: [...document.querySelectorAll(".modal")].map((m) => m.textContent).join(" | ").slice(0, 600) };
        row.click();
        let confirm;
        for (let i = 0; i < 100 && confirm === undefined; i++) {
          await new Promise((r) => setTimeout(r, 50));
          confirm = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access");
        }
        confirm.click();
        await new Promise((r) => setTimeout(r, 1500));
        return { notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent) };
      });
      await closeModals(hosts.A);
      expect(removing.error).toBeUndefined();
      // B learns it at its next contact with the server: its own edit.
      const typedB = await typeAt(hosts.B, ctx.bFile, "Gamma", " after removal");
      // The badges B goes through until it settles on one that is neither current nor sending.
      const seenB = [];
      const held = await browser
        .waitUntil(
          async () => {
            const now = await badgeOf(hosts.B, ctx.bFile);
            if (seenB.at(-1) !== now) seenB.push(now);
            return now !== "CURRENT" && now !== "SENDING" && now !== null ? now : false;
          },
          { timeout: 90_000, interval: 250 },
        )
        .catch(() => null);
      await browser.pause(3000);
      const notices = await on(hosts.B, () => [...document.querySelectorAll(".notice")].map((n) => n.textContent));
      await openNote(hosts.B, ctx.bFile, "", "Beta");
      const card = await cardText(hosts.B);
      await shot(`${mode}-7-removed`);
      await closeModals(hosts.B);
      const pane = await paneText(hosts.B);
      const a = await noteOf(hosts.A, ctx.aFile);
      const b = await noteOf(hosts.B, ctx.bFile);
      evidence("TWO-HOSTS removed", {
        mode,
        removing,
        typedB,
        badgeB: held,
        seenB,
        notices,
        badgeA: await badgeOf(hosts.A, ctx.aFile),
        card: card?.slice(0, 500) ?? null,
        pane: pane.slice(0, 500),
        titlesA: titles(sectionOf(a)),
        titlesB: titles(sectionOf(b)),
        problemsB: markerProblems(b).problems,
      });
      expect(held).not.toBe(null);
      expect(card ?? "").toMatch(/not sent|access|removed|refused/i);
      expect(titles(sectionOf(b)).some((t) => t.includes("after removal"))).toBe(true);
      expect(markerProblems(b).problems).toEqual([]);
      expect(a).not.toContain("after removal");
    });
  });
}
