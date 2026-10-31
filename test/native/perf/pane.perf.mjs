// Performance of the Shared Tasks pane in a real Obsidian (LFCP-03-026,
// U03-22), against the budgets frozen in docs/devel/testing/pilot-0.3.md
// (LFCP-03-006, §1): B1 context update, B2 warm pane open, B3 cold pane
// open, B4 loading feedback, B5 no full-vault scan per caret event, B6 no
// status writes. Results: docs/devel/reports/upgrade-rollback-perf-0.5.md.
//
// Not a spec: the harness runs it only with NATIVE_PERF=1 (native.yml, input
// "perf"), in CI, never on a developer's machine. It measures and records,
// it does not gate on a budget: each metric prints a "METRIC {json}" line and
// all raw samples go to $LFCP_PERF_DIR/pane-<os>-<obsidian>.json. It asserts
// only that the flows it measures worked.
//
// Corpus P200: the seeded W200 workload (test/perf/workloads.ts) shared as
// one section, inserted into a second note (two projections), and 300
// private notes of about 2 KB. The server is local (no network wait in
// B1-B3, B5, B6). Timing points are taken in the page around the plugin's
// own code: the host event is caused from the page (setCursor,
// setActiveLeaf, the pane command) and the end is the pane's draw
// committed to the DOM (the view's `drawings` counter, read when its
// synchronous draw returns). Five warm-up samples, then 30.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { restartableServer, WORKLOADS, workloadNote } from "../peer.bundle.mjs";
import { closeModals, evidence, inA } from "../specs/support/section-checks.mjs";

const WARMUP = 5;
const SAMPLES = 30;
const PRIVATE_NOTES = 300;
const VIEW = "shared-tasks-pane";
const MAIN = "P200.md";
const SECOND = "P200 second.md";
const ROOT = path.resolve(import.meta.dirname, "../../..");

const results = { meta: {}, metrics: {}, counters: {} };

/** p50, p95 (nearest rank), max, mean of `xs` (ms). */
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const rank = (q) => s[Math.max(0, Math.ceil(q * s.length) - 1)];
  const r = (x) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(rank(0.5)), p95: r(rank(0.95)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

function record(id, samples, extra = {}) {
  const valid = samples.filter((x) => typeof x === "number");
  const out = { ...stats(valid), missing: samples.length - valid.length, ...extra };
  results.metrics[id] = { ...out, samples };
  console.log(`METRIC ${JSON.stringify({ name: id, ...out })}`);
  return out;
}

/** Runs `sample` WARMUP + SAMPLES times; the measured ones (ms or null). */
async function series(sample) {
  const out = [];
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const ms = await sample(i);
    if (i >= WARMUP) out.push(ms);
  }
  return out;
}

/** Deterministic private text of about 2 KB (no Task lines, no markers). */
function privateNote(i) {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett"];
  const lines = [`# Private ${i}`, ""];
  let n = i * 7919;
  while (lines.join("\n").length < 2000) {
    const line = [];
    for (let w = 0; w < 12; w++) {
      n = (n * 1103515245 + 12345) % 2147483648;
      line.push(words[n % words.length]);
    }
    lines.push(`${line.join(" ")}.`, "");
  }
  return lines.join("\n");
}

const ready = () =>
  inA(async ({ app }) => {
    const p = app.plugins.plugins["shared-tasks"];
    for (let i = 0; i < 400 && p?.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    return p?.runtime?.status?.kind ?? null;
  });

/** Opens `file` in a tab of its own (or the existing one), Live Preview, the caret at `line`. */
const openNote = (file, line) =>
  inA(
    async ({ app, obsidian }, file, line) => {
      let leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === file);
      if (leaf === undefined) {
        leaf = app.workspace.getLeaf("tab");
        await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: false } });
      }
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      for (let i = 0; i < 40 && view.editor.getValue() === ""; i++) await new Promise((r) => setTimeout(r, 50));
      view.editor.setCursor({ line, ch: 0 });
    },
    file,
    line,
  );

const read = (file) => inA(({ app }, file) => app.vault.adapter.read(file), file);

/** The lines of the section in `md`: its opening and closing marker lines. */
function sectionLines(md) {
  const L = md.split("\n");
  const start = L.findIndex((l) => l.includes("<!-- lfcp-section: "));
  const end = L.findIndex((l) => l.includes("<!-- /lfcp-section: "));
  return { start, end, lines: L.length };
}

