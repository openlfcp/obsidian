// LFCP-03-022 (U03-18, U03-19, U03-20; G03-F, G03-C): the Shared Tasks pane
// by keyboard, in the editor modes and over the plugin's lifecycle, in a
// real Obsidian. Shared sections on, a sync server that never answers: a
// share stays on this device, nothing leaves it.
//
// - Keyboard: the command palette by its real keys (Cmd+P on macOS,
//   Ctrl+P elsewhere) opens the pane with focus on its heading; Tab walks
//   its controls and leaves it (no trap); Enter on "Share section…" opens
//   the dialog, Tab stays in it (Obsidian's modal), Escape closes it and
//   focus is back on the pane's button; the share is made by keyboard too.
// - Obsidian's own behaviour, as the plugin finds it (evidence): where a
//   plain Modal leaves focus when it closes.
// - Live updates: a redraw while the user types in the note, or while focus
//   is on a pane button, takes no focus.
// - The join field: typed text, the caret and an IME composition survive a
//   redraw; Enter during the composition joins nothing; Escape cancels the
//   field and focus is back on "Join with a link…". The composition goes
//   through Chromium's IME path (CDP Input.imeSetComposition), not through
//   synthetic CodeMirror input; without the DevTools session it is NOT_RUN.
// - Modes: Source, Live Preview and Reading (Reading: "Open for editing").
// - 200% zoom, a narrow sidebar, light and dark: nothing in the pane is wider
//   than the pane. Reduced motion: no animation in the pane.
// - Lifecycle: disabled and enabled three times, the workspace and vault
//   handlers and the live regions are as many as after the first start;
//   one pane. A popout: the pane moved there stays the only one, and the
//   copy filter works in the popout's document (Reading view, badge).

import { closeModals, evidence, inA, mod } from "./support/section-checks.mjs";

const VIEW = "shared-tasks-pane";
const FILE = "Keys plan.md";
const TEXT = ["## Keys plan", "- [ ] One", "- [ ] Two", "", "A paragraph.", "", "## Later", "Private tail.", ""].join("\n");

/** Where focus is now, in the main window. */
const focus = () =>
  inA(() => {
    const a = document.activeElement;
    return {
      inPane: a?.closest(".openlfcp-pane") != null,
      inModal: a?.closest(".modal-container") != null,
      editor: a?.closest(".cm-editor") != null,
      key: a?.closest("[data-pane-key]")?.getAttribute("data-pane-key") ?? null,
      tag: a?.tagName ?? null,
      text: (a?.textContent ?? "").slice(0, 40),
    };
  });
const primary = () =>
  inA(() => document.querySelector(".openlfcp-pane .openlfcp-pane-primary button")?.textContent ?? null);
const paneText = () => inA(() => document.querySelector(".openlfcp-pane")?.textContent ?? "");
const drawings = () => inA(({ app }, type) => app.workspace.getLeavesOfType(type)[0]?.view?.drawings ?? -1, VIEW);
/** A vault rename: an urgent change, the pane redraws at once. */
const urgentChange = () =>
  inA(async ({ app }) => {
    const name = "Keys scratch.md";
    const other = "Keys scratch 2.md";
    let f = app.vault.getFileByPath(name) ?? app.vault.getFileByPath(other);
    if (f === null) f = await app.vault.create(name, "x");
    await app.vault.rename(f, f.path === name ? other : name);
    await new Promise((r) => setTimeout(r, 200));
  });

/** Opens FILE in `mode` ("source", "live", "preview"), focused, caret on the heading. */
const openNote = (mode) =>
  inA(
    async ({ app, obsidian }, file, text, mode) => {
      if (app.vault.getFileByPath(file) === null) await app.vault.create(file, text);
      const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file) ?? app.workspace.getLeaf(false);
      const state = mode === "preview" ? { mode: "preview" } : { mode: "source", source: mode === "source" };
      await leaf.openFile(app.vault.getFileByPath(file), { state });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (mode !== "preview") {
        for (let i = 0; i < 40 && view.editor.getValue() === ""; i++) await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 0, ch: 3 });
        view.editor.focus();
      }
    },
    FILE,
    TEXT,
    mode,
  );

