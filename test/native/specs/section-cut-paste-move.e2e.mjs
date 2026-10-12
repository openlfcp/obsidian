// Two-Obsidian check step 6 (0.4.0-beta.5): a Task cut and pasted one place
// up in one pass (Cmd+X, then Cmd+V within the 400 ms pause) while offline,
// and the same Task moved last by the other vault, need attention on both:
// the cut Task is the one moved, not the neighbour it passed. Vault A is real
// Obsidian with real keys in Source mode; B is the headless peer; the
// reference server at LFCP_SERVER_BIN goes down for the moves.
import { peer, restartableServer } from "../peer.bundle.mjs";

const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
// Cmd on macOS, Ctrl elsewhere: Meta does not cut or paste on Linux.
const mod = process.platform === "darwin" ? "Meta" : "Control";
const NOTE = [
  "PRIVATE-A",
  "",
  "## Plan",
  "",
  "- [ ] Write the brief",
  "- [ ] Review the draft",
  "- [ ] Send to the client",
  "",
  "A paragraph.",
  "",
].join("\n");
const titles = (md) =>
  md
    .split("\n")
    .filter((l) => /^\s*- \[.\] /.test(l))
    .map((l) => l.replace(/^\s*- \[.\] /, ""));
const noteA = () => inA(({ app }) => app.vault.adapter.read("Plan.md"));
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
let R;

