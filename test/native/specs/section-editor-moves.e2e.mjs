// The owner's checks of 0.4.0-beta.10 on macOS, step 6, and the editor's
// other moves: Gamma (third of six) one place up while B moves it to the
// section's start, both offline, by Move line up, by the owner's own keys
// (the caret at the start of Gamma's line, Shift+Down twice, Ctrl+X, Up to
// Beta's line, Ctrl+V) in Source mode and in Live Preview, and by a paste
// of Gamma cut without its trailing newline at the start of Beta's line. In
// each, Gamma is the node moved (never Beta), nothing is held, and both
// vaults get a PLACEMENT_CONFLICT on Gamma. Then Tab: Gamma's ref line is
// indented with it, Gamma becomes Beta's child on both sides. Vault A is real
// Obsidian with real keys; B is the headless peer; the reference server at
// LFCP_SERVER_BIN goes down for the moves.
import { peer, restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
// Cmd on macOS, Ctrl elsewhere: Meta does not cut or paste on Linux.
const mod = process.platform === "darwin" ? "Meta" : "Control";
const note = (heading) =>
  [heading, "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] テスト", "- [ ] 仕事して", "- [ ] omega", ""].join("\n");
const titles = (md) =>
  md
    .split("\n")
    .filter((l) => /^\s*- \[.\] /.test(l))
    .map((l) => l.replace(/^\s*- \[.\] /, ""));
const noteA = (file) => inA(({ app }, file) => app.vault.adapter.read(file), file);
const badgeA = () =>
  inA(({ app, obsidian }) => {
    const el = app.workspace
      .getActiveViewOfType(obsidian.MarkdownView)
      ?.containerEl.querySelector(".openlfcp-status");
    return el?.dataset.state ?? null;
  });
/** In A: the Task IDs with a placement conflict, and the visible order of the Tasks. */
const modelA = (hex) =>
  inA(({ app }, hex) => {
    const p = app.plugins.plugins["shared-tasks"];
    const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
    const tree = p.runtime.sectionProfile(R).replica.tree();
    return {
      conflicts: tree.recovery.filter((r) => r.code === "PLACEMENT_CONFLICT").map((r) => r.id),
      tasks: tree.tree.filter((e) => e.kind === "task").map((e) => e.id),
    };
  }, hex);
/** The Task ID of the line titled `title` (its lfcp-ref on the next line). */
const taskId = (md, title) => {
  const L = md.split("\n");
  const at = L.findIndex((l) => l.includes(`[ ] ${title}`));
  return /#task:([0-9a-f-]{36})/.exec(L[at + 1] ?? "")?.[1];
};


let server;
let b;

/** A shares `file` (its section `heading`), B joins it into its own note; the section's Resource (hex). */
async function shareAndJoin(file, heading) {
  await inA(async ({ app, obsidian }, file, text) => {
    await app.vault.create(file, text);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source: true } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    for (let i = 0; i < 40 && view.editor.getValue() !== text; i++) await new Promise((r) => setTimeout(r, 50));
    view.editor.setCursor({ line: 0, ch: 0 });
    app.commands.executeCommandById("shared-tasks:share-section");
    let modal = null;
    for (let i = 0; i < 80 && modal === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      modal = document.querySelector(".modal-container .modal");
    }
    [...modal.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
  }, file, note(heading));
  const R = await browser.waitUntil(
    () =>
      inA(async ({ app }, file, title) => {
        const p = app.plugins.plugins["shared-tasks"];
        if (!(await app.vault.adapter.read(file)).includes("<!-- /lfcp-section: ")) return false;
        for (const e of await p.runtime.registry()) {
          if (!e.profile.includes("section") || e.localName !== title) continue;
          const hex = Buffer.from(e.resourceId).toString("hex");
          return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted" ? hex : false;
        }
        return false;
      }, file, heading.replace(/^#+ /, "")),
    { timeout: 60_000, timeoutMsg: "the section shared and hosted" },
  );
  await inA(({ app }) => app.commands.executeCommandById("shared-tasks:invite-collaborator"));
  const pick = (label) =>
    inA(async ({}, label) => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes(label)).click();
    }, label);
  await pick(heading.replace(/^#+ /, ""));
  await pick("Read + write");
  const link = await inA(async () => {
    let modal;
    for (let i = 0; i < 200 && modal === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      modal = [...document.querySelectorAll(".modal-container .modal")].find((m) => m.textContent.includes("Invitation ("));
    }
    [...modal.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
    const value = modal.querySelector("input").value;
    [...modal.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
    return value;
  });
  const bFile = `B-${file}`;
  b.files.set(bFile, ["# B", "", "Insert below.", ""].join("\n"));
  await b.joinAndInsert(link, bFile, 3);
  return { R, bFile };
}

/** A's journaled intents from now on (the batches its passes commit). */
const recordA = () =>
  inA(({ app }) => {
    const ls = app.plugins.plugins["shared-tasks"].runtime.localState;
    window.__lfcpOps = [];
    if (ls.__recorded) return;
    ls.__recorded = true;
    const put = ls.put.bind(ls);
    ls.put = (key, value) => {
      if (key.startsWith("section-op:") && Array.isArray(value?.intents) && window.__lfcpOps !== undefined)
        window.__lfcpOps.push({ phase: value.phase, intents: value.intents.map((i) => ({ intent: i.intent, id: i.id ?? i.task?.id ?? null })) });
      return put(key, value);
    };
  });
const editorA = (fn, ...args) =>
  inA(
    ({ app, obsidian }, src, ...args) => {
      const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
      return (0, eval)(`(${src})`)(e, ...args);
    },
    fn.toString(),
    ...args,
  );
const lineOf = (title) => editorA((e, t) => e.getValue().split("\n").findIndex((l) => l.includes(`[ ] ${t}`)), title);
const setMode = (source) =>
  inA(async ({ app, obsidian }, source) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    await view.leaf.setViewState({ type: "markdown", state: { file: view.file.path, mode: "source", source } });
    await new Promise((r) => setTimeout(r, 300));
  }, source);

/** The owner's keys: Shift+Down twice from the start of Gamma's line, cut, Up to Beta's line, paste. */
async function ownerKeys() {
  await editorA((e, g) => {
    e.focus();
    e.setCursor({ line: g, ch: 0 });
  }, await lineOf("Gamma"));
  await browser.pause(200);
  await browser.keys(["Shift", "ArrowDown"]);
  await browser.pause(150);
  await browser.keys(["Shift", "ArrowDown"]);
  await browser.pause(150);
  await browser.keys([mod, "x"]);
  await browser.pause(700);
  for (let i = 0; i < 6; i++) {
    if ((await editorA((e) => e.getLine(e.getCursor().line))).includes("[ ] Beta")) break;
    await browser.keys(["ArrowUp"]);
    await browser.pause(120);
  }
  await browser.keys(["Home"]);
  await browser.pause(150);
  await browser.keys([mod, "v"]);
}

const GESTURES = {
  "Move line up": async () => {
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 3 });
    }, await lineOf("Gamma"));
    await browser.executeObsidianCommand("editor:swap-line-up");
  },
  "the owner's keys in Source mode": ownerKeys,
  "the owner's keys in Live Preview": async () => {
    await setMode(false);
    await ownerKeys();
  },
  "Gamma cut without its trailing newline, pasted at the start of Beta's line": async () => {
    const g = await lineOf("Gamma");
    await editorA((e, g) => {
      e.focus();
      e.setSelection({ line: g, ch: 0 }, { line: g + 1, ch: e.getLine(g + 1).length });
    }, g);
    await browser.keys([mod, "x"]);
    await browser.pause(700);
    await editorA((e, b) => e.setCursor({ line: b, ch: 0 }), await lineOf("Beta"));
    await browser.keys([mod, "v"]);
  },
};