/** Presses Tab until `want(focus)` or `max` steps; the trail of focus. */
async function tabUntil(want, max = 40, keys = ["Tab"]) {
  const trail = [];
  for (let i = 0; i < max; i++) {
    await browser.keys(keys);
    const f = await focus();
    trail.push(f);
    if (want(f)) return { found: true, trail };
  }
  return { found: false, trail };
}

/** The DevTools page of the main window, or a reason why not. */
async function devtools() {
  try {
    const puppeteer = await browser.getPuppeteer();
    const pages = await puppeteer.pages();
    const page = pages.find((p) => !p.url().startsWith("devtools")) ?? pages[0];
    const cdp = await page.target().createCDPSession();
    return { page, cdp };
  } catch (e) {
    return { notRun: String(e?.message ?? e).slice(0, 200) };
  }
}

describe("LFCP-03-022: keyboard, modes and lifecycle of the pane", () => {
  before(async () => {
    await inA(async ({ app }, type) => {
      app.workspace.detachLeavesOfType(type);
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = "ws://127.0.0.1:9/v1/ws";
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const p = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && p.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    }, VIEW);
    await openNote("live");
  });

  after(async () => {
    await closeModals("pane keyboard").catch(() => undefined);
    await inA(async ({ app }, type) => {
      require("electron").webFrame.setZoomFactor(1);
      app.changeTheme?.("moonstone");
      app.workspace.detachLeavesOfType(type);
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.sectionsDisabled = true;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
    }, VIEW);
  });

  it("U03-18: the palette's keys open the pane, focus on its heading; Tab walks it and leaves it", async () => {
    await browser.keys([mod, "p"]);
    await $(".prompt-input").waitForExist({ timeout: 10_000 });
    await browser.keys("Open Shared Tasks pane".split(""));
    await browser.waitUntil(
      () => inA(() => [...document.querySelectorAll(".suggestion-item")].some((x) => x.textContent.includes("Open Shared Tasks pane"))),
      { timeout: 10_000, timeoutMsg: "the command in the palette" },
    );
    await browser.keys("Enter");
    await $(".openlfcp-pane").waitForExist({ timeout: 10_000 });
    await browser.waitUntil(async () => (await primary()) === "Share section…", { timeout: 20_000, timeoutMsg: "Share section… in the pane" });
    const opened = await focus();
    const leaves = await inA(({ app }, type) => app.workspace.getLeavesOfType(type).length, VIEW);
    const walk = await tabUntil((f) => !f.inPane, 60);
    const visited = walk.trail.filter((f) => f.inPane).map((f) => f.key ?? f.text);
    evidence("KEYS-OPEN", { platform: process.platform, opened, leaves, steps: walk.trail.length, left: walk.found, visited });
    expect(leaves).toBe(1);
    expect(opened).toMatchObject({ inPane: true, key: "title" });
    expect(visited).toContain("action:join-with-link");
    expect(visited).toContain("action:share-section");
    // A pane is not a modal: Tab leaves it.
    expect(walk.found).toBe(true);
  });

  it("U03-18: Obsidian's own Modal, closed by Escape: where focus goes (evidence)", async () => {
    const out = await inA(async ({ obsidian }) => {
      const b = document.querySelector('.openlfcp-pane [data-pane-key="action:share-section"]');
      b.focus();
      const m = new obsidian.Modal(window.app);
      m.titleEl.setText("Probe");
      const input = m.contentEl.createEl("input");
      m.open();
      input.focus();
      return { opened: document.activeElement === input };
    });
    await browser.keys("Escape");
    await browser.pause(300);
    const after = await focus();
    evidence("KEYS-OBSIDIAN-MODAL", { ...out, after });
  });

  it("U03-18: Enter opens the share dialog, Tab stays in it, Escape gives focus back; the share by keyboard", async () => {
    await inA(() => document.querySelector('.openlfcp-pane [data-pane-key="action:share-section"]')?.focus());
    await browser.keys("Enter");
    await $(".modal-container .modal").waitForExist({ timeout: 10_000 });
    const inDialog = await focus();
    const walk = await tabUntil((f) => !f.inModal, 20);
    const back = await tabUntil((f) => !f.inModal, 10, ["Shift", "Tab"]);
    await browser.keys("Escape");
    await browser.waitUntil(() => inA(() => document.querySelector(".modal-container") === null), { timeout: 5_000 });
    await browser.pause(300);
    const afterEscape = await focus();
    const note = await inA(({ app }, f) => app.vault.cachedRead(app.vault.getFileByPath(f)), FILE);
    evidence("KEYS-DIALOG", { inDialog, trapped: !walk.found && !back.found, trail: walk.trail.map((f) => f.text), afterEscape, noteUnchanged: note === TEXT });
    expect(inDialog.inModal).toBe(true);
    expect(walk.found).toBe(false);
    expect(back.found).toBe(false);
    expect(afterEscape).toMatchObject({ inPane: true, key: "action:share-section" });
    expect(note).toBe(TEXT);

    // Again by Enter; Tab to Share, Enter: the section is made on this device.
    await browser.keys("Enter");
    await $(".modal-container .modal").waitForExist({ timeout: 10_000 });
    const toShare = await tabUntil((f) => f.tag === "BUTTON" && f.text === "Share", 20);
    expect(toShare.found).toBe(true);
    await browser.keys("Enter");
    await browser.waitUntil(() => inA(() => document.querySelector(".modal-container") === null), { timeout: 20_000, timeoutMsg: "the share dialog closed" });
    await browser.waitUntil(
      () => inA(({ app }, f) => app.vault.cachedRead(app.vault.getFileByPath(f)).then((t) => t.includes("lfcp-section:")), FILE),
      { timeout: 30_000, timeoutMsg: "the section bound in the note" },
    );
    await browser.pause(500);
    const afterShare = await focus();
    evidence("KEYS-SHARE", { afterShare, pane: (await paneText()).slice(0, 300) });
    expect(afterShare.inPane).toBe(true);
  });

  it("U03-18: a redraw takes no focus: typing in the note, or on a pane button", async () => {
    await openNote("live");
    await inA(({ obsidian }) => {
      const view = window.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l === "A paragraph.");
      view.editor.setCursor({ line, ch: "A paragraph.".length });
      view.editor.focus();
    });
    const before = await drawings();
    await browser.keys(" more".split(""));
    await browser.pause(400);
    await urgentChange();
    const typing = await focus();
    const drawnTyping = (await drawings()) - before;
    await inA(() => document.querySelector('.openlfcp-pane [data-pane-key="action:join-with-link"]')?.focus());
    const before2 = await drawings();
    await urgentChange();
    const onButton = await focus();
    const drawnButton = (await drawings()) - before2;
    evidence("KEYS-REDRAW", { typing, drawnTyping, onButton, drawnButton });
    expect(drawnTyping).toBeGreaterThan(0);
    expect(typing.editor).toBe(true);
    expect(drawnButton).toBeGreaterThan(0);
    expect(onButton).toMatchObject({ inPane: true, key: "action:join-with-link" });
  });

  it("U03-18, IME: the join field through a redraw and a composition; Enter in it joins nothing; Escape cancels", async () => {
    await inA(() => document.querySelector('.openlfcp-pane [data-pane-key="action:join-with-link"]')?.focus());
    await browser.keys("Enter");
    await $(".openlfcp-pane input.openlfcp-pane-join-input").waitForExist({ timeout: 10_000 });
    const field = await focus();
    await browser.keys("Tab");
    await browser.keys("Plan".split(""));
    await inA(() => {
      document.querySelector(".openlfcp-pane input.openlfcp-pane-join-name").__lfcpMark = 1;
    });
    await urgentChange();
    const read = () =>
      inA(() => {
        const n = document.querySelector(".openlfcp-pane input.openlfcp-pane-join-name");
        return {
          same: n?.__lfcpMark === 1,
          value: n?.value ?? null,
          caret: n?.selectionStart ?? null,
          focused: document.activeElement === n,
          fieldOpen: document.querySelector(".openlfcp-pane form.openlfcp-pane-join-form") !== null,
          malformed: (document.querySelector(".openlfcp-pane")?.textContent ?? "").includes("not an invitation link"),
        };
      });
    const typed = await read();
    expect(field).toMatchObject({ inPane: true, key: "join-input" });
    expect(typed).toMatchObject({ same: true, value: "Plan", caret: 4, focused: true });

    const dt = await devtools();
    let ime;
    if (dt.notRun !== undefined) ime = { notRun: dt.notRun };
    else {
      await dt.cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
      await urgentChange();
      const composing = await read();
      // Enter while the composition is open (Chromium sends it with isComposing).
      await dt.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await dt.cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter" });
      await dt.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await browser.pause(300);
      const afterEnter = await read();
      await dt.cdp.send("Input.insertText", { text: "仮名" });
      await browser.pause(200);
      ime = { composing, afterEnter, committed: await read() };
      await dt.cdp.detach().catch(() => undefined);
    }
    evidence("KEYS-JOIN-IME", { field, typed, ime });
    if (ime.notRun === undefined) {
      expect(ime.composing).toMatchObject({ same: true, focused: true });
      expect(ime.composing.value).toContain("Plan");
      expect(ime.afterEnter).toMatchObject({ fieldOpen: true, malformed: false });
      expect(ime.committed).toMatchObject({ same: true, fieldOpen: true, malformed: false });
      expect(ime.committed.value.startsWith("Plan")).toBe(true);
    }

    await browser.keys("Escape");
    await browser.waitUntil(() => inA(() => document.querySelector(".openlfcp-pane form") === null), { timeout: 5_000, timeoutMsg: "the field cancelled" });
    const afterEscape = await focus();
    evidence("KEYS-JOIN-ESCAPE", { afterEscape });
    expect(afterEscape).toMatchObject({ inPane: true, key: "action:join-with-link" });
  });

  it("U03-19: Source, Live Preview and Reading: the pane's context and next step", async () => {
    // A private heading of the note (outside the section) under the cursor.
    const seen = {};
    for (const mode of ["source", "live", "preview"]) {
      await openNote(mode);
      if (mode !== "preview")
        await inA(({ obsidian }) => {
          const view = window.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          const line = view.editor.getValue().split("\n").findIndex((l) => l === "## Later");
          view.editor.setCursor({ line, ch: 3 });
        });
      await browser.pause(600);
      seen[mode] = { primary: await primary(), text: (await paneText()).slice(0, 400) };
    }
    evidence("MODES", seen);
    expect(seen.source.primary).toBe("Share section…");
    expect(seen.live.primary).toBe("Share section…");
    expect(seen.preview.text).toContain("Reading view: open the note for editing to change it.");
    expect(seen.preview.primary === null || seen.preview.primary === "Open for editing").toBe(true);
  });

  it("U03-19: 200% zoom, a narrow sidebar, light and dark: nothing wider than the pane; reduced motion", async () => {
    await openNote("live");
    const measure = () =>
      inA(() => {
        const pane = document.querySelector(".openlfcp-pane");
        const box = pane.getBoundingClientRect();
        const wide = [...pane.querySelectorAll("*")]
          .filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > box.right + 1)
          .map((e) => `${e.tagName}.${e.className}`.slice(0, 60));
        const anim = [...pane.querySelectorAll("*")].filter((e) => getComputedStyle(e).animationName !== "none").length;
        return {
          width: Math.round(box.width),
          overflow: pane.scrollWidth > pane.clientWidth + 1,
          wide: wide.slice(0, 5),
          anim,
          body: document.body.classList.contains("theme-dark") ? "dark" : "light",
        };
      });
    const out = [];
    for (const theme of ["moonstone", "obsidian"])
      for (const zoom of [1, 2]) {
        await inA(
          ({ app }, theme, zoom) => {
            app.changeTheme?.(theme);
            require("electron").webFrame.setZoomFactor(zoom);
            const split = app.workspace.rightSplit;
            if (typeof split?.setSize === "function") split.setSize(240);
            // The join field open too: its inputs must fit.
            if (document.querySelector(".openlfcp-pane form") === null)
              document.querySelector('.openlfcp-pane [data-pane-key="action:join-with-link"]')?.click();
          },
          theme,
          zoom,
        );
        await browser.pause(600);
        out.push({ theme, zoom, ...(await measure()) });
      }
    let reduced;
    const dt = await devtools();
    if (dt.notRun !== undefined) reduced = { notRun: dt.notRun };
    else {
      await dt.page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      reduced = await measure();
      await dt.page.emulateMediaFeatures([]);
      await dt.cdp.detach().catch(() => undefined);
    }
    await inA(() => {
      require("electron").webFrame.setZoomFactor(1);
      window.app.changeTheme?.("moonstone");
      [...document.querySelectorAll(".openlfcp-pane form button")].find((b) => b.textContent === "Cancel")?.click();
    });
    evidence("VISUAL", { out, reduced });
    expect(new Set(out.map((o) => o.body))).toEqual(new Set(["light", "dark"]));
    for (const o of out) {
      expect(o.overflow).toBe(false);
      expect(o.wide).toEqual([]);
      expect(o.anim).toBe(0);
    }
    if (reduced.notRun === undefined) expect(reduced.anim).toBe(0);
  });

  it("U03-20: disabled and enabled three times: no handler or live region more; one pane", async () => {
    const count = () =>
      inA(({ app }, type) => {
        const n = (ev) => Object.values(ev?._ ?? {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
        return {
          workspace: n(app.workspace),
          vault: n(app.vault),
          metadata: n(app.metadataCache),
          live: document.querySelectorAll(".openlfcp-live-region").length,
          panes: app.workspace.getLeavesOfType(type).length,
          paneEls: document.querySelectorAll(".openlfcp-pane").length,
        };
      }, VIEW);
    const cycle = () =>
      inA(async ({ app }) => {
        await app.plugins.disablePlugin("shared-tasks");
        await app.plugins.enablePlugin("shared-tasks");
        const p = app.plugins.plugins["shared-tasks"];
        for (let i = 0; i < 100 && p.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
        await p.openPane();
        await new Promise((r) => setTimeout(r, 500));
      });
    await cycle();
    const first = await count();
    for (let i = 0; i < 3; i++) await cycle();
    const last = await count();
    evidence("LIFECYCLE", { first, last });
    expect(last).toEqual(first);
    expect(last.panes).toBe(1);
    expect(last.paneEls).toBe(1);
    expect(last.live).toBe(1);
  });

  it("U03-20, U03-19: a popout: the pane there is the only one; the copy filter works in its document", async () => {
    const out = await inA(async ({ app }, type, file) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = app.plugins.plugins["shared-tasks"];
      // The pane moved to a popout window.
      app.workspace.detachLeavesOfType(type);
      const paneLeaf = app.workspace.openPopoutLeaf();
      await paneLeaf.setViewState({ type, active: true });
      await sleep(500);
      await p.openPane();
      await sleep(300);
      const panes = app.workspace.getLeavesOfType(type);
      const paneDoc = panes[0]?.view.containerEl.doc;
      const pane = {
        leaves: panes.length,
        inPopout: paneDoc !== undefined && paneDoc !== document,
        drawn: paneDoc?.querySelector(".openlfcp-pane") != null,
        focused: paneDoc?.activeElement?.getAttribute("data-pane-key") ?? null,
      };
      // The note in Reading view in another popout; a selection over its badge; a copy there.
      const noteLeaf = app.workspace.openPopoutLeaf();
      await noteLeaf.openFile(app.vault.getFileByPath(file), { state: { mode: "preview" } });
      const doc = noteLeaf.view.containerEl.doc;
      let badge = null;
      for (let i = 0; i < 80 && badge === null; i++) {
        await sleep(100);
        badge = noteLeaf.view.containerEl.querySelector(".markdown-preview-view h2 .openlfcp-status");
      }
      let copy = { badge: false };
      if (badge !== null) {
        const range = doc.createRange();
        const sizer = noteLeaf.view.containerEl.querySelector(".markdown-preview-sizer");
        range.setStartBefore(badge.closest("h2"));
        range.setEndAfter(sizer.lastElementChild);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const win = doc.defaultView;
        const data = new win.DataTransfer();
        const e = new win.ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
        doc.dispatchEvent(e);
        copy = {
          badge: true,
          popout: doc !== document,
          filtered: e.defaultPrevented,
          text: data.getData("text/plain").slice(0, 200),
          html: data.getData("text/html"),
        };
      }
      noteLeaf.detach();
      paneLeaf.detach();
      await sleep(500);
      return { pane, copy };
    }, VIEW, FILE);
    evidence("POPOUT", { pane: out.pane, copy: { ...out.copy, html: (out.copy.html ?? "").length } });
    expect(out.pane).toMatchObject({ leaves: 1, inPopout: true, drawn: true });
    expect(out.copy).toMatchObject({ badge: true, popout: true, filtered: true });
    expect(out.copy.text).toContain("Keys plan");
    expect(out.copy.html).not.toMatch(/openlfcp-status|data-lfcp-ui/);
  });
});