describe("a Task cut and pasted one place up while the other vault moves it (step 6)", () => {
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
      const q = app.plugins.plugins["shared-tasks"];
      for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++)
        await new Promise((r) => setTimeout(r, 50));
    }, server.url);
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  it("A shares the section; B joins and adds a Task at its end", async () => {
    await inA(async ({ app, obsidian }, text) => {
      await app.vault.create("Plan.md", text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Plan.md"), { state: { mode: "source", source: true } });
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
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Share").click();
    }, NOTE);
    R = await browser.waitUntil(
      () =>
        inA(async ({ app }) => {
          const p = app.plugins.plugins["shared-tasks"];
          if (!(await app.vault.adapter.read("Plan.md")).includes("<!-- /lfcp-section: ")) return false;
          const e = (await p.runtime.registry()).find((x) => x.profile.includes("section"));
          if (e === undefined) return false;
          const hex = Buffer.from(e.resourceId).toString("hex");
          return (await p.runtime.localState.get(`collab-hosting:${hex}`)) === "hosted" ? hex : false;
        }),
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
    await pick("Plan");
    await pick("Read + write");
    const link = await inA(async () => {
      let modal;
      for (let i = 0; i < 200 && modal === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = [...document.querySelectorAll(".modal-container .modal")].find((m) =>
          m.textContent.includes("Invitation ("),
        );
      }
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Show link").click();
      const value = modal.querySelector("input").value;
      [...modal.querySelectorAll("button")].find((x) => x.textContent === "Done").click();
      return value;
    });
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert(link, "B.md", 3);
    const L = b.files.get("B.md").split("\n");
    L.splice(L.findLastIndex((l) => l.includes("lfcp-ref:")) + 1, 0, "- [ ] Added by Bob");
    b.files.set("B.md", L.join("\n"));
    await b.pass("B.md");
    await b.pass("B.md");
    await browser.waitUntil(async () => taskId(await noteA(), "Added by Bob") !== undefined, {
      timeout: 30_000,
      timeoutMsg: "Bob's Task bound in A",
    });
  });

  it("offline, A cuts and pastes it within one pass; B moves it last: both need attention", async () => {
    await server.down();
    await browser.waitUntil(async () => (await badgeA()) === "OFFLINE", {
      timeout: 60_000,
      timeoutMsg: "A offline",
    });
    const send = taskId(await noteA(), "Send to the client");
    // A: the Task line and its ref line, Cmd+X; the caret after Write's ref line, Cmd+V.
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const at = view.editor.getValue().split("\n").findIndex((l) => l.includes("[ ] Send to the client"));
      view.editor.focus();
      view.editor.setSelection({ line: at, ch: 0 }, { line: at + 2, ch: 0 });
    });
    await browser.keys([mod, "x"]);
    await browser.pause(100);
    await inA(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const at = view.editor.getValue().split("\n").findIndex((l) => l.includes("[ ] Write the brief"));
      view.editor.setCursor({ line: at + 2, ch: 0 });
    });
    await browser.keys([mod, "v"]);
    await browser.pause(2500);
    const localA = titles(await noteA());
    expect(localA.slice(0, 2)).toEqual(["Write the brief", "Send to the client"]);
    // B: the same Task moved after Bob's.
    const L = b.files.get("B.md").split("\n");
    const block = L.splice(
      L.findIndex((l) => l.includes("[ ] Send to the client")),
      2,
    );
    L.splice(L.findIndex((l) => l.includes("[ ] Added by Bob")) + 2, 0, ...block);
    b.files.set("B.md", L.join("\n"));
    await b.pass("B.md");
    await server.up();
    const merged = await browser.waitUntil(
      async () => {
        const m = await modelA(R);
        return m.conflicts.length > 0 ? m : false;
      },
      { timeout: 60_000, timeoutMsg: "A: a placement conflict after reconnecting" },
    );
    const tree = b.runtime.sectionProfile(Uint8Array.from(Buffer.from(R, "hex"))).replica.tree();
    const conflictsB = tree.recovery.filter((r) => r.code === "PLACEMENT_CONFLICT").map((r) => r.id);
    const badge = await browser.waitUntil(async () => ((await badgeA()) === "ATTENTION" ? "ATTENTION" : false), {
      timeout: 30_000,
      timeoutMsg: "A's badge needs attention",
    });
    evidence("STEP6", { localA, conflictsA: merged.conflicts, conflictsB, badge });
    expect(merged.conflicts).toEqual([send]);
    expect(conflictsB).toEqual([send]);
  });

  // The owner's check of 0.4.0-beta.6: Review conflicts asked a second,
  // spurious question ("restored in two places"), offered "The section's top
  // level" twice, and one question's choice turned into "Delete it" when
  // another was applied. One question now, each place named by its position,
  // nothing chosen beforehand, and the place chosen is where the Task goes.
  it("Review conflicts: one question, each place named, the chosen place applied in both", async () => {
    const send = taskId(await noteA(), "Send to the client");
    await inA(async ({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view.containerEl.querySelector(".openlfcp-status").click();
      let button;
      for (let i = 0; i < 100 && button === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        button = [...document.querySelectorAll(".modal-container button")].find((x) => x.textContent === "Review conflicts…");
      }
      button.click();
    });
    const asked = await inA(async () => {
      let modal = null;
      for (let i = 0; i < 100 && modal === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        modal = document.querySelector(".openlfcp-recovery");
      }
      return [...modal.querySelectorAll(".openlfcp-recovery-item")].map((box) => ({
        question: box.querySelector("p").textContent,
        choices: [...box.querySelectorAll(".openlfcp-recovery-choice")].map((c) => c.textContent.trim()),
        checked: [...box.querySelectorAll("input")].some((r) => r.checked),
        applyDisabled: box.querySelector("button").disabled,
      }));
    });
    evidence("REVIEW", { asked });
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toContain("was moved to two places");
    expect([...asked[0].choices].sort()).toEqual(['After Task "Added by Bob"', 'After Task "Write the brief"']);
    expect(asked[0].checked).toBe(false);
    expect(asked[0].applyDisabled).toBe(true);
    const note = await inA(async () => {
      const modal = document.querySelector(".openlfcp-recovery");
      const row = [...modal.querySelectorAll(".openlfcp-recovery-choice")].find((c) =>
        c.textContent.includes("Write the brief"),
      );
      const radio = row.querySelector("input");
      radio.click();
      modal.querySelector(".openlfcp-recovery-item button").click();
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const p = modal.querySelector(".openlfcp-recovery-note");
        if (p !== null) return p.textContent;
      }
      return null;
    });
    expect(note).toBe("Applied.");
    await browser.waitUntil(async () => (await modelA(R)).conflicts.length === 0, {
      timeout: 30_000,
      timeoutMsg: "A: the conflict resolved",
    });
    await browser.waitUntil(async () => titles(await noteA()).slice(0, 2).join() === "Write the brief,Send to the client", {
      timeout: 30_000,
      timeoutMsg: "A shows the Task where it was chosen",
    });
    let order = [];
    for (let i = 0; i < 40; i++) {
      await b.pass("B.md");
      order = titles(b.files.get("B.md"));
      if (order.slice(0, 2).join() === "Write the brief,Send to the client") break;
      await browser.pause(250);
    }
    evidence("REVIEW-APPLIED", { a: titles(await noteA()), b: order, send });
    expect(order.slice(0, 2)).toEqual(["Write the brief", "Send to the client"]);
  });
});
