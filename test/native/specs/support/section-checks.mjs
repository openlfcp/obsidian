// Shared by the Live Preview and undo/redo specs (section-lp-markers,
// section-undo-redo): vault A is real Obsidian with real keys, B the headless
// peer, the reference server at LFCP_SERVER_BIN. Not a spec itself (the
// harness runs specs/**/*.e2e.mjs only).
import { peer, restartableServer } from "../../peer.bundle.mjs";

export const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
export const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);
// Cmd on macOS, Ctrl elsewhere: Meta does not cut or paste on Linux.
export const mod = process.platform === "darwin" ? "Meta" : "Control";

const TASK_LINE = /^[ \t]*[-*+] \[.\] /;
const MARKER = /<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*?-->/g;
const WHOLE = /^[ \t]*<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->[ \t]*$/;
const REF_ID = /lfcp-ref:[^>]*#task:([0-9a-f-]{36})/;
const NODE_ID = /lfcp-node:[ \t]+[a-z]+:(\S+)[ \t]+-->/;

/** The Task titles of `md`, in order (its refs and block IDs left out). */
export const titles = (md) =>
  md
    .split("\n")
    .filter((l) => TASK_LINE.test(l))
    .map((l) => l.replace(TASK_LINE, "").replace(/\s*<!-- lfcp-ref:.*-->$/, "").replace(/\s*\^[\w-]+$/, ""));

/**
 * The marker problems of a note: stray marker text (a marker glued to other
 * text, half a marker), section boundaries not balanced, an ID bound more
 * than once, a ref without its Task line (orphaned) or a Task line without
 * its ref, in the section. Empty when the note is sound; also gives the
 * section's Task IDs in order.
 */
export function markerProblems(md) {
  const L = md.split("\n");
  const problems = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    const rest = line.replace(MARKER, "");
    if (/lfcp-|<!--|-->/.test(rest)) problems.push(`stray marker text on line ${i}: ${JSON.stringify(line)}`);
    const markers = line.match(MARKER) ?? [];
    for (const m of markers) {
      if (/lfcp-ref:/.test(m) && !WHOLE.test(line) && !(TASK_LINE.test(line) && line.trimEnd().endsWith(m)))
        problems.push(`a ref glued to text on line ${i}: ${JSON.stringify(line)}`);
      if (/lfcp-(?:section|node):/.test(m) && !WHOLE.test(line))
        problems.push(`a marker glued to text on line ${i}: ${JSON.stringify(line)}`);
    }
    if (/<!--[ \t]+lfcp-section:/.test(line)) starts.push(i);
    if (/<!--[ \t]+\/lfcp-section:/.test(line)) ends.push(i);
  }
  if (starts.length !== 1 || ends.length !== 1 || !(starts[0] < ends[0]))
    problems.push(`section boundaries not balanced: starts ${JSON.stringify(starts)}, ends ${JSON.stringify(ends)}`);
  const ids = new Map();
  const taskIds = [];
  for (let i = 0; i < L.length; i++) {
    const id = REF_ID.exec(L[i])?.[1] ?? NODE_ID.exec(L[i])?.[1];
    if (id === undefined) continue;
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n !== 1) problems.push(`${id} bound ${n} times`);
  if (starts.length === 1 && ends.length === 1) {
    for (let i = starts[0] + 1; i < ends[0]; i++) {
      const line = L[i];
      if (TASK_LINE.test(line)) {
        const inline = REF_ID.exec(line)?.[1];
        const child = WHOLE.test(L[i + 1] ?? "") ? REF_ID.exec(L[i + 1])?.[1] : undefined;
        if (inline === undefined && child === undefined) problems.push(`Task line ${i} has no ref: ${JSON.stringify(line)}`);
        else taskIds.push(inline ?? child);
      } else if (WHOLE.test(line) && REF_ID.test(line) && !TASK_LINE.test(L[i - 1] ?? ""))
        problems.push(`orphaned ref on line ${i} (no Task line above it)`);
    }
  }
  return { problems, taskIds };
}

/** A's editor text, model, badge for the section `hex`. */
export const stateA = (hex) =>
  inA(({ app, obsidian }, hex) => {
    const p = app.plugins.plugins["shared-tasks"];
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
    const replica = p.runtime.sectionProfile(R).replica;
    const tree = replica.tree();
    return {
      md: view.editor.getValue(),
      json: JSON.stringify(replica.toJSON()),
      tasks: tree.tree.filter((e) => e.kind === "task").map((e) => e.id),
      classification: tree.classification,
      recovery: tree.recovery.map((r) => `${r.code}:${r.id}`),
      badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
    };
  }, hex);

/** B's model of the section, as JSON. */
export const jsonB = (b, hex) =>
  JSON.stringify(b.runtime.sectionProfile(Uint8Array.from(Buffer.from(hex, "hex"))).replica.toJSON());

