// LFCP-03-025 (C4 of LFCP-03-023; U03-06, UX contract §13): the frozen UX
// states (test/fixtures/ux-0.3/states.json) drawn by the real plugin's pane
// in a real Obsidian, not the developer prototype. For each state the plugin
// is restarted (a fresh instance), the state's note is written to the vault
// and opened in a real Markdown view (Live Preview) with its cursor and
// selection, and the plugin's sections host is swapped for the state's
// (test/support/ux-fixture-host.ts, the same fake the recording-mock suite
// test/obsidian/pane-fixtures.test.ts uses; anything else the plugin asks of
// its host goes to the real one). Then the pane is opened as the plugin
// opens it and must show the fixture's primary call to action, its enabled
// and disabled actions with their reasons word for word, its claims and
// none of the forbidden ones; the share previews their counts and warnings.
// A screenshot of the pane per state goes to $LFCP_SCREENSHOT_DIR/fixture-states.
//
// Not drawn here: unknown-result-join. Its stage comes from the plugin's
// join flow, a private field the harness cannot set (the mock suite stubs
// JoinFlow.prototype); specs/pane-join drives the real join flow instead.
// It is reported as NOT_RUN in the evidence, not skipped.
import { mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { evidence, inA } from "./support/section-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(path.join(here, "../../fixtures/ux-0.3/states.json"), "utf8"));
const BUNDLE = readFileSync(path.join(here, "../fixture-host.bundle.js"), "utf8");
const OUT = path.join(process.env.LFCP_SCREENSHOT_DIR ?? path.join(os.tmpdir(), "lfcp-native-screenshots"), "fixture-states");
const PANE = "shared-tasks-pane";
const NATIVE_NOT_RUN = { "unknown-result-join": "the join flow's stage is a private field of the plugin; the mock suite stubs it" };
const time = /^at /;

/** The state drawn by the real pane: what the pane shows. */
const draw = (st) =>
  inA(
    async ({ app, obsidian }, bundle, st, pane) => {
      if (window.__lfcpFixtureHost === undefined) (0, eval)(bundle);
      const H = window.__lfcpFixtureHost;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      app.workspace.detachLeavesOfType(pane);
      // A fresh plugin: nothing left from the state before (D9's "just joined").
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const p = app.plugins.plugins["shared-tasks"];
      await p.whenRuntimeStarted();
      const n = H.noteSpec(st);
      for (const leaf of app.workspace.getLeavesOfType("markdown")) leaf.detach();
      if (n !== null) {
        const file = app.vault.getFileByPath(n.path);
        if (file === null) await app.vault.create(n.path, n.text);
        else await app.vault.modify(file, n.text);
        const leaf = app.workspace.getLeaf("tab");
        await leaf.openFile(app.vault.getFileByPath(n.path), {
          state: n.mode === "preview" ? { mode: "preview" } : { mode: "source", source: false },
        });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = leaf.view;
        for (let i = 0; i < 60 && !(view instanceof obsidian.MarkdownView && view.editor.getValue() === n.text); i++) await sleep(50);
        if (n.selection !== null) view.editor.setSelection(n.selection.from, n.selection.to);
        else view.editor.setCursor({ line: n.cursorLine, ch: 0 });
      }
      const real = p.sections;
      const fake = H.hostOf(st);
      p.sections = new Proxy(fake, {
        get: (t, k) => (k in t ? t[k] : typeof real?.[k] === "function" ? real[k].bind(real) : real?.[k]),
      });
      p.runtimeError = null;
      if (H.joinedFirst(st)) p.sectionJoined(H.fixtureResource());
      await p.openPane();
      let view;
      for (let i = 0; i < 100 && view === undefined; i++) {
        view = app.workspace.getLeavesOfType(pane)[0]?.view;
        if (view === undefined) await sleep(50);
      }
      view.render();
      await sleep(150);
      const el = view.contentEl;
      const reasonOf = (b) => {
        const id = b.getAttribute("aria-describedby");
        if (id !== null) return el.querySelector(`#${CSS.escape(id)}`)?.textContent ?? null;
        // A header icon: Obsidian's tooltip is its accessible name, "label — reason".
        const name = b.getAttribute("aria-label");
        const at = name?.indexOf(" — ") ?? -1;
        return name === null || at < 0 ? null : name.slice(at + 3);
      };
      const actions = [...el.querySelectorAll("button[data-action]")].map((b) => ({
        action: b.dataset.action,
        disabled: b.getAttribute("aria-disabled") === "true",
        reason: reasonOf(b),
      }));
      // The destructive actions are in Obsidian's menu (A8): opened as a user does and read; the
      // caller closes it with a real Escape.
      // (Obsidian on macOS shows menus natively unless told not to: nothing of them is in the page.)
      window.__lfcpNativeMenus ??= { value: app.vault.getConfig("nativeMenus") };
      app.vault.setConfig("nativeMenus", false);
      const menu = [];
      const more = el.querySelector('button[data-pane-key="menu"]');
      if (more !== null && more.getAttribute("aria-disabled") !== "true") {
        more.click();
        await sleep(150);
        for (const i of document.querySelectorAll(".menu .menu-item"))
          menu.push({ title: i.querySelector(".menu-item-title")?.textContent ?? "", disabled: i.classList.contains("is-disabled") });
      }
      const primary = el.querySelector(".openlfcp-pane-primary button");
      const texts = [...el.querySelectorAll("*")]
        .filter((e) => [...e.childNodes].some((x) => x.nodeType === 3))
        .map((e) => e.textContent ?? "");
      const preview = [...el.querySelectorAll(".openlfcp-pane-preview .openlfcp-pane-line")].map((e) => e.textContent ?? "");
      const pv = st.facts.preview;
      const wantPreview =
        pv === undefined
          ? null
          : {
              counts: `${H.shareCounts(pv.counts)}.`,
              warnings: pv.warnings.map((w) => H.shareWarningText(w)).filter((t) => t !== null),
            };
      const cards = el.querySelectorAll(".openlfcp-pane-card");
      const out = {
        cards: cards.length,
        word: el.querySelector(".openlfcp-pane-status-word")?.textContent ?? null,
        bullets: el.querySelectorAll(".openlfcp-pane-status, .openlfcp-pane-effects, .openlfcp-pane-actions").length,
        cta: cards[0]?.querySelectorAll("button.mod-cta").length ?? 0,
        active: app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.file?.path ?? null,
        primary: primary === null ? null : { action: primary.dataset.action ?? null, disabled: primary.getAttribute("aria-disabled") === "true" },
        none: el.querySelector(".openlfcp-pane-none")?.textContent ?? null,
        actions,
        menu,
        all: el.textContent ?? "",
        texts: [...texts, ...menu.map((i) => i.title)],
        preview,
        wantPreview,
      };
      return out;
    },
    BUNDLE,
    st,
    PANE,
  );

/** Closes the pane's menu, if one is open, with a real Escape, and waits until it is gone. */
const closeMenu = async () => {
  if (!(await inA(() => document.querySelector(".menu") !== null))) return;
  await browser.keys("Escape");
  await browser.waitUntil(() => inA(() => document.querySelector(".menu") === null), { timeout: 5_000, timeoutMsg: "the menu closed" });
};

/** Puts the real sections host back and closes the pane. */
const restore = () =>
  inA(async ({ app }, pane) => {
    // The menus setting the specs changed goes back to what it was.
    if (window.__lfcpNativeMenus !== undefined) {
      app.vault.setConfig("nativeMenus", window.__lfcpNativeMenus.value);
      delete window.__lfcpNativeMenus;
    }
    app.workspace.detachLeavesOfType(pane);
    await app.plugins.disablePlugin("shared-tasks");
    await app.plugins.enablePlugin("shared-tasks");
  }, PANE);

describe("LFCP-03-025: the UX fixture states in the real plugin's pane", function () {
  this.timeout(180_000);
  const results = [];

  before(() => mkdirSync(OUT, { recursive: true }));
  after(async () => {
    await restore();
    evidence("FIXTURE-STATES native", {
      drawn: results.filter((r) => r.result === "PASS").length,
      failed: results.filter((r) => r.result === "FAIL").map((r) => r.id),
      notRun: Object.entries(NATIVE_NOT_RUN).map(([id, why]) => ({ id, why })),
    });
  });

  it("names the states it does not draw, and they exist", () => {
    const ids = new Set(doc.states.map((s) => s.id));
    for (const id of Object.keys(NATIVE_NOT_RUN)) expect(ids.has(id)).toBe(true);
    for (const [id, why] of Object.entries(NATIVE_NOT_RUN)) evidence(`FIXTURE ${id}`, { result: "NOT_RUN", why });
  });

  for (const st of doc.states) {
    if (NATIVE_NOT_RUN[st.id] !== undefined) continue;
    it(`${st.id}: the fixture's primary action, actions with reasons, claims`, async () => {
      const d = await draw(st);
      await closeMenu();
      await $(".openlfcp-pane")
        .saveScreenshot(path.join(OUT, `${st.id}.png`))
        .catch((e) => evidence(`FIXTURE ${st.id} screenshot`, { error: String(e) }));
      // A button of the pane, or an item of its menu: blocked or not, and why (a menu item's title says it).
      const by = (id) => {
        const b = d.actions.find((a) => a.action === id);
        if (b !== undefined) return b;
        const label = doc.actions.find((a) => a.id === id)?.label;
        const item = d.menu.find((i) => i.title === label || i.title.startsWith(`${label} — `));
        return item === undefined ? undefined : { action: id, disabled: item.disabled, reason: item.disabled ? item.title.slice(label.length + 3) : null };
      };
      const problems = [];
      const wantPrimary = st.expected.primaryCta;
      if ((d.primary?.action ?? null) !== wantPrimary) problems.push(`primary ${d.primary?.action ?? null}, want ${wantPrimary}`);
      if (d.primary !== null && d.primary.disabled) problems.push("primary drawn disabled");
      if (d.primary === null && wantPrimary === null && d.none !== st.expected.primaryCtaNone) problems.push(`no primary: "${d.none}", want "${st.expected.primaryCtaNone}"`);
      for (const e of st.expected.enabled) {
        const b = by(e.action);
        if (b === undefined) problems.push(`${e.action} not drawn`);
        else if (b.disabled) problems.push(`${e.action} disabled (${b.reason})`);
      }
      for (const x of st.expected.disabled) {
        const b = by(x.action);
        if (b === undefined) problems.push(`${x.action} not drawn`);
        else {
          if (!b.disabled) problems.push(`${x.action} enabled`);
          if (b.reason !== x.reason) problems.push(`${x.action} reason "${b.reason}", want "${x.reason}"`);
        }
      }
      // UX-08: one card with a status word; no status bullets, effects paragraph or stack of buttons.
      if (d.cards !== 1) problems.push(`${d.cards} cards, want 1`);
      if (d.word === null || d.word === "") problems.push("no status word");
      if (d.bullets !== 0) problems.push(`${d.bullets} status or effects blocks on the surface`);
      if (d.cta > 1) problems.push(`${d.cta} mod-cta buttons in the card`);
      for (const claim of [...st.expected.requiredClaims, ...(st.expected.requiredListClaims ?? [])])
        if (!d.all.includes(claim)) problems.push(`missing claim "${claim}"`);
      for (const claim of [...st.expected.forbiddenClaims, ...doc.globalForbiddenClaims])
        for (const t of d.texts) if (!time.test(t) && t.toLowerCase().includes(claim.toLowerCase())) problems.push(`"${t}" says "${claim}"`);
      if (d.wantPreview !== null) {
        if (!d.preview.includes(d.wantPreview.counts)) problems.push(`preview without "${d.wantPreview.counts}"`);
        for (const w of d.wantPreview.warnings) if (!d.preview.includes(w)) problems.push(`preview without "${w}"`);
        if (!d.preview.join(" | ").includes("Sync server: wss://sync.example/v1/ws.")) problems.push("preview without its sync server");
      }
      results.push({ id: st.id, result: problems.length === 0 ? "PASS" : "FAIL" });
      evidence(`FIXTURE ${st.id}`, {
        result: problems.length === 0 ? "PASS" : "FAIL",
        active: d.active,
        primary: d.primary,
        word: d.word,
        problems,
        ...(problems.length > 0 ? { actions: d.actions, menu: d.menu, text: d.all.slice(0, 800) } : {}),
      });
      expect(problems).toEqual([]);
    });
  }
});
