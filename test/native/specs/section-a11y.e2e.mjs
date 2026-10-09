// LFCP-02-064: keyboard, focus and accessible visual behavior of section
// status in a real Obsidian editor (UX09, UX16). The production status
// extension, live region and next-problem path, on statuses from mock facts
// (the section-sync harness: no SDK, no server); the plugin's own styles.
// The card's keyboard flow with the real plugin is in section-preview.

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const R = "LWB1c56f0jsstqrVjCb3kKmiY9K_7wig-OtGwO6EIfo";
const SID = "268a166f-4891-7243-840e-e7fea9fe6390";
const SEC = `lfcp1:${R}#section:${SID}`;
const KEY = `${R}#${SID}`;
const task = (i) => `84cf3237-3432-7041-881f-${String(i).padStart(12, "0")}`;
const N = 200;

const NOTE = [
  "Private intro.",
  "",
  "## Joint launch",
  `<!-- lfcp-section: ${SEC} -->`,
  ...Array.from({ length: N }, (_, i) => [
    `- [ ] Task ${i}`,
    `  <!-- lfcp-ref: lfcp1:${R}#task:${task(i)} -->`,
  ]).flat(),
  `<!-- /lfcp-section: ${SEC} -->`,
  "",
  "Private outro.",
  "",
].join("\n");
/** 0-based line of Task i. */
const lineOf = (i) => 4 + 2 * i;

const set = (facts) => browser.execute((f) => window.__lfcpSectionSync.setStatuses(f), facts);
const pending = (ids) => ({
  batches: [{ id: "b-pending", nodeIds: ids, durable: true, unitIds: ["u"], acceptedUnitIds: [] }],
});
const conflict = (ids) => ({ problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds: ids }] });
const failed = (id) => ({
  batches: [{ id, nodeIds: [task(3)], durable: false, failed: true, unitIds: [], acceptedUnitIds: [] }],
});

