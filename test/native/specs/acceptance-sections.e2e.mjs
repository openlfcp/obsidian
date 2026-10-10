// LFCP-02-066 / LFCP-02-072: shared sections end to end, on production
// facts. Vault A is real Obsidian with the plugin; B is a headless peer, the
// same plugin core without Obsidian (test/native/peer); both talk to the
// reference server at LFCP_SERVER_BIN (server.lock). The run follows the
// two-vault demonstration (examples docs/demos/two-vault-sections.md,
// C00-C20) and records evidence per check. It does not replace a reviewer's
// run on two real Obsidian vaults.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { peer, restartableServer, waitFor } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const A_CANARY = `A_PRIVATE_${Date.now().toString(36)}`;
const B_CANARY = `B_PRIVATE_${Date.now().toString(36)}`;
const TASKS = 200;

/** Vault A's note: private text, a "## Launch" section of 200 Tasks with nested content, private text. */
function noteA() {
  const lines = [`${A_CANARY}: budget notes, private.`, "", "## Launch", ""];
  for (let i = 0; i < TASKS; i++) {
    lines.push(`- [ ] Task ${i + 1} of the launch${i % 10 === 0 ? " 📅 2026-11-20" : ""}`);
    if (i % 20 === 0) lines.push(`  Child paragraph ${i / 20 + 1} for this task.`);
    if (i % 5 === 0) lines.push(`  - item ${i / 5 + 1} under task ${i + 1}`);
  }
  lines.push("", "## Notes", "", `${A_CANARY}: follow-ups, private.`, "");
  return lines.join("\n");
}

let server;
let b;

/** Runs `fn` in Obsidian with the plugin and its runtime at hand. */
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);


/** In Obsidian: picks the suggestion whose text includes `label` in the open prompt; returns every suggestion's text. */
const choose = (label) =>
  inA(async ({}, label) => {
    let items = [];
    for (let i = 0; i < 100 && items.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      items = [...document.querySelectorAll(".prompt .suggestion-item")];
    }
    const texts = items.map((x) => x.textContent);
    const hit = items.find((x) => x.textContent.includes(label));
    if (hit === undefined) throw new Error(`no suggestion "${label}" in ${texts.join(" | ")}`);
    hit.click();
    return texts;
  }, label);

/** A's note text as the vault holds it. */
const noteOfA = (path) => inA(({ app }, path) => app.vault.adapter.read(path), path);


/** In Obsidian: answers the open text dialog titled `title` with `value` (null keeps its value), then OK. */
const answer = (title, value) =>
  inA(async ({}, title, value) => {
    let modal;
    for (let i = 0; i < 100 && modal === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      modal = [...document.querySelectorAll(".modal")].find((m) => m.querySelector("h3")?.textContent === title);
    }
    if (modal === undefined) throw new Error(`no dialog "${title}"`);
    const input = modal.querySelector("input");
    if (value !== null) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    [...modal.querySelectorAll("button")].find((b) => b.textContent === "OK").click();
  }, title, value);

/** In Obsidian: the plugin's notices shown since `after` (by text), newest last. */
const notices = () => inA(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent));