const paneButton = (id) =>
  inA((_o, id) => {
    const b = document.querySelector(`.openlfcp-pane button[data-action="${id}"]`);
    return b === null ? null : { label: b.textContent, disabled: b.getAttribute("aria-disabled") === "true" };
  }, id);
const clickPane = (id) => inA((_o, id) => document.querySelector(`.openlfcp-pane button[data-action="${id}"]`)?.click(), id);
const modalWith = (part) =>
  browser.waitUntil(
    () => inA((_o, part) => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent).find((t) => t.includes(part)) ?? false, part),
    { timeout: 60_000, timeoutMsg: `a dialog with "${part}"` },
  );
const clickIn = (part, label) =>
  inA(
    (_o, part, label) => {
      const m = [...document.querySelectorAll(".modal-container .modal")].find((x) => x.textContent.includes(part));
      const b = m && [...m.querySelectorAll("button")].find((x) => x.textContent === label);
      b?.click();
      return b !== undefined && b !== null;
    },
    part,
    label,
  );

/**
 * One pane draw caused by `kind` ("caret": the active editor's caret to
 * `arg`; "leaf": the tab of note `arg` made active): ms from the host event
 * to the end of the first draw after it, or null if none came in 5 s.
 */
const drawAfter = (kind, arg) =>
  inA(
    async ({ app, obsidian }, kind, arg) => {
      const view = app.workspace.getLeavesOfType("shared-tasks-pane")[0]?.view;
      if (view === undefined) return { ms: null, why: "no pane" };
      const d0 = view.drawings;
      let end = null;
      // The draw is synchronous inside render(): its end is the DOM committed.
      view.render = function () {
        Object.getPrototypeOf(this).render.call(this);
        if (end === null && this.drawings > d0) end = performance.now();
      };
      const t0 = performance.now();
      if (kind === "caret") app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: arg, ch: 0 });
      else {
        const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === arg);
        app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      let polled = null;
      for (let i = 0; i < 1000 && end === null; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (polled === null && view.drawings > d0) polled = performance.now();
      }
      delete view.render;
      // A draw outside render() (none today): the poll's time, 5 ms resolution.
      const at = end ?? polled;
      return { ms: at === null ? null : at - t0, drawings: view.drawings - d0, viaRender: end !== null };
    },
    kind,
    arg,
  );

/** The pane closed, then opened by its command: ms until its first draw is in the DOM. */
const paneOpen = (statusText = false) =>
  inA(
    async ({ app }, type, statusText) => {
      app.workspace.detachLeavesOfType(type);
      await new Promise((r) => setTimeout(r, 300));
      const done = () => {
        const v = app.workspace.getLeavesOfType(type)[0]?.view;
        const el = document.querySelector(".openlfcp-pane");
        if (v === undefined || el === null || !(v.drawings > 0) || el.childElementCount === 0) return false;
        // B4: a visible state of the section (loading, connecting, offline…).
        if (statusText) return document.querySelector(".openlfcp-pane .openlfcp-pane-fact") !== null;
        return true;
      };
      return new Promise((resolve) => {
        let t0 = 0;
        const finish = (ms) => {
          o.disconnect();
          clearTimeout(timer);
          const facts = [...document.querySelectorAll(".openlfcp-pane .openlfcp-pane-fact")].map((x) => x.textContent);
          resolve({ ms, facts });
        };
        const o = new MutationObserver(() => {
          if (done()) finish(performance.now() - t0);
        });
        o.observe(document.body, { childList: true, subtree: true, characterData: true });
        const timer = setTimeout(() => finish(null), 10_000);
        t0 = performance.now();
        app.commands.executeCommandById("shared-tasks:open-pane");
      });
    },
    VIEW,
    statusText,
  );

