// Shared by the Live Preview and undo/redo specs (section-lp-markers,
// section-undo-redo): vault A is real Obsidian with real keys, B the headless
// peer, the reference server at LFCP_SERVER_BIN. Not a spec itself (the
// harness runs specs/**/*.e2e.mjs only).
import { peer, restartableServer } from "../../peer.bundle.mjs";

export const evidence = (id, value) => console.log(`EVIDENCE ${JSON.stringify({ id, ...value })}`);
export const inA = (fn, ...args) => browser.executeObsidian(fn, ...args);

/**
 * Closes every open modal the way a user does, with Obsidian's own close button,
 * and waits until none is left. The button is the modal's first child:
 * `.modal-header-button` with the "x" icon on 1.13 and later (`.mod-cta` and
 * `.mod-start` are phone-only form-sheet buttons), `.modal-close-button` on
 * older versions (1.13+ keeps it only on the image lightbox). Escape is only
 * the fallback, so that a dead button fails here and not in the next case;
 * whether it was needed is in the evidence. Returns "none open", "button" or
 * "Escape". Never click `.modal-close-button` alone: on 1.13+ it matches
 * nothing and the modal stays open.
 */
export const closeModals = async (label) => {
  const before = await inA(() =>
    [...document.querySelectorAll(".modal-container > .modal")].map((m) => {
      const button =
        m.querySelector(":scope > .modal-header-button:not(.mod-cta):not(.mod-start)") ?? m.querySelector(":scope > .modal-close-button");
      button?.click();
      return { title: m.querySelector(".modal-title")?.textContent ?? null, button: button !== null };
    }),
  );
  if (before.length === 0) return "none open";
  const gone = () => inA(() => document.querySelector(".modal-container") === null);
  let closedBy = "button";
  try {
    await browser.waitUntil(gone, { timeout: 5_000, interval: 100 });
  } catch {
    closedBy = "Escape";
    for (let i = 0; i < before.length + 1 && !(await gone()); i++) await browser.keys("Escape");
    await browser.waitUntil(gone, { timeout: 5_000, interval: 100, timeoutMsg: `the modals after ${label} closed` });
  }
  evidence(`modals after ${label}`, { before, closedBy });
  return closedBy;
};
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
      // Each Task's parent in the model: a Task's ID, or null under the section.
      parents: Object.fromEntries(
        tree.tree
          .filter((e) => e.kind === "task")
          .map((e) => {
            const p = tree.tree.find((x) => x.id === e.parent);
            return [e.id, p === undefined ? null : p.kind === "task" ? p.id : `(${p.kind})`];
          }),
      ),
      classification: tree.classification,
      recovery: tree.recovery.map((r) => `${r.code}:${r.id}`),
      badge: view.containerEl.querySelector(".openlfcp-status")?.dataset.state ?? null,
    };
  }, hex);

/** B's model of the section, as JSON. */
export const jsonB = (b, hex) =>
  canonical(b.runtime.sectionProfile(Uint8Array.from(Buffer.from(hex, "hex"))).replica.toJSON());

/** JSON with every object's keys sorted: two replicas' equal models give equal strings, whatever their key order. */
export function canonical(value) {
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
        : v;
  return JSON.stringify(sort(value));
}

/** The paths where two JSON values differ (A's value, B's), at most 20. */
function jsonDiff(x, y, path = "", out = []) {
  if (out.length >= 20) return out;
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, a: x, b: y });
    return out;
  }
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) jsonDiff(x[k], y[k], `${path}/${k}`, out);
  return out;
}

/** Leading whitespace as columns (a tab to the next multiple of 4, as CommonMark). */
const columns = (ws) => [...ws].reduce((c, ch) => (ch === "\t" ? c + 4 - (c % 4) : c + 1), 0);

/**
 * Each bound Task's parent as the note's indentation nests it: the nearest
 * Task above whose content column the line reaches, or null at the top of
 * the section. A flat list of IDs in order does not see a Task nested under
 * the wrong one (the owner's check of 0.4.0-beta.14 step 4).
 */
export function noteParents(md) {
  const L = md.split("\n");
  const out = {};
  const stack = [];
  let inSection = false;
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    if (/<!--[ \t]+lfcp-section:/.test(line)) inSection = true;
    if (/<!--[ \t]+\/lfcp-section:/.test(line)) inSection = false;
    if (!inSection) continue;
    const m = /^([ \t]*)([-*+] \[.\] )/.exec(line);
    if (m === null) {
      // A line of its own at the left margin ends every list item above it.
      if (line.trim() !== "" && !/^[ \t]/.test(line) && !WHOLE.test(line)) stack.length = 0;
      continue;
    }
    const col = columns(m[1]);
    const id = REF_ID.exec(line)?.[1] ?? (WHOLE.test(L[i + 1] ?? "") ? REF_ID.exec(L[i + 1])?.[1] : undefined);
    while (stack.length > 0 && (stack.at(-1)?.content ?? 0) > col) stack.pop();
    if (id !== undefined) out[id] = stack.at(-1)?.id ?? null;
    stack.push({ id, content: col + m[2].length - 4 });
  }
  return out;
}

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
 * to A's, and B's note shows the same Tasks (withB false: A only). Returns
 * A's state.
 */
