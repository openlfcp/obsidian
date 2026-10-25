// The owner's check of 0.4.0-beta.9, step 6 again: the LAST Task of a
// section moved ONE place up by a cut (with its ref line) and a paste at the
// start of the previous Task line, in Source mode, while the other vault
// moves the same Task to the section's start, both offline. The cut Task is
// the one that moved: a PLACEMENT_CONFLICT on both sides, never the
// neighbour's move silently winning. Both timings: the cut and the paste in
// one pass (Cmd+V within the 400 ms pause), and in two passes (a pause
// between them); and a cut the plugin does not see as one (copied, then
// removed by another path): the paste's bindings alone say what moved. Vault A is real Obsidian with real keys; B is the headless
// peer; the reference server at LFCP_SERVER_BIN goes down for the moves.
import { peer, restartableServer } from "../peer.bundle.mjs";
import { inviteToSectionInA } from "./support/section-checks.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
// Cmd on macOS, Ctrl elsewhere: Meta does not cut or paste on Linux.
const mod = process.platform === "darwin" ? "Meta" : "Control";
const note = (heading) =>
  [heading, "", "- [ ] Gamma", "- [ ] Alpha", "- [ ] Beta", "- [ ] テスト", "- [ ] 仕事終わり", "- [ ] omega", ""].join("\n");
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

/** A's journaled intents from now on (the batches its passes commit), by operation. */
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

const FILES = { "one pass": "Nine", "two passes": "Ten", "cut not seen": "Eleven" };
for (const timing of ["one pass", "two passes", "cut not seen"])
  describe(`the last Task cut and pasted one place up, ${timing}, while B moves it first (beta.9 step 6)`, () => {
    const file = `${FILES[timing]}.md`;
    const heading = `## ${FILES[timing]}`;
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

    after(async () => {
      if (timing === "cut not seen") {
        await b?.stop();
        await server?.stop();
      }
    });

    it("A shares the section, B joins", async () => {
      ({ R, bFile } = await shareAndJoin(file, heading));
      await browser.waitUntil(async () => (await badgeA()) === "CURRENT", { timeout: 30_000, timeoutMsg: "A current" });
    });

    it("offline: A's move and B's move of omega need attention on both sides", async () => {
      await server.down();
      await browser.waitUntil(async () => (await badgeA()) === "OFFLINE", { timeout: 60_000, timeoutMsg: "A offline" });
      const omega = taskId(await noteA(file), "omega");
      await recordA();
      // C's geometry: omega's line and its ref line selected, Cmd+X; the caret at the start of "仕事終わり", Cmd+V.
      await inA(({ app, obsidian }) => {
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const at = view.editor.getValue().split("\n").findIndex((l) => l.includes("[ ] omega"));
        view.editor.focus();
        view.editor.setSelection({ line: at, ch: 0 }, { line: at + 2, ch: 0 });
      });
      if (timing === "cut not seen") {
        // Copied, then removed by another path (no cut event): the paste alone says what moved.
        await browser.keys([mod, "c"]);
        await inA(({ app, obsidian }) => {
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          view.editor.replaceSelection("");
        });
      } else await browser.keys([mod, "x"]);
      await browser.pause(timing === "one pass" ? 100 : 2500);
      await inA(({ app, obsidian }) => {
        const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const at = view.editor.getValue().split("\n").findIndex((l) => l.includes("[ ] 仕事終わり"));
        view.editor.setCursor({ line: at, ch: 0 });
      });
      await browser.keys([mod, "v"]);
      await browser.pause(2500);
      const localA = titles(await noteA(file));
      const ops = await inA(() => window.__lfcpOps);
      const moved = [...new Set(ops.flatMap((o) => o.intents.filter((i) => i.intent === "node.move").map((i) => i.id)))];
      evidence(`BETA9-STEP6 ${timing}`, { localA, omega, ops, moved });
      expect(localA).toEqual(["Gamma", "Alpha", "Beta", "テスト", "omega", "仕事終わり"]);
      // The cut Task is the one moved; its neighbour never.
      expect(moved).not.toContain(taskId(await noteA(file), "仕事終わり"));
      // B: omega moved to the section's start.
      const L = b.files.get(bFile).split("\n");
      const block = L.splice(L.findIndex((l) => l.includes("[ ] omega")), 2);
      L.splice(L.findIndex((l) => l.includes("[ ] Gamma")), 0, ...block);
      b.files.set(bFile, L.join("\n"));
      await b.pass(bFile);
      await server.up();
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
      const badge = await browser.waitUntil(async () => ((await badgeA()) === "ATTENTION" ? "ATTENTION" : false), {
        timeout: 30_000,
        timeoutMsg: "A's badge needs attention",
      });
      evidence(`BETA9-STEP6 ${timing} merged`, { conflictsA: merged.conflicts, conflictsB, badge });
      expect(merged.conflicts).toEqual([omega]);
      expect(conflictsB).toEqual([omega]);
    });
  });