/** Shared Tasks disabled and enabled (a cold plugin), until its runtime is ready and its notes indexed. */
const reloadPlugin = () =>
  inA(async ({ app }, type) => {
    app.workspace.detachLeavesOfType(type);
    await app.plugins.disablePlugin("shared-tasks");
    const t0 = performance.now();
    await app.plugins.enablePlugin("shared-tasks");
    const p = app.plugins.plugins["shared-tasks"];
    await p.whenRuntimeStarted?.();
    for (let i = 0; i < 400 && p?.runtime?.status?.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    const readyMs = performance.now() - t0;
    // Its start-up pass over the notes (sections-host #startNotes) settles.
    await new Promise((r) => setTimeout(r, 1500));
    return { readyMs, status: p?.runtime?.status?.kind ?? null };
  }, VIEW);

/** Counters on the vault's reads and writes, and editor document changes (B5, B6). */
const countersOn = () =>
  inA(({ app }) => {
    const c = { reads: {}, writes: {}, editorChanges: 0, statusEvents: 0 };
    window.__lfcpCounters = c;
    const undo = [];
    const wrap = (obj, name, key, pathOf) => {
      const orig = obj[name];
      obj[name] = function (...a) {
        const p = pathOf(a[0]) ?? "?";
        c[key][p] = (c[key][p] ?? 0) + 1;
        return orig.apply(this, a);
      };
      undo.push(() => {
        obj[name] = orig;
      });
    };
    const file = (f) => f?.path;
    const plain = (p) => (typeof p === "string" ? p : undefined);
    wrap(app.vault, "read", "reads", file);
    wrap(app.vault, "cachedRead", "reads", file);
    wrap(app.vault.adapter, "read", "reads", plain);
    wrap(app.vault, "modify", "writes", file);
    wrap(app.vault, "process", "writes", file);
    wrap(app.vault.adapter, "write", "writes", plain);
    wrap(app.vault.adapter, "process", "writes", plain);
    wrap(app.vault.adapter, "append", "writes", plain);
    const ref = app.workspace.on("editor-change", () => c.editorChanges++);
    undo.push(() => app.workspace.offref(ref));
    const off = app.plugins.plugins["shared-tasks"].sections?.onStatusChange?.(() => c.statusEvents++);
    if (typeof off === "function") undo.push(off);
    window.__lfcpCountersOff = () => {
      for (const f of undo.reverse()) f();
    };
  });
const countersOff = () =>
  inA(() => {
    window.__lfcpCountersOff?.();
    const c = window.__lfcpCounters;
    window.__lfcpCounters = undefined;
    return c;
  });

describe("pane performance on P200 (LFCP-03-026, U03-22)", () => {
  let server;
  let lines;

  before(async () => {
    server = await restartableServer();
    const main = readFileSync(path.join(ROOT, "main.js"));
    results.meta = {
      date: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model ?? null, memGiB: Math.round(os.totalmem() / 2 ** 30) },
      obsidian: process.env.NATIVE_OBSIDIAN ?? null,
      commit: process.env.GITHUB_SHA ?? null,
      run: process.env.GITHUB_RUN_ID ?? null,
      mainJsSha256: createHash("sha256").update(main).digest("hex"),
      plugin: JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version,
      workload: "W200",
      privateNotes: PRIVATE_NOTES,
      warmup: WARMUP,
      samples: SAMPLES,
    };
  });

  after(async () => {
    await closeModals("perf").catch(() => undefined);
    await server?.stop();
    const dir = process.env.LFCP_PERF_DIR;
    if (dir !== undefined && dir !== "") {
      mkdirSync(dir, { recursive: true });
      const name = `pane-${process.platform}-${process.env.NATIVE_OBSIDIAN ?? "obsidian"}.json`;
      writeFileSync(path.join(dir, name), `${JSON.stringify(results, null, 2)}\n`);
    }
    evidence("PERF results", { meta: results.meta, metrics: Object.fromEntries(Object.entries(results.metrics).map(([k, v]) => [k, { ...v, samples: undefined }])), counters: results.counters });
  });

  it("builds P200: 300 private notes, W200 shared, a second projection", async function () {
    this.timeout(600_000);
    const w200 = workloadNote(WORKLOADS.W200);
    await inA(
      async ({ app }, url) => {
        const p = app.plugins.plugins["shared-tasks"];
        p.settings.defaultServer = url;
        await p.saveSettings();
      },
      server.url,
    );
    expect(await ready()).toBe("ready");
    const notes = [];
    for (let i = 0; i < PRIVATE_NOTES; i++) notes.push([`Private/Note ${String(i).padStart(3, "0")}.md`, privateNote(i)]);
    notes.push([MAIN, w200], [SECOND, ["# Second", "", "Private start text.", ""].join("\n")]);
    await inA(async ({ app }, notes) => {
      if (app.vault.getFolderByPath("Private") === null) await app.vault.createFolder("Private");
      for (const [file, text] of notes) await app.vault.create(file, text);
    }, notes);
    const heading = w200.split("\n").indexOf("## Workload");
    await openNote(MAIN, heading);
    // The pane, then "Share section…" from it.
    await paneOpen();
    await browser.waitUntil(async () => (await paneButton("share-section"))?.disabled === false, { timeout: 30_000, timeoutMsg: "Share section… in the pane" });
    const t0 = Date.now();
    await clickPane("share-section");
    await modalWith('Share section "Workload"');
    expect(await clickIn('Share section "Workload"', "Share")).toBe(true);
    await browser.waitUntil(async () => (await read(MAIN)).includes("<!-- /lfcp-section: "), { timeout: 300_000, interval: 500, timeoutMsg: "W200 shared" });
    const shareMs = Date.now() - t0;
    await closeModals("perf share");
    // The second projection: from the second note, Insert into a note… → Insert.
    await openNote(SECOND, 2);
    // The pane about the second note first (its context follows the active leaf), then its button.
    // (The card no longer names the note: the pane's root says which note it was drawn for, T1.)
    await browser.waitUntil(() => inA((_o, file) => document.querySelector(".openlfcp-pane")?.dataset.note === file, SECOND), {
      timeout: 30_000,
      timeoutMsg: "the pane drawn for the second note",
    });
    await browser.waitUntil(async () => (await paneButton("insert-into-note"))?.disabled === false, { timeout: 120_000, timeoutMsg: "Insert into a note… in the pane" });
    const insertAsked = () =>
      inA(() => {
        if ([...document.querySelectorAll(".modal-container .modal")].some((m) => m.textContent.includes('Insert section "Workload"'))) return "preview";
        return document.querySelector(".prompt .suggestion-item") === null ? false : "pick";
      });
    let asked = false;
    for (let i = 0; i < 3 && asked === false; i++) {
      await clickPane("insert-into-note");
      asked = await browser.waitUntil(insertAsked, { timeout: 20_000 }).catch(() => false);
      if (asked === false)
        evidence("PERF insert not asked", {
          attempt: i,
          button: await paneButton("insert-into-note"),
          modals: await inA(() => [...document.querySelectorAll(".modal-container .modal")].map((m) => m.textContent.slice(0, 300))),
          prompt: await inA(() => document.querySelector(".prompt")?.textContent?.slice(0, 300) ?? null),
          notices: await inA(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent)),
          pane: await inA(() => document.querySelector(".openlfcp-pane")?.textContent?.slice(0, 600) ?? null),
        });
    }
    expect(asked).not.toBe(false);
    if (asked === "pick") await inA(() => [...document.querySelectorAll(".prompt .suggestion-item")].find((x) => x.textContent.startsWith("Workload"))?.click());
    await modalWith('Insert section "Workload"');
    expect(await clickIn('Insert section "Workload"', "Insert")).toBe(true);
    await browser.waitUntil(async () => (await read(SECOND)).includes("<!-- /lfcp-section: "), { timeout: 120_000, interval: 500, timeoutMsg: "second projection" });
    await closeModals("perf insert");
    const md = await read(MAIN);
    lines = sectionLines(md);
    const second = sectionLines(await read(SECOND));
    results.meta.corpus = { mainBytes: md.length, mainLines: lines.lines, section: lines, secondSection: second, shareMs };
    evidence("PERF corpus", results.meta.corpus);
    expect(lines.start).toBeGreaterThan(0);
    expect(lines.end).toBeGreaterThan(lines.start);
    // Back on the main note, the pane open on it, settled.
    await openNote(MAIN, lines.start + 2);
    await browser.pause(3_000);
  });

  for (const tasks of [false, true]) {
    const tag = tasks ? "tasks-on" : "tasks-off";

    it(`B1 context update, B5 reads per caret event (${tag})`, async function () {
      this.timeout(600_000);
      const version = await inA(async ({ app }, on) => {
        if (on) await app.plugins.enablePlugin("obsidian-tasks-plugin");
        else await app.plugins.disablePlugin("obsidian-tasks-plugin");
        return on ? (app.plugins.plugins["obsidian-tasks-plugin"]?.manifest.version ?? null) : null;
      }, tasks);
      if (tasks) results.meta.tasks = version;
      await openNote(MAIN, lines.start + 2);
      await browser.pause(1_000);
      // Caret moves inside the section, spread over it, and out to the private text before it.
      const inside = (i) => lines.start + 2 + ((i * 37) % Math.max(1, lines.end - lines.start - 3));
      const caret = await series(async (i) => (await drawAfter("caret", inside(i))).ms);
      record(`B1-caret-in-section-${tag}`, caret, { budgetP95: 150 });
      const across = await series(async (i) => (await drawAfter("caret", i % 2 === 0 ? 0 : inside(i))).ms);
      record(`B1-caret-section-private-${tag}`, across, { budgetP95: 150 });
      // active-leaf-change between the two projections' notes.
      await openNote(SECOND, 2);
      await openNote(MAIN, lines.start + 2);
      const leaf = await series(async (i) => (await drawAfter("leaf", i % 2 === 0 ? SECOND : MAIN)).ms);
      record(`B1-active-leaf-${tag}`, leaf, { budgetP95: 150 });
      // B5: reads of other notes during 30 caret moves, after the warm-up above.
      await openNote(MAIN, lines.start + 2);
      await browser.pause(500);
      await countersOn();
      for (let i = 0; i < SAMPLES; i++) await drawAfter("caret", inside(i + 1));
      const c = await countersOff();
      const others = Object.entries(c.reads).filter(([p]) => p !== MAIN);
      results.counters[`B5-${tag}`] = { caretEvents: SAMPLES, reads: c.reads, otherNotesRead: others.reduce((n, [, k]) => n + k, 0), writes: c.writes, editorChanges: c.editorChanges };
      evidence(`PERF B5 ${tag}`, results.counters[`B5-${tag}`]);
      expect(caret.filter((x) => x === null)).toEqual([]);
    });
  }

  it("B6 no Markdown writes from status events (30 status passes, the server down and up)", async function () {
    this.timeout(300_000);
    await inA(({ app }) => app.plugins.disablePlugin("obsidian-tasks-plugin"));
    await openNote(MAIN, lines.start + 2);
    await browser.pause(2_000);
    const before = { main: await read(MAIN), second: await read(SECOND) };
    await countersOn();
    for (let i = 0; i < SAMPLES; i++) {
      await inA(({ app }) => app.plugins.plugins["shared-tasks"].sections?.scheduleStatus?.());
      if (i === 10) await server.down();
      if (i === 20) await server.up();
      await browser.pause(500);
    }
    await browser.pause(3_000);
    const c = await countersOff();
    const md = Object.entries(c.writes).filter(([p]) => p.endsWith(".md"));
    const after = { main: await read(MAIN), second: await read(SECOND) };
    results.counters.B6 = { statusPasses: SAMPLES, statusEvents: c.statusEvents, writes: c.writes, markdownWrites: md.reduce((n, [, k]) => n + k, 0), editorChanges: c.editorChanges, notesUnchanged: before.main === after.main && before.second === after.second };
    evidence("PERF B6", results.counters.B6);
  });

  it("B2 warm pane open", async function () {
    this.timeout(300_000);
    await openNote(MAIN, lines.start + 2);
    const warm = await series(async () => (await paneOpen()).ms);
    record("B2-warm-pane-open", warm, { budgetP95: 500 });
    expect(warm.filter((x) => x === null)).toEqual([]);
  });

  it("B3 cold pane open (the first after the plugin loads)", async function () {
    this.timeout(1_200_000);
    const starts = [];
    const cold = await series(async () => {
      const r = await reloadPlugin();
      starts.push(r.readyMs);
      await openNote(MAIN, lines.start + 2);
      return (await paneOpen()).ms;
    });
    record("B3-cold-pane-open", cold, { budgetP95: null, pluginReadyMs: stats(starts.slice(WARMUP)) });
  });

  it("B4 loading feedback: the pane opened right after a start with the server down", async function () {
    this.timeout(1_200_000);
    await server.down();
    const facts = [];
    const loading = await series(async () => {
      await reloadPlugin();
      await openNote(MAIN, lines.start + 2);
      const r = await paneOpen(true);
      facts.push(r.facts);
      return r.ms;
    });
    await server.up();
    record("B4-loading-feedback", loading, { budgetP95: 500, facts: facts.slice(-3) });
  });
});