/** Waits until A's editor text stays the same for 1.5 s and A is CURRENT. */
export async function settle(hex, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = await stateA(hex);
  let since = Date.now();
  for (;;) {
    await browser.pause(250);
    const now = await stateA(hex);
    if (now.md !== last.md || now.badge !== last.badge) {
      last = now;
      since = Date.now();
    } else if (now.badge === "CURRENT" && Date.now() - since >= 1500) return now;
    if (Date.now() > deadline) return now;
  }
}

/**
 * After a step: A settles; the note's markers are sound; A's model has the
 * note's Tasks in the note's order, nothing to recover; B's model converges
 * to A's, and B's note shows the same Tasks. Returns A's state.
 */
export async function checkStep(label, ctx) {
  const a = await settle(ctx.R);
  const { problems, taskIds } = markerProblems(a.md);
  let b = null;
  try {
    b = await browser.waitUntil(
      async () => {
        const now = await stateA(ctx.R);
        return jsonB(ctx.b, ctx.R) === now.json ? now : false;
      },
      { timeout: 20_000 },
    );
  } catch {}
  await ctx.b.pass(ctx.bFile);
  const titlesA = titles(sectionOf(a.md));
  const titlesB = titles(sectionOf(ctx.b.files.get(ctx.bFile)));
  evidence(label, {
    titlesA,
    titlesB,
    problems,
    badge: a.badge,
    classification: a.classification,
    recovery: a.recovery,
    converged: b !== null,
    modelOrderMatchesNote: JSON.stringify(a.tasks) === JSON.stringify(taskIds),
  });
  if (problems.length > 0 || b === null) evidence(`${label} note`, { md: a.md.split("\n") });
  expect(problems).toEqual([]);
  expect(a.badge).toBe("CURRENT");
  expect(a.recovery).toEqual([]);
  expect(a.tasks).toEqual(taskIds);
  expect(b).not.toBe(null);
  expect(titlesB).toEqual(titlesA);
  return { ...a, titles: titlesA };
}

/** The lines of `md`'s section (start marker through end marker). */
export function sectionOf(md) {
  const L = md.split("\n");
  const s = L.findIndex((l) => /<!--[ \t]+lfcp-section:/.test(l));
  const e = L.findIndex((l) => /<!--[ \t]+\/lfcp-section:/.test(l));
  return s < 0 || e < 0 ? md : L.slice(s, e + 1).join("\n");
}

/** Starts the server and B once, and points A's plugin at the server, sections on. */
export async function startPeers() {
  const server = await restartableServer();
  const b = await peer(server.url);
  await inA(async ({ app }, url) => {
    const plugin = app.plugins.plugins["shared-tasks"];
    plugin.settings.defaultServer = url;
    plugin.settings.sectionsDisabled = false;
    await plugin.saveData(plugin.settings);
    await app.plugins.disablePlugin("shared-tasks");
    await app.plugins.enablePlugin("shared-tasks");
    const q = app.plugins.plugins["shared-tasks"];
    for (let i = 0; i < 100 && q.runtime?.status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
  }, server.url);
  return { server, b };
}

/**
 * A creates `file` with `text`, opens it (Live Preview unless `source`),
 * shares the section under `heading`; B joins it into a note of its own.
 * Returns the section's Resource (hex) and B's note.
 */
export async function shareAndJoin(b, file, heading, text, source = false) {
  await inA(
    async ({ app, obsidian }, file, text, source) => {
      await app.vault.create(file, text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: "source", source } });
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
    },
    file,
    text,
    source,
  );
  const title = heading.replace(/^#+ /, "");
  const R = await browser.waitUntil(
    () =>
      inA(
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
  await pick(title);
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

/** Runs `fn(editor, ...args)` on A's active editor. */
export const editorA = (fn, ...args) =>
  inA(
    ({ app, obsidian }, src, ...args) => {
      const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor;
      return (0, eval)(`(${src})`)(e, ...args);
    },
    fn.toString(),
    ...args,
  );

/** The line of the Task titled `title` in A's editor. */
export const lineOf = (title) =>
  editorA((e, t) => e.getValue().split("\n").findIndex((l) => /^[ \t]*[-*+] \[.\] /.test(l) && l.includes(`] ${t}`)), title);

/** Puts A's caret on `line` at `ch` (focused); `ch` "end" is the line's end, "text" the Task text's start. */
export async function caret(line, ch) {
  await editorA(
    (e, line, ch) => {
      e.focus();
      const text = e.getLine(line);
      const at = ch === "end" ? text.length : ch === "text" ? (/^[ \t]*[-*+] \[.\] /.exec(text)?.[0].length ?? 0) : ch;
      e.setCursor({ line, ch: at });
    },
    line,
    ch,
  );
  await browser.pause(150);
}
