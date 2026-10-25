// The owner's trace on macOS (0.4.0-beta.10, step 6): before the user's
// move, the editor had noted every node as moved, from edits that were not
// the user's, and the move went to the neighbour. Here, before Gamma is cut
// and pasted one place up (offline, while B moves it to the section's
// start): B edits several Tasks (renders into A), another plugin rewrites
// parts of the note as they were (no userEvent; no pass runs: the note is
// what was last reconciled), and the note is written to disk as it is. Gamma is still the node moved, and both vaults get a
// PLACEMENT_CONFLICT on Gamma. On 0.4.0-beta.11, Beta was journaled as
// moved and no conflict came, as in the owner's trace.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { inviteToSectionInA } from "./support/section-checks.mjs";

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
  await inviteToSectionInA(heading.replace(/^#+ /, ""));
  const pick = (label) =>
    inA(async ({}, label) => {
      let items = [];
      for (let i = 0; i < 100 && items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        items = [...document.querySelectorAll(".prompt .suggestion-item")];
      }
      items.find((x) => x.textContent.includes(label)).click();
    }, label);
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
  "after remote renders, a rewrite without a userEvent and a reload": async () => {
    const g = await lineOf("Gamma");
    await editorA((e, g) => {
      e.focus();
      e.setSelection({ line: g, ch: 0 }, { line: g + 2, ch: 0 });
    }, g);
    await browser.keys([mod, "x"]);
    // Pasted within the pause before a pass: the cut and the paste in one pass.
    await editorA((e, b) => e.setCursor({ line: b, ch: 0 }), await lineOf("Beta"));
    await browser.keys([mod, "v"]);
  },
};

/** Before the move: B edits several Tasks (online), A's note is rewritten and reloaded, unchanged. */
async function notTheUsers(bFile, file) {
  const L = b.files.get(bFile).split("\n").map((l) => (/\[ \] (Alpha|テスト|omega)$/.test(l) ? `${l} edited` : l));
  b.files.set(bFile, L.join("\n"));
  await b.pass(bFile);
  await browser.waitUntil(async () => (await noteA(file)).includes("omega edited"), {
    timeout: 30_000,
    timeoutMsg: "B's edits rendered in A",
  });
  await browser.pause(1500);
  // A keystroke and its Backspace: a pass that writes nothing, so the note is
  // the source last reconciled.
  await editorA((e, g) => {
    e.focus();
    e.setCursor({ line: g, ch: e.getLine(g).length });
  }, await lineOf("仕事して"));
  await browser.keys(["x"]);
  await browser.pause(1000);
  await browser.keys(["Backspace"]);
  await browser.pause(1500);
  // Another plugin rewrites part of the note as it was (CodeMirror directly,
  // no userEvent): Alpha's and Gamma's lines whole, the other refs from their
  // third column. Unchanged, so no pass runs on it; the owner's trace had the
  // same hints left: Gamma and Alpha removed, every node inserted.
  await editorA((e) => {
    const doc = e.cm.state.doc;
    const changes = [];
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (!line.text.includes("lfcp-ref:")) continue;
      const task = doc.line(n - 1);
      const whole = /\[ \] (Alpha|Gamma)/.test(task.text);
      const from = whole ? task.from : line.from + 2;
      changes.push({ from, to: line.to, insert: doc.sliceString(from, line.to) });
    }
    e.cm.dispatch({ changes });
  });
  // The note written on disk as it is: Obsidian reloads it ("set").
  await inA(async ({ app }, file) => {
    await app.vault.process(app.vault.getFileByPath(file), (t) => t);
  }, file);
  await browser.pause(1500);
}

const names = Object.keys(GESTURES);
names.forEach((gesture, k) =>
  describe(`Gamma one place up: ${gesture}, while B moves it to the start (beta.10 macOS step 6)`, () => {
    const file = `Hints${k}.md`;
    const heading = `## Hints${k}`;
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
      await notTheUsers(bFile, file);
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
    });
  }),
);

after(async () => {
  await b?.stop();
  await server?.stop();
});