/** Tasks A's note nests otherwise than A's model (a Task under a non-Task node is left out). */
const nesting = (a) => {
  const inNote = noteParents(a.md);
  return Object.entries(a.parents ?? {})
    .filter(([id, p]) => id in inNote && !(typeof p === "string" && p.startsWith("(")))
    .filter(([id, p]) => inNote[id] !== p)
    .map(([id, p]) => `${id.slice(-4)}: note ${inNote[id]?.slice(-4) ?? "top"}, model ${p?.slice(-4) ?? "top"}`);
};

export async function checkStep(label, ctx, { withB = true } = {}) {
  const a = await settle(ctx.R);
  const { problems, taskIds } = markerProblems(a.md);
  if (!withB) {
    evidence(label, { titlesA: titles(sectionOf(a.md)), problems, badge: a.badge, recovery: a.recovery });
    expect(problems).toEqual([]);
    expect(a.badge).toBe("CURRENT");
    expect(a.recovery).toEqual([]);
    expect(a.tasks).toEqual(taskIds);
    expect(nesting(a)).toEqual([]);
    return { ...a, titles: titles(sectionOf(a.md)) };
  }
  let b = null;
  try {
    b = await browser.waitUntil(
      async () => {
        const now = await stateA(ctx.R);
        return jsonB(ctx.b, ctx.R) === canonical(JSON.parse(now.json)) ? now : false;
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
    nestingMismatches: nesting(a),
  });
  if (problems.length > 0 || b === null) evidence(`${label} note`, { md: a.md.split("\n") });
  if (b === null) {
    const now = await stateA(ctx.R);
    evidence(`${label} model diff`, { diff: jsonDiff(JSON.parse(now.json), JSON.parse(jsonB(ctx.b, ctx.R))) });
  }
  expect(problems).toEqual([]);
  expect(a.badge).toBe("CURRENT");
  expect(a.recovery).toEqual([]);
  expect(a.tasks).toEqual(taskIds);
  expect(nesting(a)).toEqual([]);
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
      // The Share section modal (another modal may still be open).
      let share;
      for (let i = 0; i < 80 && share === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        share = [...document.querySelectorAll(".modal-container .modal button")].find((x) => x.textContent === "Share");
      }
      share.click();
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
  const link = await inviteFromA(title);
  const bFile = `B-${file}`;
  b.files.set(bFile, ["# B", "", "Insert below.", ""].join("\n"));
  await b.joinAndInsert(link, bFile, 3);
  return { R, bFile };
}

/** A invites to the section titled `title` (Read + write or Read only) with its own UI; the link. */
export async function inviteFromA(title, access = "Read + write") {
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
  await pick(access);
  return inA(async () => {
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
}

/** A removes a member's access from the section card of the active note ("Remove access…", then confirmed). */
export async function removeAccessFromA() {
  await inA(({ app }) => app.commands.executeCommandById("shared-tasks:open-section-details"));
  const removing = await inA(async () => {
    let row;
    for (let i = 0; i < 200 && row === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access…");
    }
    if (row === undefined) return { error: [...document.querySelectorAll(".modal")].map((m) => m.textContent).join(" | ").slice(0, 600) };
    row.click();
    let confirm;
    for (let i = 0; i < 100 && confirm === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      confirm = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "Remove access");
    }
    confirm.click();
    await new Promise((r) => setTimeout(r, 1500));
    const notices = [...document.querySelectorAll(".notice")].map((n) => n.textContent);
    return { notices };
  });
  await closeModals("remove access");
  if (removing.error !== undefined) throw new Error(`no Remove access…: ${removing.error}`);
  return removing;
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

/** A's journaled intents from now on (the batches its passes commit): read them with opsA(). */
export const recordOps = () =>
  inA(({ app }) => {
    const ls = app.plugins.plugins["shared-tasks"].runtime.localState;
    window.__lfcpOps = [];
    if (ls.__recorded) return;
    ls.__recorded = true;
    const put = ls.put.bind(ls);
    ls.put = (key, value) => {
      if (key.startsWith("section-op:") && Array.isArray(value?.intents) && window.__lfcpOps !== undefined)
        window.__lfcpOps.push({
          phase: value.phase,
          intents: value.intents.map((i) => ({ intent: i.intent, id: i.id ?? i.task?.id ?? null })),
        });
      return put(key, value);
    };
  });
/** The intents recorded since recordOps(), once each (a batch is journaled in several phases). */
export const opsA = async () => {
  const all = (await inA(() => window.__lfcpOps ?? [])).flatMap((o) => o.intents.map((i) => `${i.intent}:${i.id}`));
  return [...new Set(all)];
};

/**
 * B's network, switchable (this process's WebSocket, which B's runtime takes
 * at each connection; A, in Obsidian, keeps its own): off() closes B's
 * sockets and points new ones at a closed port; on() lets them through.
 * Install before B starts.
 */
export function installNetSwitch() {
  const Real = globalThis.WebSocket;
  const open = new Set();
  let offline = false;
  class Switched extends Real {
    constructor(url, protocols) {
      super(offline ? "ws://127.0.0.1:9/v1/ws" : url, protocols);
      open.add(this);
      this.addEventListener("close", () => open.delete(this));
    }
  }
  globalThis.WebSocket = Switched;
  return {
    off() {
      offline = true;
      for (const s of open) s.close();
    },
    on() {
      offline = false;
    },
    restore() {
      globalThis.WebSocket = Real;
    },
  };
}