const names = Object.keys(GESTURES);
names.forEach((gesture, k) =>
  describe(`Gamma one place up: ${gesture}, while B moves it to the start (beta.10 macOS step 6)`, () => {
    const file = `Moves${k}.md`;
    const heading = `## Moves${k}`;
    let R;
    let bFile;

    before(async () => {
      if (server === undefined) {
        server = await restartableServer();
        b = await peer(server.url);
        await inA(async ({ app }, url) => {
          const plugin = app.plugins.plugins["shared-tasks"];
          plugin.settings.defaultServer = url;
          plugin.settings.sectionsDisabled = false;
          await plugin.saveData(plugin.settings);
          await app.plugins.disablePlugin("shared-tasks");
          await app.plugins.enablePlugin("shared-tasks");
          const q = app.plugins.plugins["shared-tasks"];
          for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++)
            await new Promise((r) => setTimeout(r, 50));
        }, server.url);
      }
    });

    it("A shares the section, B joins", async () => {
      ({ R, bFile } = await shareAndJoin(file, heading));
      await browser.waitUntil(async () => (await badgeA()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    });

    it("offline: Gamma is the one moved, nothing held; then a placement conflict on both", async () => {
      await server.down();
      await browser.waitUntil(async () => (await badgeA()) === "OFFLINE", { timeout: 60_000, timeoutMsg: "A offline" });
      const before = await noteA(file);
      const gamma = taskId(before, "Gamma");
      const beta = taskId(before, "Beta");
      await recordA();
      await GESTURES[gesture]();
      await browser.pause(2500);
      const after = await noteA(file);
      const ops = await inA(() => window.__lfcpOps);
      const moved = [...new Set(ops.flatMap((o) => o.intents.filter((i) => i.intent === "node.move").map((i) => i.id)))];
      const localA = titles(after);
      const badge = await badgeA();
      evidence(`BETA10-MAC-STEP6 ${gesture}`, { localA, moved, badge, gamma, beta });
      // B: Gamma moved to the section's start; the network back (before any check fails).
      const L = b.files.get(bFile).split("\n");
      const block = L.splice(L.findIndex((l) => l.includes("[ ] Gamma")), 2);
      L.splice(L.findIndex((l) => l.includes("[ ] Alpha")), 0, ...block);
      b.files.set(bFile, L.join("\n"));
      await b.pass(bFile);
      await server.up();
      // Gamma above Beta (in Live Preview the keys take テスト along), each Task with its ref.
      expect(localA.indexOf("Gamma")).toBeLessThan(localA.indexOf("Beta"));
      expect(localA.filter((t) => t === "Gamma")).toHaveLength(1);
      expect(taskId(after, "Gamma")).toBe(gamma);
      expect(moved).toContain(gamma);
      expect(moved).not.toContain(beta);
      expect(badge).toBe("OFFLINE");
      const merged = await browser.waitUntil(
        async () => {
          const m = await modelA(R);
          return m.conflicts.length > 0 ? m : false;
        },
        { timeout: 60_000, timeoutMsg: "A: a placement conflict after reconnecting" },
      );
      const conflictsB = await browser.waitUntil(
        async () => {
          const c = b.runtime
            .sectionProfile(Uint8Array.from(Buffer.from(R, "hex")))
            .replica.tree()
            .recovery.filter((r) => r.code === "PLACEMENT_CONFLICT")
            .map((r) => r.id);
          return c.length > 0 ? c : false;
        },
        { timeout: 30_000, timeoutMsg: "B: a placement conflict after reconnecting" },
      );
      evidence(`BETA10-MAC-STEP6 ${gesture} merged`, { conflictsA: merged.conflicts, conflictsB });
      expect(merged.conflicts).toEqual([gamma]);
      expect(conflictsB).toEqual([gamma]);
      await setMode(true);
    });
  }),
);

describe("Tab on a Task line", () => {
  const file = "MovesTab.md";
  let bFile;

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it("indents its ref line too: Gamma becomes Beta's child on both sides, nothing held", async () => {
    ({ bFile } = await shareAndJoin(file, "## MovesTab"));
    await browser.waitUntil(async () => (await badgeA()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    const before = await noteA(file);
    const g = await lineOf("Gamma");
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 3 });
    }, g);
    await browser.keys(["Tab"]);
    await browser.pause(2500);
    const after = (await noteA(file)).split("\n");
    evidence("TAB", { gamma: after[g], ref: after[g + 1] });
    expect(after[g]).toMatch(/^\t- \[ \] Gamma$/);
    expect(after[g + 1]).toMatch(/^\t\s+<!-- lfcp-ref: .*#task:/);
    expect(after[g + 1]).toContain(taskId(before, "Gamma"));
    await browser.waitUntil(async () => (await badgeA()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current, nothing held" });
    const nested = await browser.waitUntil(
      async () => {
        await b.pass(bFile);
        const L = b.files.get(bFile).split("\n");
        const at = L.findIndex((l) => l.includes("[ ] Gamma"));
        return /^\s+- \[ \] Gamma/.test(L[at] ?? "") ? L[at] : false;
      },
      { timeout: 30_000, timeoutMsg: "B: Gamma nested under Beta" },
    );
    evidence("TAB B", { nested });
  });
});