describe("LFCP-02-064: keyboard and accessible status (harness statuses, real editor)", () => {
  before(async () => {
    await browser.executeObsidian(async ({ app, obsidian }, note) => {
      await app.plugins.enablePlugin("lfcp-section-sync");
      if (app.vault.getFileByPath("a11y.md") === null) await app.vault.create("a11y.md", note);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("a11y.md"), { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() !== note; i++) await new Promise((r) => setTimeout(r, 50));
    }, NOTE);
  });

  after(async () => {
    await browser.executeObsidian(async ({ app }) => {
      await app.plugins.disablePlugin("lfcp-section-sync");
    });
  });

  it("200 pending rows: one Tab stop (the badge); row cues are labelled images, not controls", async () => {
    await set({ [KEY]: pending(Array.from({ length: N }, (_, i) => task(i))) });
    const out = await browser.executeObsidian(async ({ app, obsidian }) => {
      await new Promise((r) => setTimeout(r, 300));
      const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView).containerEl;
      const ui = [...root.querySelectorAll("[data-lfcp-ui]")];
      const focusable = ui.filter((e) => e.tabIndex >= 0);
      const cues = [...root.querySelectorAll(".openlfcp-row-cue")];
      return {
        focusable: focusable.map((e) => [e.getAttribute("role"), e.getAttribute("aria-label")]),
        cues: cues.length,
        cueRoles: [...new Set(cues.map((c) => `${c.getAttribute("role")}:${c.getAttribute("aria-label")}`))],
        cueTabIndex: [...new Set(cues.map((c) => c.tabIndex))],
        svgHidden: [...root.querySelectorAll("[data-lfcp-ui] svg")].every((s) => s.getAttribute("aria-hidden") === "true"),
      };
    });
    evidence("A11Y-TAB-STOPS", out);
    expect(out.focusable).toEqual([
      // One pending batch over all 200 rows: the badge counts batches (§4).
      ["button", "Shared section Joint launch, 1 local update waiting, open details"],
    ]);
    expect(out.cues).toBeGreaterThan(10);
    expect(out.cueRoles).toEqual(["img:Local update waiting"]);
    expect(out.cueTabIndex).toEqual([-1]);
    expect(out.svgHidden).toBe(true);
  });

  it("a blocking condition is announced once; its retries and pending work say nothing", async () => {
    await set({ [KEY]: pending([task(1)]) });
    const start = (await browser.execute(() => window.__lfcpSectionSync.announced.length));
    await set({ [KEY]: failed("b1") });
    await set({ [KEY]: failed("b2") });
    await set({ [KEY]: failed("b3") });
    await set({ [KEY]: pending([task(1), task(2)]) });
    const out = await browser.execute(async () => {
      await new Promise((r) => setTimeout(r, 300));
      const s = window.__lfcpSectionSync;
      const region = document.querySelector(".openlfcp-live-region");
      return {
        announced: s.announced.slice(),
        live: s.live(),
        role: region?.getAttribute("role"),
        politeness: region?.getAttribute("aria-live"),
        inNote: region?.closest(".markdown-source-view, .markdown-reading-view") !== null,
      };
    });
    evidence("A11Y-ANNOUNCE", out);
    expect(out.announced.length - start).toBe(1);
    expect(out.announced.at(-1)).toMatch(/^Shared section Joint launch needs attention: /);
    expect(out.role).toBe("status");
    expect(out.politeness).toBe("polite");
    expect(out.inNote).toBe(false);
  });

  it("UX09: problems in a folded section stay visible at the heading and are reached by command", async () => {
    await set({ [KEY]: conflict([task(150), task(20)]) });
    const out = await browser.executeObsidian(async ({ app, obsidian }, headingLine) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: headingLine, ch: 0 });
      app.commands.executeCommandById("editor:toggle-fold");
      await new Promise((r) => setTimeout(r, 300));
      const root = view.containerEl;
      const headingCue = [...root.querySelectorAll(".cm-line")]
        .find((l) => l.textContent.startsWith("## Joint launch") || l.textContent.startsWith("Joint launch"))
        ?.querySelector(".openlfcp-row-cue")
        ?.getAttribute("aria-label");
      const folded = root.querySelectorAll(".cm-foldPlaceholder").length;
      view.editor.setCursor({ line: 0, ch: 0 });
      const s = window.__lfcpSectionSync;
      const steps = [];
      for (let i = 0; i < 3; i++) {
        const said = s.nextProblem();
        await new Promise((r) => setTimeout(r, 200));
        steps.push({ said, line: view.editor.getCursor().line, live: s.live() });
      }
      return {
        headingCue,
        folded,
        steps,
        foldedAfter: root.querySelectorAll(".cm-foldPlaceholder").length,
        focused: view.editor.hasFocus(),
      };
    }, 2);
    evidence("A11Y-NEXT-PROBLEM", out);
    expect(out.folded).toBeGreaterThan(0);
    expect(out.headingCue).toBe("Needs attention");
    expect(out.steps.map((s) => s.line)).toEqual([lineOf(20), lineOf(150), lineOf(20)]);
    expect(out.steps[0].said).toBe(
      `Problem 1 of 2, in shared section Joint launch, line ${lineOf(20) + 1}. Open its details to resolve it.`,
    );
    expect(out.steps[0].live).toBe(out.steps[0].said);
    expect(out.foldedAfter).toBe(0);
    expect(out.focused).toBe(true);
  });

  /** Back to the top of the note: CodeMirror renders only the lines in view, the heading's badge among them. */
  const toTop = () =>
    browser.executeObsidian(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 300));
    });

  it("the badge opens details with Enter and Space, never by hover alone", async () => {
    await set({ [KEY]: {} });
    await toTop();
    const opened = [];
    for (const key of ["Enter", "Space"]) {
      await browser.executeObsidian(async ({ app, obsidian }) => {
        await new Promise((r) => setTimeout(r, 200));
        app.workspace.getActiveViewOfType(obsidian.MarkdownView).containerEl.querySelector(".openlfcp-status").focus();
      });
      await browser.keys([key === "Space" ? " " : "Enter"]);
      opened.push(await browser.execute(() => window.__lfcpSectionSync.opened.length));
    }
    const doc = await browser.executeObsidian(({ app, obsidian }) =>
      app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.getValue(),
    );
    expect(opened[1] - opened[0]).toBe(1);
    expect(opened[0]).toBeGreaterThan(0);
    expect(doc).toBe(NOTE);
  });

  it("contrast in the actual light and dark themes; text size; no motion", async () => {
    await toTop();
    const out = await browser.executeObsidian(async ({ app, obsidian }, key) => {
      const s = window.__lfcpSectionSync;
      const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView).containerEl;
      const wait = () => new Promise((r) => setTimeout(r, 300));
      // "rgb(r, g, b)", or "color(srgb r g b)" (0..1) for a color-mix().
      const rgb = (c) => {
        const m = c.match(/[\d.]+/g).map(Number);
        if (c.startsWith("color(")) return { r: m[0] * 255, g: m[1] * 255, b: m[2] * 255, a: m[3] ?? 1 };
        return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
      };
      const bg = () => rgb(getComputedStyle(root.querySelector(".cm-scroller")).backgroundColor === "rgba(0, 0, 0, 0)"
        ? getComputedStyle(document.body).backgroundColor
        : getComputedStyle(root.querySelector(".cm-scroller")).backgroundColor);
      const cases = {
        CURRENT: [{}, ".openlfcp-status-mark"],
        OFFLINE: [{ connection: "offline" }, ".openlfcp-status-icon"],
        ATTENTION: [{ problems: [{ kind: "scalar", code: "X", nodeIds: [] }] }, ".openlfcp-status-icon"],
        LOCAL_SAVE_FAILED: [
          { batches: [{ id: "f", nodeIds: [], durable: false, failed: true, unitIds: [], acceptedUnitIds: [] }] },
          ".openlfcp-status-icon",
        ],
      };
      const themes = {};
      const original = app.vault.getConfig("theme");
      for (const theme of ["moonstone", "obsidian"]) {
        app.vault.setConfig("theme", theme);
        app.updateTheme?.();
        await wait();
        const row = { body: document.body.classList.contains("theme-dark") ? "dark" : "light" };
        for (const [state, [facts, sel]] of Object.entries(cases)) {
          s.setStatuses({ [key]: facts });
          await wait();
          const badge = root.querySelector(".openlfcp-status");
          const el = badge.querySelector(sel);
          row[state] = {
            state: badge.dataset.state,
            ratio: ratio(rgb(getComputedStyle(el).color), bg()),
            animation: [badge, ...badge.querySelectorAll("*")].every(
              (e) => getComputedStyle(e).animationName === "none",
            ),
          };
        }
        themes[theme] = row;
      }
      app.vault.setConfig("theme", original);
      app.updateTheme?.();
      // Text size: the badge follows the editor's font size and stays on its line.
      s.setStatuses({ [key]: { connection: "offline" } });
      const sizes = [];
      for (const px of [16, 32]) {
        document.body.style.setProperty("--font-text-size", `${px}px`);
        await wait();
        const badge = root.querySelector(".openlfcp-status");
        const line = badge.closest(".cm-line").getBoundingClientRect();
        const mark = badge.querySelector(".openlfcp-status-mark").getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        sizes.push({ px, mark: Math.round(mark.width), inLine: b.top >= line.top - 1 && b.bottom <= line.bottom + 1 });
      }
      document.body.style.removeProperty("--font-text-size");
      return { themes, sizes };
    }, KEY);
    evidence("A11Y-CONTRAST", out);
    for (const theme of Object.values(out.themes))
      for (const [state, v] of Object.entries(theme)) {
        if (state === "body") continue;
        expect(v.state).toBe(state);
        // WCAG 1.4.11: graphics that carry meaning, 3:1 against the background.
        expect(v.ratio).toBeGreaterThanOrEqual(3);
        expect(v.animation).toBe(true);
      }
    expect(new Set(Object.values(out.themes).map((t) => t.body))).toEqual(new Set(["light", "dark"]));
    expect(out.sizes[1].mark / out.sizes[0].mark).toBeGreaterThan(1.8);
    expect(out.sizes.every((s) => s.inLine)).toBe(true);
  });

  it("more contrast and forced colors: full-strength shapes (emulated media, when the driver allows it)", async () => {
    let emulated = null;
    try {
      const puppeteer = await browser.getPuppeteer();
      const pages = await puppeteer.pages();
      const page = pages.find((p) => !p.url().startsWith("devtools")) ?? pages[0];
      const read = () =>
        page.evaluate(() => {
          const badge = document.querySelector(".openlfcp-status");
          const path = badge.querySelector(".openlfcp-status-mark path");
          return {
            opacity: getComputedStyle(path).strokeOpacity,
            color: getComputedStyle(badge).color,
            normal: getComputedStyle(document.body).color,
          };
        });
      await page.emulateMediaFeatures([{ name: "prefers-contrast", value: "more" }]);
      const more = await read();
      await page.emulateMediaFeatures([{ name: "forced-colors", value: "active" }]);
      const forced = await read();
      await page.emulateMediaFeatures([]);
      emulated = { more, forced };
    } catch (e) {
      emulated = { notRun: String(e?.message ?? e).slice(0, 200) };
    }
    evidence("A11Y-CONTRAST-MODES", emulated);
    if (emulated.notRun !== undefined) return;
    expect(emulated.more.opacity).toBe("1");
    expect(emulated.more.color).toBe(emulated.more.normal);
    expect(emulated.forced.opacity).toBe("1");
  });
});