/** In Obsidian: opens `path` in the editor (creating it with `text` if missing), cursor on `line`. */
const openA = (path, text, line) =>
  inA(async ({ app, obsidian }, path, text, line) => {
    if (app.vault.getFileByPath(path) === null) await app.vault.create(path, text);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getFileByPath(path), { state: { mode: "source", source: true } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    for (let i = 0; i < 40 && view.file?.path !== path; i++) await new Promise((r) => setTimeout(r, 50));
    view.editor.setCursor({ line, ch: 0 });
  }, path, text, line);

describe("shared sections end to end: Obsidian A, headless B, real server (LFCP-02-066/072)", () => {
  before(async () => {
    server = await restartableServer();
    b = await peer(server.url);
    await inA(async ({ app }, url) => {
      const plugin = app.plugins.plugins["shared-tasks"];
      plugin.settings.defaultServer = url;
      plugin.settings.sectionsDisabled = false;
      await plugin.saveData(plugin.settings);
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const p = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && p.runtime?.status.kind !== "ready"; i++)
        await new Promise((r) => setTimeout(r, 50));
    }, server.url);
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it("C01 independent identities", async () => {
    const a = await inA(({ app }) => app.plugins.plugins["shared-tasks"].runtime.status.principalId);
    const aHex = Buffer.from(Object.values(a)).toString("hex");
    const bHex = Buffer.from(b.principal).toString("hex");
    evidence("C01", { a: aHex.slice(0, 16), b: bHex.slice(0, 16) });
    expect(aHex).not.toBe(bHex);
  });

  it("C02-C03 share preview, then shared and hosted", async () => {
    const shown = await inA(
      async ({ app, obsidian }, text) => {
        await app.vault.create("Launch plan.md", text);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(app.vault.getFileByPath("Launch plan.md"), { state: { mode: "source", source: true } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
        view.editor.setCursor({ line: 2, ch: 0 });
        app.commands.executeCommandById("shared-tasks:share-section");
        let modal = null;
        for (let i = 0; i < 80 && modal === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
          modal = document.querySelector(".modal-container .modal");
        }
        const content = modal.querySelector(".openlfcp-share-content")?.textContent ?? "";
        const summary = modal.textContent;
        [...modal.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
        return { summary: summary.slice(0, 600), content };
      },
      noteA(),
    );
    evidence("C02", { summary: shown.summary, canaryInContent: shown.content.includes(A_CANARY) });
    expect(shown.content).not.toContain(A_CANARY);
    expect(shown.summary).toMatch(/200 tasks/);
    const hosted = await browser.waitUntil(
      () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          const text = await app.vault.adapter.read("Launch plan.md");
          if (!text.includes("<!-- /lfcp-section: ")) return false;
          const entry = (await p.runtime.registry()).find((e) => e.profile.includes("section"));
          if (entry === undefined) return false;
          const hosting = await p.runtime.localState.get(`collab-hosting:${Buffer.from(entry.resourceId).toString("hex")}`);
          return hosting === "hosted" ? { R: Buffer.from(entry.resourceId).toString("hex"), state: entry.state } : false;
        }),
      { timeout: 60_000, timeoutMsg: "the section shared and hosted" },
    );
    evidence("C03", hosted);
    expect(hosted.R).toHaveLength(64);
  });

  let link;
  it("C04 invitation: read + write, the link hidden until Show link, the section's wording", async () => {
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:invite-collaborator"));
    const collaborations = await choose("Launch");
    const presets = await choose("Read + write");
    const shown = await inA(async () => {
      let modal = null;
      for (let i = 0; i < 200 && modal === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = [...document.querySelectorAll(".modal-container .modal")].find((m) => m.textContent.includes("Invitation ("));
      }
      if (modal === undefined)
        throw new Error(`no invitation dialog; notices: ${[...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | ")}`);
      const input = modal.querySelector("input");
      const before = { type: input.type, value: input.value };
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const after = input.value;
      const text = modal.textContent;
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return { before, after, confirmed: text.includes("the link works now") };
    });
    link = shown.after;
    evidence("C04", { collaborations, presets, before: shown.before, confirmed: shown.confirmed, linkShape: link.replace(/#secret=.*/, "#secret=…") });
    expect(shown.before).toEqual({ type: "password", value: "" });
    expect(link.startsWith("lfcp://join/")).toBe(true);
    expect(shown.confirmed).toBe(true);
    expect(presets.join(" ")).toMatch(/shared section/);
  });

  let joined;
  it("C05-C06 B joins and inserts the section after its paragraph; its private text untouched", async () => {
    const before = [`# B's notes`, "", `${B_CANARY}: B's own thoughts.`, "", "Insert below this paragraph.", "", `${B_CANARY}: more of B's own.`, ""].join("\n");
    b.files.set("Private B.md", before);
    joined = await b.joinAndInsert(link, "Private B.md", 4);
    const after = b.files.get("Private B.md");
    const at = after.indexOf("Insert below this paragraph.");
    const section = after.indexOf("## Launch");
    evidence("C05-C06", { inserted: section > at, tasks: (after.match(/- \[ \] Task /g) ?? []).length, bPrivateKept: after.includes(`${B_CANARY}: B's own thoughts.`) && after.includes(`${B_CANARY}: more of B's own.`) });
    expect(section).toBeGreaterThan(at);
    expect((after.match(/- \[ \] Task /g) ?? []).length).toBe(TASKS);
    expect(after).toContain(`${B_CANARY}: more of B's own.`);
  });

  it("C07 edits both ways: A checks a Task in Obsidian, B edits a paragraph", async () => {
    // A, in the editor: check Task 3.
    await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("- [ ] Task 3 of the launch"));
      view.editor.setLine(line, view.editor.getLine(line).replace("- [ ]", "- [x]"));
    });
    const seenByB = await waitFor(async () => {
      const { text } = await b.pass("Private B.md");
      return text.includes("- [x] Task 3 of the launch") ? true : undefined;
    }, 30_000);
    // B: edit Child paragraph 1's text.
    const md = b.files.get("Private B.md");
    b.files.set("Private B.md", md.replace("Child paragraph 1 for this task.", "Child paragraph 1, edited by B."));
    const { pass } = await b.pass("Private B.md");
    const seenByA = await browser.waitUntil(
      async () => (await noteOfA("Launch plan.md")).includes("Child paragraph 1, edited by B."),
      { timeout: 30_000, timeoutMsg: "B's edit in A's note" },
    );
    evidence("C07", { seenByB, bCommitted: pass.sections[0]?.local?.kind, seenByA });
    expect(seenByA).toBe(true);
  });

  /** A's badge after the section heading: its state, label and tooltip. */
  const badgeOfA = () =>
    inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 0, ch: 0 });
      view.editor.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 300));
      const el = view.containerEl.querySelector(".openlfcp-status");
      return el === null ? null : { state: el.dataset.state, label: el.getAttribute("aria-label"), tooltip: el.dataset.tooltip };
    });

  it("C08-C09 offline queue, then a restart with pending work; sent when the server returns", async () => {
    await server.down();
    const offline = await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        return s?.state === "OFFLINE" ? s : false;
      },
      { timeout: 30_000, timeoutMsg: "A's badge offline" },
    );
    await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("- [ ] Task 7 of the launch"));
      view.editor.setLine(line, view.editor.getLine(line).replace("- [ ]", "- [x]"));
    });
    const pendingBefore = await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        return s !== null && /waiting|pending/i.test(`${s.label} ${s.tooltip}`) ? s : false;
      },
      { timeout: 20_000, timeoutMsg: "A's edit saved and waiting" },
    );
    // What the badge stands on, and where the edit is, before the restart.
    const facts = () =>
      inA(async ({ app, obsidian }) => {
        const p = app.plugins.plugins["shared-tasks"];
        const entry = (await p.runtime.registry()).find((e) => e.profile.includes("section"));
        const R = entry.resourceId;
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        return {
          phase: p.runtime.phase(R),
          outbound: (await p.runtime.storage.outbound.list(R)).length,
          editorHasEdit: view.editor.getValue().includes("- [x] Task 7 of the launch"),
          fileHasEdit: (await app.vault.adapter.read("Launch plan.md")).includes("- [x] Task 7 of the launch"),
        };
      });
    const beforeRestart = await facts();
    // Restart the plugin while the edit waits; ask for the status snapshot as the host does at its start.
    const early = await inA(async ({ app }) => {
      await app.plugins.disablePlugin("shared-tasks");
      await app.plugins.enablePlugin("shared-tasks");
      const p = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && p.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
      const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
      const tries = [];
      for (let i = 0; i < 3; i++) {
        const out = await Promise.race([
          p.runtime.sectionStatusSnapshot(R).then(
            (s) => `ok ${s.batches.map((b) => b.status).join(",")}`,
            (e) => `error ${String(e?.message ?? e).slice(0, 200)}`,
          ),
          new Promise((r) => setTimeout(() => r("no answer in 3 s"), 3000)),
        ]);
        tries.push(out);
      }
      return tries;
    });
    evidence("C09-early-snapshot", { early });
    // For sdk-ts (24): identifiers only.
    const dump = await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
      const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      const snap = await p.runtime.sectionStatusSnapshot(R);
      const batches = snap.batches.map((b) => ({
        operationId: b.operationId,
        status: b.status,
        unitIds: (b.unitIds ?? []).map((u) => (typeof u === "string" ? u : hex(u)).slice(0, 16)),
        acceptedUnitIds: (b.acceptedUnitIds ?? []).map((u) => (typeof u === "string" ? u : hex(u)).slice(0, 16)),
      }));
      const outbound = (await p.runtime.storage.outbound.list(R)).map((i) => ({ kind: i.kind, id: hex(i.itemId).slice(0, 16), attempts: i.attempts }));
      const inBatch = outbound.map((o) => batches.some((b) => b.unitIds.includes(o.id)));
      return { batches, outbound, inBatch };
    });
    evidence("C09-sdk-dump", dump);
    const seen = [];
    let afterRestart = null;
    for (let i = 0; i < 30 && afterRestart === null; i++) {
      const s = await badgeOfA();
      seen.push(s?.state ?? null);
      if (s !== null && s.state !== "LOADING") afterRestart = s;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    evidence("C09-after-restart", { seen, afterRestart, facts: await facts(), snapshot: await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
      const started = Date.now();
      const out = await Promise.race([
        p.runtime.sectionStatusSnapshot(R).then(
          (s) => ({ ok: true, batches: s.batches.map((b) => b.status), section: s.section, catchUp: s.catchUp.state }),
          (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) }),
        ),
        new Promise((r) => setTimeout(() => r({ ok: false, error: "no answer in 5 s" }), 5000)),
      ]);
      const profile = p.runtime.sectionProfile(R);
      const doc = profile?.replica.toJSON();
      return {
        ...out,
        ms: Date.now() - started,
        load: p.runtime.sectionLoad(R) ?? null,
        sectionId: doc?.section?.id ?? null,
        nodes: Object.keys(profile?.replica.snapshot().nodes ?? {}).length,
        notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 160)),
      };
    }) });
    if (afterRestart === null) throw new Error(`A's badge after the restart: ${seen.join(",")}`);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push({ ...(await facts()), badge: (await badgeOfA())?.state });
      await new Promise((r) => setTimeout(r, 1000));
    }
    evidence("C09-facts", { beforeRestart, samples });
    const kept = samples.at(-1).editorHasEdit;
    await server.up();
    const seenByB = await waitFor(async () => {
      const { text } = await b.pass("Private B.md");
      return text.includes("- [x] Task 7 of the launch") ? true : undefined;
    }, 60_000);
    const current = await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        return s?.state === "CURRENT" ? s : false;
      },
      { timeout: 60_000, timeoutMsg: "A's badge current again" },
    );
    evidence("C08-C09", { offline, pendingBefore, afterRestart, kept, seenByB, current });
    expect(kept).toBe(true);
    // SI03 and the §5 decision: offline with the saved, pending work; never accepted.
    expect(afterRestart.state).toBe("OFFLINE");
    expect(`${afterRestart.label}`).toMatch(/pending|waiting/);
    expect(seenByB).toBe(true);
  });

  it("C10-C11 a conflict on both sides, found by command, resolved once by choice", async () => {
    await server.down();
    await browser.waitUntil(async () => (await badgeOfA())?.state === "OFFLINE", { timeout: 30_000, timeoutMsg: "A offline" });
    // A and B rename Task 9, each their own way, while neither can send.
    await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").findIndex((l) => l.startsWith("- [ ] Task 9 of the launch"));
      view.editor.setLine(line, view.editor.getLine(line).replace("Task 9 of the launch", "Task 9 renamed by A"));
    });
    b.files.set("Private B.md", b.files.get("Private B.md").replace("Task 9 of the launch", "Task 9 renamed by B"));
    await b.pass("Private B.md");
    await new Promise((r) => setTimeout(r, 2500));
    await server.up();
    let attention = null;
    for (let i = 0; i < 40 && attention === null; i++) {
      const st = await badgeOfA();
      if (st?.state === "ATTENTION") attention = st;
      else await new Promise((r) => setTimeout(r, 1500));
    }
    if (attention === null) {
      const facts = await inA(async ({ app }) => {
        const p = app.plugins.plugins["shared-tasks"];
        const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
        const replica = p.runtime.sectionProfile(R).replica;
        const snap = replica.snapshot();
        const task9 = Object.entries(snap.nodes).find(([, n]) => n.kind === "task" && (replica.task(n.taskId ?? "")?.task?.title ?? "").includes("Task 9"));
        const view = task9 === undefined ? null : replica.task(task9[1].taskId);
        return {
          problems: snap.problems,
          title: view?.task?.title ?? null,
          titleConflicted: view?.fields?.title?.conflicted ?? null,
          titleValues: view?.fields?.title?.values ?? view?.fields?.title?.value ?? null,
          line: (await app.vault.adapter.read("Launch plan.md")).split("\n").find((l) => l.includes("Task 9")) ?? null,
        };
      });
      const bView = await (async () => {
        const snap = b.port.snapshot(b.b64(joined.resource), joined.sectionId);
        return { problems: snap?.problems ?? null, line: b.files.get("Private B.md").split("\n").find((l) => l.includes("Task 9")) ?? null };
      })();
      evidence("C10-no-attention", { badge: await badgeOfA(), facts, bView });
      throw new Error("A's badge needs attention");
    }
    let bConflicted;
    try {
      bConflicted = await waitFor(async () => {
        const snap = b.port.snapshot(b.b64(joined.resource), joined.sectionId);
        return (snap?.problems ?? []).length > 0 ? snap.problems.map((p) => p.code) : undefined;
      }, 60_000);
    } catch {
      const aQueue = await inA(async ({ app }) => {
        const p = app.plugins.plugins["shared-tasks"];
        const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
        const hex = (x) => Array.from(x, (v) => v.toString(16).padStart(2, "0")).join("");
        return {
          phase: p.runtime.phase(R),
          outbound: (await p.runtime.storage.outbound.list(R)).map((i) => ({
            kind: i.kind,
            id: hex(i.itemId).slice(0, 12),
            attempts: i.attempts,
            lastAttempt: i.lastAttempt,
            nextAttempt: i.nextAttempt,
            blocked: i.blockedReason ?? i.blocked ?? null,
          })),
          refusal: (await p.runtime.registry()).find((e) => e.profile.includes("section")).refusal,
        };
      });
      const bR = joined.resource;
      evidence("C10-not-delivered", {
        aQueue,
        bPhase: b.runtime.phase(bR),
        bOutbound: (await b.runtime.storage.outbound.list(bR)).length,
        now: new Date().toISOString(),
      });
      throw new Error("B never saw the conflict: A's edit not delivered");
    }
    // The next problem, by command.
    const found = await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.editor.setCursor({ line: 0, ch: 0 });
      app.commands.executeCommandById("shared-tasks:next-section-problem");
      await new Promise((r) => setTimeout(r, 500));
      return {
        line: view.editor.getLine(view.editor.getCursor().line),
        said: document.querySelector(".openlfcp-live-region")?.textContent ?? "",
      };
    });
    // Resolve from the card: Review conflicts…, the B title, Apply.
    const resolved = await inA(async ({ app }) => {
      app.commands.executeCommandById("shared-tasks:open-section-details");
      const find = async (pred) => {
        for (let i = 0; i < 100; i++) {
          const hit = pred();
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      };
      const review = await find(() => [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Review conflicts…"));
      if (review === null) return { error: "no Review conflicts… in the card" };
      review.click();
      const choice = await find(() => [...document.querySelectorAll(".openlfcp-recovery-choice")].find((l) => l.textContent.includes("renamed by B")));
      if (choice === null) return { error: `no B choice: ${[...document.querySelectorAll(".openlfcp-recovery-choice")].map((l) => l.textContent).join(" | ")}` };
      const choices = [...document.querySelectorAll(".openlfcp-recovery-choice")].map((l) => l.textContent.trim());
      choice.querySelector("input").click();
      choice.closest(".openlfcp-recovery-item").querySelector("button").click();
      const done = await find(() => document.querySelector(".openlfcp-recovery")?.textContent.includes("Nothing needs a choice now") ?? false);
      document.querySelector(".openlfcp-recovery .modal-close-button")?.click();
      return { choices, done };
    });
    const once = (text) => (text.match(/Task 9 renamed by/g) ?? []).length;
    const aText = await browser.waitUntil(
      async () => {
        const t = await noteOfA("Launch plan.md");
        return t.includes("Task 9 renamed by B") && once(t) === 1 ? t : false;
      },
      { timeout: 60_000, timeoutMsg: "A shows the chosen title once" },
    );
    const bText = await waitFor(async () => {
      const { text } = await b.pass("Private B.md");
      return text.includes("Task 9 renamed by B") && once(text) === 1 ? text : undefined;
    }, 60_000);
    const settled = await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        return s?.state === "CURRENT" ? s : false;
      },
      { timeout: 60_000, timeoutMsg: "A current after the choice" },
    );
    evidence("C10-C11", { attention, bConflicted, found, resolved, aOnce: once(aText), bOnce: once(bText), settled: settled.state });
    expect(found.line).toMatch(/Task 9 renamed by/);
    expect(found.said).toMatch(/^Problem 1 of /);
    expect(resolved.done).toBe(true);
  });

  it("C12-C13 readable copy has no binding; Copy shared section says it gives nobody access", async () => {
    const lineOf = async (prefix) =>
      (await noteOfA("Launch plan.md")).split("\n").findIndex((l) => l.startsWith(prefix));
    await openA("Launch plan.md", "", await lineOf("- [ ] Task 2 of the launch"));
    const out = await inA(async ({ app }) => {
      const { clipboard } = require("electron");
      clipboard.clear();
      app.commands.executeCommandById("shared-tasks:copy-readable-text");
      await new Promise((r) => setTimeout(r, 400));
      const readable = clipboard.readText();
      clipboard.clear();
      app.commands.executeCommandById("shared-tasks:copy-shared-section");
      await new Promise((r) => setTimeout(r, 400));
      return { readable, shared: clipboard.readText(), notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent) };
    });
    evidence("C12-C13", {
      readableHasBinding: out.readable.includes("lfcp-"),
      readableLines: out.readable.split("\n").length,
      sharedHasBindings: out.shared.includes("lfcp-section:"),
      notice: out.notices.find((n) => n.includes("gives nobody access")) ?? null,
    });
    expect(out.readable).not.toContain("lfcp-");
    expect(out.readable).toContain("Task 2 of the launch");
    expect(out.shared.startsWith("## Launch\n<!-- lfcp-section: ")).toBe(true);
    expect(out.notices.some((n) => n.includes("gives nobody access"))).toBe(true);
  });

  it("C14 detach the second copy in A: text kept there, the first copy and B go on", async () => {
    // At the start: does B's edit reach A at all after C10-C13?
    b.files.set("Private B.md", b.files.get("Private B.md").replace("Task 14 of the launch", "Task 14 edited at C14 start"));
    const startB = await b.pass("Private B.md");
    let startGot = false;
    for (let i = 0; i < 30 && !startGot; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      startGot = (await noteOfA("Launch plan.md")).includes("Task 14 edited at C14 start");
    }
    // Where it stops: in A's model (not received) or between the model and the note (not projected)?
    const aModel = await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
      const replica = p.runtime.sectionProfile(R)?.replica;
      const json = JSON.stringify(replica?.toJSON() ?? null);
      const snap = await p.runtime.sectionStatusSnapshot(R).catch((e) => ({ error: String(e?.message ?? e) }));
      return {
        phase: p.runtime.phase(R),
        hasB14: json.includes("Task 14 edited at C14 start"),
        hasB2: json.includes("edited by B") || json.includes("renamed by B"),
        catchUp: snap.catchUp ?? null,
        needsSnapshot: snap.needsSnapshot ?? null,
        revision: snap.revision ?? null,
        batches: (snap.batches ?? []).map((x) => x.status),
        error: snap.error ?? null,
        outbound: (await p.runtime.storage.outbound.list(R)).length,
      };
    });
    const bModel = JSON.stringify(b.runtime.sectionProfile(joined.resource)?.replica.toJSON() ?? null).includes("Task 14 edited at C14 start");
    // B's side: "committed" is durable on B, not accepted by the server.
    const bSnap = await b.runtime.sectionStatusSnapshot(joined.resource).catch((e) => ({ error: String(e?.message ?? e) }));
    const bSide = {
      phase: b.runtime.phase(joined.resource),
      outbound: (await b.runtime.storage.outbound.list(joined.resource)).length,
      batches: (bSnap.batches ?? []).map((x) => x.status),
      catchUp: bSnap.catchUp ?? null,
      error: bSnap.error ?? null,
      held: b.runtime.sectionProfile(joined.resource)?.heldUnits().length ?? null,
    };
    const aHeld = await inA(async ({ app }) => {
      const p = app.plugins.plugins["shared-tasks"];
      const R = (await p.runtime.registry()).find((e) => e.profile.includes("section")).resourceId;
      return { held: p.runtime.sectionProfile(R)?.heldUnits().length ?? null, load: p.runtime.sectionLoad(R) ?? null };
    });
    evidence("C14-start-model", { aModel, aHeld, bModel, bSide });
    evidence("C14-start", {
      bCommitted: startB.pass.sections.map((x) => x.local?.kind ?? null),
      bResource: b.b64(joined.resource),
      aGot: startGot,
      badge: await badgeOfA(),
      active: await inA(({ app }) => app.workspace.getActiveFile()?.path ?? null),
    });
    // A second copy of the section in another note of A.
    await openA("Second copy.md", ["# Elsewhere", "", "Paragraph before the copy.", ""].join("\n"), 2);
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:insert-section"));
    await choose("Launch");
    await inA(async () => {
      let b;
      for (let i = 0; i < 200 && b === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        b = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Insert");
      }
      b.click();
    });
    await browser.waitUntil(async () => (await noteOfA("Second copy.md")).includes("<!-- /lfcp-section: "), {
      timeout: 30_000,
      timeoutMsg: "the second copy inserted",
    });
    // Before the detach: does B's edit still reach A with two copies?
    b.files.set("Private B.md", b.files.get("Private B.md").replace("Task 13 of the launch", "Task 13 edited before the detach"));
    const preB = await b.pass("Private B.md");
    let pre = false;
    for (let i = 0; i < 30 && !pre; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      pre = (await noteOfA("Launch plan.md")).includes("Task 13 edited before the detach");
    }
    // Both copies get it: the open one and the closed one (each its own pass).
    const t0 = Date.now();
    let secondGot = false;
    for (let i = 0; i < 20 && !secondGot; i++) {
      secondGot = (await noteOfA("Second copy.md")).includes("Task 13 edited before the detach");
      if (!secondGot) await new Promise((r) => setTimeout(r, 500));
    }
    evidence("C14-before-detach", {
      bCommitted: preB.pass.sections.map((x) => x.local?.kind ?? null),
      firstGot: pre,
      secondGot,
      secondAfterFirstMs: Date.now() - t0,
      active: await inA(({ app }) => app.workspace.getActiveFile()?.path ?? null),
    });
    expect(pre).toBe(true);
    expect(secondGot).toBe(true);
    await openA("Second copy.md", "", 5);
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:detach-section"));
    await inA(async () => {
      let b;
      for (let i = 0; i < 100 && b === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        b = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Detach");
      }
      b.click();
    });
    const second = await browser.waitUntil(
      async () => {
        const t = await noteOfA("Second copy.md");
        return !t.includes("lfcp-") ? t : false;
      },
      { timeout: 20_000, timeoutMsg: "the second copy detached" },
    );
    const notice = (await notices()).find((n) => n.includes("is no longer shared in this note")) ?? null;
    // The first copy still syncs: B edits, A's first note gets it; the detached copy does not.
    b.files.set("Private B.md", b.files.get("Private B.md").replace("Task 11 of the launch", "Task 11 edited after the detach"));
    const bPass = await b.pass("Private B.md");
    const first = await browser
      .waitUntil(
        async () => ((await noteOfA("Launch plan.md")).includes("Task 11 edited after the detach") ? true : false),
        { timeout: 30_000, timeoutMsg: "the first copy still syncs" },
      )
      .catch(async (e) => {
        const t = await noteOfA("Launch plan.md");
        evidence("C14-not-synced", {
          bLine: b.files.get("Private B.md").split("\n").find((l) => l.includes("Task 11")) ?? null,
          aLine: t.split("\n").find((l) => l.includes("Task 11")) ?? null,
          aHasSection: t.includes("<!-- /lfcp-section: "),
          badge: await badgeOfA(),
          notices: await notices(),
          bCommitted: bPass.pass.sections.map((x) => x.local?.kind ?? null),
        });
        // Open the first note: does an open note get it, where a closed one did not?
        await openA("Launch plan.md", "", 2);
        await new Promise((r) => setTimeout(r, 10_000));
        evidence("C14-after-open", {
          aLine: (await noteOfA("Launch plan.md")).split("\n").find((l) => l.includes("Task 11")) ?? null,
          badge: await badgeOfA(),
        });
        throw e;
      });
    const detachedUntouched = !(await noteOfA("Second copy.md")).includes("Task 11 edited after the detach");
    evidence("C14", { notice, secondKeepsText: second.includes("Task 1 of the launch"), first, detachedUntouched });
    expect(second).toContain("Task 1 of the launch");
    expect(notice).toMatch(/The shared section itself is unchanged/);
    expect(detachedUntouched).toBe(true);
  });

  it("C15 a 0.1 Task beside the section is shared; inside the section it is refused", async () => {
    // A 0.1 collaboration on the same server.
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:create-collaboration"));
    await answer("Create collaboration", "Team tasks");
    await answer("Sync server", null);
    await browser.waitUntil(async () => (await notices()).some((n) => n.includes('"Team tasks" created')), {
      timeout: 30_000,
      timeoutMsg: "the 0.1 collaboration created",
    });
    const note = (await noteOfA("Launch plan.md")).replace(`${A_CANARY}: follow-ups, private.`, `${A_CANARY}: follow-ups, private.\n- [ ] A legacy task beside the section`);
    await inA(async ({ app }, text) => {
      await app.vault.adapter.write("Launch plan.md", text);
    }, note);
    await browser.waitUntil(async () => (await noteOfA("Launch plan.md")).includes("A legacy task beside"), { timeout: 10_000 });
    const lines = (await noteOfA("Launch plan.md")).split("\n");
    await openA("Launch plan.md", "", lines.findIndex((l) => l.includes("A legacy task beside")));
    const shown = (await notices()).length;
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:share-task-under-cursor"));
    await choose("Team tasks").catch(async (e) => {
      const t = (await noteOfA("Launch plan.md")).split("\n");
      evidence("C15-no-picker", {
        notices: (await notices()).slice(shown),
        line: t.find((x) => x.includes("A legacy task beside")) ?? null,
        cursor: await inA(({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getCursor()),
      });
      throw e;
    });
    const legacy = await browser.waitUntil(
      async () => {
        const l = (await noteOfA("Launch plan.md")).split("\n");
        const at = l.findIndex((x) => x.includes("A legacy task beside"));
        return `${l[at]}\n${l[at + 1] ?? ""}`.includes("lfcp-ref:") ? true : false;
      },
      { timeout: 30_000, timeoutMsg: "the legacy task shared" },
    );
    const inside = (await noteOfA("Launch plan.md")).split("\n").findIndex((l) => l.startsWith("- [ ] Task 4 of the launch"));
    await openA("Launch plan.md", "", inside);
    const before = (await notices()).length;
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:share-task-under-cursor"));
    await new Promise((r) => setTimeout(r, 1000));
    const refused = (await notices()).slice(before);
    evidence("C15", { legacy, refused });
    expect(legacy).toBe(true);
    expect(refused.join(" ")).toMatch(/section/i);
  });

  it("C16 remove B's access from the card: pending, then done; A gets none of B's later edits", async () => {
    await openA("Launch plan.md", "", 2);
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:open-section-details"));
    const removing = await inA(async () => {
      let row;
      for (let i = 0; i < 200 && row === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access…");
      }
      if (row === undefined) return { error: [...document.querySelectorAll(".modal")].map((m) => m.textContent).join(" | ").slice(0, 600) };
      const label = row.getAttribute("aria-label");
      row.click();
      let confirm;
      for (let i = 0; i < 100 && confirm === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        confirm = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access");
      }
      const question = confirm.closest(".modal").textContent;
      confirm.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { label, question, notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent) };
    });
    if (removing.error !== undefined) throw new Error(`no Remove access…: ${removing.error}`);
    const bAccess = await waitFor(async () => {
      const a = await b.runtime.canWriteSection(joined.resource).catch(() => undefined);
      return a !== undefined && a.allowed === false ? a.reason : undefined;
    }, 60_000);
    b.files.set("Private B.md", b.files.get("Private B.md").replace("Task 12 of the launch", "Task 12 edited after removal"));
    const after = await b.pass("Private B.md");
    await new Promise((r) => setTimeout(r, 5000));
    const aGot = (await noteOfA("Launch plan.md")).includes("Task 12 edited after removal");
    evidence("C16", { label: removing.label, question: removing.question.slice(0, 200), notice: removing.notices.find((n) => n.includes("waiting for the server")) ?? removing.notices.at(-1), bAccess, bKept: after.pass.sections[0]?.local?.kind, aGot });
    expect(removing.question).toContain("Copies already received cannot be erased");
    expect(bAccess).toMatch(/revoked|not-member|server-refused/);
    expect(aGot).toBe(false);
  });

  it("C17-C18 a deleted end marker: attention with the copy named in the card; Repair puts it back", async () => {
    const text = await noteOfA("Launch plan.md");
    const end = text.split("\n").find((l) => l.startsWith("<!-- /lfcp-section: "));
    await inA(async ({ app, obsidian }, end) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const line = view.editor.getValue().split("\n").indexOf(end);
      view.editor.replaceRange("", { line, ch: 0 }, { line: line + 1, ch: 0 });
    }, end);
    const problem = await browser
      .waitUntil(
        async () => {
          const s = await badgeOfA();
          return s?.state === "ATTENTION" ? s : false;
        },
        { timeout: 30_000, timeoutMsg: "attention after the end marker went" },
      )
      .catch(async (e) => {
        const t = await noteOfA("Launch plan.md");
        evidence("C17-no-attention", {
          endFound: end !== undefined,
          endGone: !t.includes("<!-- /lfcp-section: "),
          startKept: t.includes("<!-- lfcp-section: "),
          badge: await badgeOfA(),
          active: await inA(({ app }) => app.workspace.getActiveFile()?.path ?? null),
          notices: await notices(),
        });
        throw e;
      });
    // The damaged copy has no parsed section under the cursor: its badge opens the card.
    const card = await inA(async () => {
      document.querySelector(".openlfcp-status")?.click();
      let m;
      for (let i = 0; i < 100 && m === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        m = [...document.querySelectorAll(".modal")].find((x) => x.classList.contains("openlfcp-section-card"));
      }
      const t = m?.textContent ?? "";
      m?.querySelector(".modal-close-button")?.click();
      return t;
    });
    const copyLine = (card.match(/One copy of this section[^.]*\./) ?? [null])[0];
    await inA(({ app }) => app.commands.executeCommandById("shared-tasks:repair-shared-sections"));
    const repaired = await inA(async () => {
      let m;
      for (let i = 0; i < 100 && m === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        m = document.querySelector(".modal.openlfcp-repair");
      }
      const offered = [...m.querySelectorAll(".openlfcp-repair-choice")].map((l) => l.textContent.trim());
      m.querySelector(".openlfcp-repair-choice input").click();
      [...m.querySelectorAll("button")].find((b) => b.textContent === "Apply").click();
      return { offered: offered.slice(0, 3), count: offered.length };
    });
    const back = await browser.waitUntil(async () => ((await noteOfA("Launch plan.md")).includes("<!-- /lfcp-section: ") ? true : false), {
      timeout: 20_000,
      timeoutMsg: "the end marker back",
    });
    const clear = await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        return s !== null && s.state !== "ATTENTION" ? s : false;
      },
      { timeout: 30_000, timeoutMsg: "attention cleared after the repair" },
    );
    evidence("C17-C18", { problem: problem.state, copyLine, repaired, back, after: clear.state });
    expect(copyLine).not.toBeNull();
    expect(back).toBe(true);
  });

  it("SI20 status-only changes leave the note's bytes and undo history unchanged", async () => {
    const take = () =>
      inA(async ({ app, obsidian }) => {
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        // CodeMirror's history state: the field value holding the done/undone stacks.
        const history = view.editor.cm.state.values.find(
          (v) => v !== null && typeof v === "object" && Array.isArray(v.done) && Array.isArray(v.undone),
        );
        return {
          path: view.file?.path ?? null,
          text: view.editor.getValue(),
          file: await app.vault.adapter.read(view.file.path),
          done: history?.done.length ?? null,
          undone: history?.undone.length ?? null,
        };
      });
    await openA("Launch plan.md", "", 2);
    await browser.waitUntil(async () => (await badgeOfA())?.state === "CURRENT", { timeout: 30_000, timeoutMsg: "A current first" });
    const before = await take();
    const states = [];
    await server.down();
    await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        if (s !== null && states.at(-1) !== s.state) states.push(s.state);
        return s?.state === "OFFLINE";
      },
      { timeout: 30_000, timeoutMsg: "A offline" },
    );
    await server.up();
    await browser.waitUntil(
      async () => {
        const s = await badgeOfA();
        if (s !== null && states.at(-1) !== s.state) states.push(s.state);
        return s?.state === "CURRENT";
      },
      { timeout: 60_000, timeoutMsg: "A current again" },
    );
    const after = await take();
    evidence("SI20", {
      states,
      sameText: after.text === before.text,
      sameFile: after.file === before.file,
      history: { before: [before.done, before.undone], after: [after.done, after.undone] },
    });
    expect(after.path).toBe(before.path);
    expect(after.text).toBe(before.text);
    expect(after.file).toBe(before.file);
    if (before.done !== null) expect([after.done, after.undone]).toEqual([before.done, before.undone]);
  });

  it("C19-C20 the server holds no canary, title or text; neither vault holds the other's private text", async () => {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) walk(join(d, e.name));
        else files.push(join(d, e.name));
    };
    walk(join(server.dir, "state"));
    const needles = [A_CANARY, B_CANARY, "Task 1 of the launch", "Child paragraph", "renamed by"];
    const found = needles.filter((n) => files.some((f) => readFileSync(f).includes(Buffer.from(n, "utf8"))));
    const aVault = await inA(async ({ app }, b) => {
      const hits = [];
      for (const f of app.vault.getFiles()) if ((await app.vault.adapter.read(f.path).catch(() => "")).includes(b)) hits.push(f.path);
      return hits;
    }, B_CANARY);
    const bHasA = [...b.files.values()].some((t) => t.includes(A_CANARY));
    evidence("C19-C20", { stateFiles: files.length, stateBytes: files.reduce((n, f) => n + statSync(f).size, 0), found, aVaultHasB: aVault, bHasA });
    expect(files.length).toBeGreaterThan(0);
    expect(found).toEqual([]);
    expect(aVault).toEqual([]);
    expect(bHasA).toBe(false);
  });
});
