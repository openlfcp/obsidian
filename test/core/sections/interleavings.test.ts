// Random interleavings of what a user does in a shared section and what the
// host does with it, on the real section replica, two vaults, the typing
// coalescer on a fake clock (the owner's checks of 0.4.0-beta.6 to beta.8:
// text sent twice, older text rendered over newer typing). Per step: Enter
// (a new Task, its title typed), a title typed, deleted or replaced at once
// (a composition's end), the paragraph's Text typed, deleted or replaced, the
// coalescer's timer (sometimes while a pass runs), a composition window (no
// pass until its end, then possibly abandoned), the peer editing another
// Task, the network coming back. Each pass is written, or abandoned as the
// host abandons it (the user typed meanwhile, a composition opened).
//
// Moves too (the owner's check of 0.4.0-beta.9, step 6): the user's own
// Tasks cut with their ref lines and pasted elsewhere, one place or more, in
// one pass or across passes (the cut and the paste each with the hints the
// editor collects: removed bindings, the cut, the inserted bindings); and
// the shared Task "Alpha" moved by both vaults. A move of the same node on
// both sides since they last synced, to different places, yields a
// PLACEMENT_CONFLICT on both (then resolved, as "Review conflicts" does).
//
// And the editor's other moves (the owner's checks of 0.4.0-beta.10): Move
// line, a drag, a Task cut without its trailing newline and pasted at the
// start of another Task's line, Tab then Shift+Tab, as line-moves.ts turns
// them into moves of whole Tasks, each with the hint the editor collects.
//
// After every written pass, the note shows exactly what the user typed last:
// never older text, and the user's own Tasks in the order they left them. In
// the end the model and the peer have it too. The PR run uses 40 seeds;
// LFCP_PROPERTY_SEEDS=500 runs more.

import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  indentWithNode,
  moveNodeLines,
  pasteOnOwnLines,
} from "../../../src/core/sections/line-moves";
import { editHints, pluginEdit } from "../../../src/obsidian/section-editor";
import {
  lines,
  placementConflict,
  reconnect,
  twoVaults,
  type Vault,
} from "../../support/section-vaults";

const SEEDS = Number(process.env.LFCP_PROPERTY_SEEDS ?? 40);
/** The first seed (a long sweep runs in ranges: LFCP_PROPERTY_FROM=1001 LFCP_PROPERTY_SEEDS=2000). */
const FROM = Number(process.env.LFCP_PROPERTY_FROM ?? 1);
/** Concurrent moves of the same node checked, over all seeds: the invariant must be exercised. */
let concurrentMoves = 0;
/** The editor's other moves run, over all seeds: each must be exercised. */
const gestures = { "move line": 0, drop: 0, "glued paste": 0, indent: 0, "non-user": 0 };
const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "Clean paragraph."];
const WORDS = ["draft", "テスト", "仕事", "plan", "かみ", "x"];
const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const TASK = /^\s*- \[ \] (.*)$/;
/** The shared Tasks of BODY ("Alpha" with the peer's suffix): they move only among themselves. */
const SHARED = /^\s*- \[ \] (Alpha|Beta|Gamma)( |$)/;
const isOwn = (l: string) => TASK.test(l) && !SHARED.test(l);
/** The titles of the Task lines this vault's user made (all but BODY's), in note order. */
const ownTasks = (md: string) =>
  lines(md).flatMap((l) => {
    const m = TASK.exec(l);
    return m === null || SHARED.test(l) ? [] : [m[1] ?? ""];
  });
/** The bound Task IDs in `ls` (their ref lines). */
const idsIn = (ls: readonly string[]) =>
  ls.flatMap((l) => {
    const m = /#task:([0-9a-f-]{36})/.exec(l);
    return m === null ? [] : [m[1] as string];
  });
/** The lines [from, to) of the Task at line `at`: its line, its ref line, its nested lines. */
function blockAt(L: readonly string[], at: number): [number, number] {
  let to = at + 1;
  while (to < L.length && /^\s+\S/.test(L[to] ?? "")) to++;
  return [at, to];
}
/** The line of the k-th own Task. */
const ownLine = (L: readonly string[], k: number) => {
  let seen = -1;
  return L.findIndex((l) => isOwn(l) && ++seen === k);
};
/** Where a block goes before the k-th own Task, or after the last Task's block (k = count). */
function insertAt(L: readonly string[], k: number): number {
  const at = ownLine(L, k);
  if (at >= 0) return at;
  let last = -1;
  L.forEach((l, i) => {
    if (TASK.test(l)) last = i;
  });
  return blockAt(L, last)[1];
}
const paragraph = (md: string) => {
  const L = lines(md);
  const at = L.findIndex((l) => l.startsWith("<!-- lfcp-node: paragraph:"));
  return L[at + 1] ?? "";
};
const alpha = (md: string) => lines(md).find((l) => /^- \[ \] Alpha/.test(l)) ?? "";

/** `md` with the k-th own Task's title set. */
function setTitle(md: string, k: number, title: string): string {
  const L = lines(md);
  const at = ownLine(L, k);
  if (at < 0) throw new Error(`no own Task ${k}`);
  L[at] = `- [ ] ${title}`;
  return L.join("\n");
}
/** `md` without the k-th own Task's block, and the block. */
function cutOwn(md: string, k: number): { md: string; block: string[] } {
  const L = lines(md);
  const [from, to] = blockAt(L, ownLine(L, k));
  return { md: [...L.slice(0, from), ...L.slice(to)].join("\n"), block: L.slice(from, to) };
}
/** `md` with `block` pasted before the k-th own Task (k = count: after the last Task). */
function pasteOwn(md: string, k: number, block: readonly string[]): string {
  const L = lines(md);
  const at = insertAt(L, k);
  return [...L.slice(0, at), ...block, ...L.slice(at)].join("\n");
}
/** `md` with "Alpha" moved to place `p` among the two other shared Tasks (0: first). */
function moveAlpha(md: string, p: number): string {
  const L = lines(md);
  const [from, to] = blockAt(
    L,
    L.findIndex((l) => /^- \[ \] Alpha( |$)/.test(l)),
  );
  const block = L.slice(from, to);
  const rest = [...L.slice(0, from), ...L.slice(to)];
  const shared = rest.flatMap((l, i) => (SHARED.test(l) ? [i] : []));
  const at = p === 0 ? (shared[0] as number) : blockAt(rest, shared[p - 1] as number)[1];
  return [...rest.slice(0, at), ...block, ...rest.slice(at)].join("\n");
}
/** Enter after the last Task's block, and `title` typed. */
function enter(md: string, title: string): string {
  const L = lines(md);
  let last = -1;
  L.forEach((l, i) => {
    if (TASK.test(l)) last = i;
  });
  let end = last + 1;
  while (end < L.length && /^\s+\S/.test(L[end] ?? "")) end++;
  L.splice(end, 0, `- [ ] ${title}`);
  return L.join("\n");
}
/** The offset of line `n`. */
const offsetOf = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

function setParagraph(md: string, text: string): string {
  const L = lines(md);
  const at = L.findIndex((l) => l.startsWith("<!-- lfcp-node: paragraph:"));
  L[at + 1] = text;
  return L.join("\n");
}

async function run(seed: number) {
  const r = random(seed);
  const trace = (what: string) => {
    if (process.env.LFCP_PROPERTY_TRACE === String(seed))
      process.stderr.write(
        `\nTRACE ${what} intended=${JSON.stringify(titles)} note=${JSON.stringify(ownTasks(md))}`,
      );
  };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
  const clock = { now: 0 };
  const { a, b } = await twoVaults(BODY, undefined, { now: () => clock.now });
  let md = a.note();
  let titles: string[] = [];
  let para = paragraph(md);
  let alphaB = "Alpha";
  let bmd = b.note();
  // The editor's hints for A's next pass (section-editor.ts): bindings removed and
  // inserted since the last pass, re-added when a pass is abandoned; the last cut.
  let deletedIds = new Set<string>();
  let inserted = new Set<string>();
  let cutIds = new Set<string>();
  /** A cut not pasted yet: its block and its title. */
  let clip: { block: string[]; title: string } | null = null;
  const hints = () => {
    const h = { deletedIds, inserted, cut: cutIds };
    deletedIds = new Set();
    inserted = new Set();
    return h;
  };
  /** Alpha moved in A (to place `pa`) and in B (to `pb`) while offline, then the network back. */
  const bothMoveAlpha = async (pa: number, pb: number) => {
    const id = new Set([alphaId()]);
    md = moveAlpha(md, pa);
    for (const i of id) {
      deletedIds.add(i);
      inserted.add(i);
    }
    cutIds = id;
    await passA("written", r() < 0.2);
    await b.pass(moveAlpha(b.note(), pb), { deletedIds: id, cut: id, inserted: id });
    await online();
    expect(ownTasks(md)).toEqual(titles);
  };
  /** An edit that is not the user's, as `kind` marks it: its hints go through the editor's own rule. */
  const nonUser = (next: string, kind: "set" | "plugin" | "none") => {
    const tr = EditorState.create({ doc: md }).update({
      changes: { from: 0, to: md.length, insert: next },
      ...(kind === "set" ? { userEvent: "set" } : {}),
      ...(kind === "plugin" ? { annotations: pluginEdit.of(true) } : {}),
    });
    const h = editHints(tr);
    for (const id of h.removed) deletedIds.add(id);
    for (const id of h.inserted) inserted.add(id);
    md = next;
  };
  const unspent = (h: { deletedIds: Set<string>; inserted: Set<string> }) => {
    for (const id of h.deletedIds) deletedIds.add(id);
    for (const id of h.inserted) inserted.add(id);
  };
  const alphaId = () =>
    idsIn([
      lines(a.note())[lines(a.note()).findIndex((l) => /^- \[ \] Alpha/.test(l)) + 1] ?? "",
    ])[0] as string;
  const visible = (v: Vault) => v.model()?.order[""] ?? [];
  const sharedIds = idsIn(lines(a.note()).filter((l) => l.includes("lfcp-ref:")));
  /** Alpha's place among the shared Tasks, as `v`'s model has it: the one before it (null: first). */
  const alphaPlace = (v: Vault) => {
    const o = visible(v).filter((id) => sharedIds.includes(id));
    const at = o.indexOf(alphaId());
    return at <= 0 ? null : (o[at - 1] as string);
  };
  let synced = alphaPlace(a);

  /** The network comes back; each vault's passes run on what its editor shows now. */
  const online = async () => {
    // Moved on both sides since they last synced, to different places: concurrent.
    const [pa, pb] = [alphaPlace(a), alphaPlace(b)];
    const concurrent = pa !== synced && pb !== synced && pa !== pb;
    const exchange = () => {
      for (const [res, ra] of a.replicas) {
        const rb = b.replicas.get(res);
        if (rb === undefined) continue;
        const fromA = ra.changes();
        ra.receiveChanges(rb.changes());
        rb.receiveChanges(fromA);
      }
    };
    exchange();
    for (let i = 0; i < 2; i++) {
      await a.pass(md, hints());
      md = a.note();
      await b.pass(b.note());
    }
    const alpha = alphaId();
    if (concurrent) {
      concurrentMoves++;
      trace(`concurrent Alpha moves ${pa} / ${pb}`);
      expect(placementConflict(a, alpha)).toBe(true);
      expect(placementConflict(b, alpha)).toBe(true);
    }
    // Resolved as "Review conflicts…" does: a place chosen in A, then synced.
    const item = a.recovery().find((i) => i.kind === "placement");
    if (item !== undefined && "choices" in item) {
      const choice = item.choices[0];
      if (choice === undefined) throw new Error("no choice");
      expect((await a.choose(item, choice)).applied).toBe(true);
      exchange();
      for (let i = 0; i < 2; i++) {
        await a.pass(md, hints());
        md = a.note();
        await b.pass(b.note());
      }
    }
    // What A's passes just committed reaches B too: both synced.
    exchange();
    await b.pass(b.note());
    expect(placementConflict(a, alpha)).toBe(false);
    expect(placementConflict(b, alpha)).toBe(false);
    synced = alphaPlace(a);
    expect(alphaPlace(b)).toBe(synced);
    bmd = b.note();
  };
  const tick = async (v: Vault, ms: number) => {
    clock.now += ms;
    await v.port.tick(clock.now);
    await v.flushed();
  };
  /** A pass of A: written (the note is what it leaves), abandoned, or none yet. */
  const passA = async (mode: "written" | "abandoned" | "none", duringTick: boolean) => {
    if (mode === "none") return;
    let ticking: Promise<void> | null = null;
    const waiting = a.port.waiting.bind(a.port);
    if (duringTick)
      a.port.waiting = (res: string, key: string) => {
        const w = waiting(res, key);
        if (ticking === null) ticking = a.port.tick(clock.now + 3000);
        return w;
      };
    const h = hints();
    if (mode === "abandoned") {
      const p = await a.engine.pass("Plan.md", md, { ...ctx, ...h });
      a.engine.abandoned(p);
      unspent(h);
    } else {
      const r = await a.pass(md, h);
      // Nothing the user did here is held back (a glued paste among them).
      expect(r?.skipped).not.toBe("blocked");
      expect(r?.lost ?? []).toEqual([]);
      md = a.note();
    }
    trace(`pass ${mode}${duringTick ? " +tick" : ""}`);
    a.port.waiting = waiting;
    await ticking;
    await a.flushed();
    if (mode === "written") {
      // Never older text: the note shows what the user typed last.
      expect(ownTasks(md)).toEqual(titles);
      expect(paragraph(md)).toBe(para);
    }
  };
  const mode = (): "written" | "abandoned" | "none" => {
    const x = r();
    return x < 0.55 ? "written" : x < 0.85 ? "abandoned" : "none";
  };

  for (let step = 0; step < 24; step++) {
    const x = r();
    if (x < 0.12 || titles.length === 0) {
      // Enter, then a title typed.
      const title = pick(WORDS);
      titles = [...titles, title];
      md = enter(md, title);
    } else if (x < 0.4) {
      const k = titles.length - 1 - Math.floor(r() * Math.min(2, titles.length));
      const now = titles[k] ?? "";
      const y = r();
      const next =
        y < 0.35
          ? now + pick(["a", "b", "c", "日"])
          : y < 0.7
            ? now.slice(0, Math.max(0, now.length - 1 - Math.floor(r() * 5)))
            : pick(WORDS);
      titles = titles.map((t, i) => (i === k ? next : t));
      md = setTitle(md, k, next);
    } else if (x < 0.62) {
      const y = r();
      para =
        y < 0.4
          ? para + pick(["a", "b", "本", " "])
          : y < 0.7
            ? para.slice(0, Math.max(0, para.length - 1 - Math.floor(r() * 3)))
            : `Clean paragraph. ${pick(WORDS)}`;
      md = setParagraph(md, para);
    } else if (x < 0.7) {
      await tick(a, Math.floor(r() * 2500));
      continue;
    } else if (x < 0.74) {
      // Not the user's (the owner's trace of 0.4.0-beta.10): the note
      // reloaded from disk, the plugin's own edit, another plugin's rewrite of
      // the whole note, or Obsidian (or the Tasks plugin) checking "Beta"
      // with its ✅ date and unchecking it. Hints as the editor collects them.
      const y = r();
      if (y < 0.6) {
        nonUser(md, y < 0.2 ? "set" : y < 0.4 ? "plugin" : "none");
        trace("non-user rewrite");
        gestures["non-user"]++;
        // The note is what was last reconciled: no pass runs (the coordinator
        // skips it); whatever was noted waits for the next one, here often
        // the user's move of Alpha one place (the owner's step 6) against B's.
        if (r() < 0.5) await bothMoveAlpha(r() < 0.7 ? 1 : Math.floor(r() * 3), r() < 0.5 ? 2 : 0);
        continue;
      } else {
        nonUser(md.replace(/^- \[ \] Beta$/m, "- [x] Beta ✅ 2026-10-13"), "none");
        await passA(mode(), r() < 0.2);
        nonUser(md.replace(/^- \[x\] Beta ✅ 2026-10-13$/m, "- [ ] Beta"), "none");
        trace("non-user checkbox");
      }
      gestures["non-user"]++;
    } else if (x < 0.8) {
      // A composition: edits without a pass until its end.
      const k = titles.length - 1;
      for (const w of ["ｔ", "て", "てす"]) md = setTitle(md, k, w);
      const word = pick(WORDS);
      titles = titles.map((t, i) => (i === k ? word : t));
      md = setTitle(md, k, word);
    } else if (x < 0.84) {
      // The peer edits another Task.
      alphaB = `Alpha ${pick(WORDS)}`;
      bmd = b.note().replace(/^- \[ \] Alpha.*$/m, `- [ ] ${alphaB}`);
      await b.pass(bmd);
      await tick(b, 3000);
      continue;
    } else if (x < 0.89) {
      // The shared Task "Alpha" moved by cut and paste, in one vault or the other,
      // or in both while offline (A's move saved, then the network back).
      const id = new Set([alphaId()]);
      if (r() < 0.6) {
        await bothMoveAlpha(Math.floor(r() * 3), Math.floor(r() * 3));
        continue;
      }
      const v = r() < 0.5 ? a : b;
      const moved = moveAlpha(v === a ? md : b.note(), Math.floor(r() * 3));
      if (v === a) {
        md = moved;
        for (const i of id) deletedIds.add(i), inserted.add(i);
        cutIds = id;
      } else {
        await b.pass(moved, { deletedIds: id, cut: id, inserted: id });
        continue;
      }
    } else if (x < 0.94 && clip === null && titles.length > 0 && r() < 0.5) {
      // The editor's other moves of an own Task (line-moves.ts, the owner's
      // checks of 0.4.0-beta.10): Move line, a drag (a cut and a paste in one
      // transaction, not a cut), the cut without its trailing newline pasted
      // at a line's start, Tab then Shift+Tab.
      const k = Math.floor(r() * titles.length);
      const at = ownLine(lines(md), k);
      const y = r();
      if (y < 0.3) {
        const move = moveNodeLines(md, at, at, r() < 0.5 ? "up" : "down");
        if (move === null) throw new Error("own Task outside the section");
        md = applyChanges(md, move.changes);
        for (const id of move.moved) inserted.add(id);
        trace(`move line own ${k}`);
        gestures["move line"]++;
      } else if (y < 0.55) {
        const { md: without, block } = cutOwn(md, k);
        const ids = idsIn(block);
        const title = titles[k] ?? "";
        titles = titles.filter((_, i) => i !== k);
        const to = Math.floor(r() * (titles.length + 1));
        md = pasteOwn(without, to, block);
        titles = [...titles.slice(0, to), title, ...titles.slice(to)];
        for (const id of ids) {
          deletedIds.add(id);
          inserted.add(id);
        }
        trace(`drop own ${k} -> ${to}`);
        gestures.drop++;
      } else if (y < 0.8 && blockAt(lines(md), at)[1] - at > 1) {
        // Cut from the Task's line start to the end of its last line (its
        // ref line: a bound Task; an unbound one pasted so is just the
        // user's own text run together): an empty line stays.
        const L = lines(md);
        const [from, to] = blockAt(L, at);
        const start = offsetOf(md, from);
        const end = offsetOf(md, to) - 1;
        const text = md.slice(start, end);
        const ids = idsIn(L.slice(from, to));
        const without = md.slice(0, start) + md.slice(end);
        const title = titles[k] ?? "";
        titles = titles.filter((_, i) => i !== k);
        for (const id of ids) deletedIds.add(id);
        cutIds = new Set(ids);
        // Pasted at the start of another own Task's line (or after the last Task's block).
        const dest = Math.floor(r() * (titles.length + 1));
        const line = insertAt(lines(without), dest);
        const pos = offsetOf(without, line);
        const change = { from: pos, to: pos, insert: text };
        md = applyChanges(without, [pasteOnOwnLines(without, change) ?? change]);
        titles = [...titles.slice(0, dest), title, ...titles.slice(dest)];
        for (const id of ids) inserted.add(id);
        trace(`glued paste own ${k} -> ${dest}`);
        gestures["glued paste"]++;
      } else if (
        !TASK.test(lines(md)[at - 1] ?? "") &&
        !(lines(md)[at - 1] ?? "").includes("lfcp-ref:")
      ) {
        // Tab with no Task before it would make it code (four columns after a
        // paragraph): not a nesting, so not this gesture.
        trace(`no Tab for own ${k}`);
      } else {
        // Tab (it becomes the child of the Task before it), a pass, then Shift+Tab.
        // (A Task not bound yet has no other lines: the editor's change stands.)
        const pos = offsetOf(md, at);
        const tab = { from: pos, to: pos, insert: "\t" };
        const before = md;
        md = applyChanges(md, indentWithNode(md, [tab]) ?? [tab]);
        await passA(mode(), r() < 0.2);
        // Its line again: the pass may have bound a Task above it (a new ref line).
        const tabbed = lines(md).findIndex((l) => l.startsWith("\t- [ ]"));
        const dedent = { from: offsetOf(md, tabbed), to: offsetOf(md, tabbed) + 1, insert: "" };
        md = applyChanges(md, indentWithNode(md, [dedent]) ?? [dedent]);
        // Back where it was (a pass in between may have bound it: its ref line is new).
        expect(ownTasks(md)).toEqual(ownTasks(before));
        trace(`indent own ${k}`);
        gestures.indent++;
      }
      // Whatever the gesture, the note shows the user's own Tasks as they left them.
      titles = ownTasks(md);
    } else if (x < 0.94 && clip === null && titles.length > 0) {
      // An own Task cut and pasted elsewhere: in this pass, or the paste later.
      const k = Math.floor(r() * titles.length);
      const { md: without, block } = cutOwn(md, k);
      const ids = idsIn(block);
      const title = titles[k] ?? "";
      titles = titles.filter((_, i) => i !== k);
      for (const id of ids) deletedIds.add(id);
      cutIds = new Set(ids);
      if (r() < 0.5) {
        // Pasted at once: one place up or down (adjacent), or anywhere.
        const to =
          r() < 0.5
            ? Math.max(0, Math.min(titles.length, k + (r() < 0.5 ? -1 : 1)))
            : Math.floor(r() * (titles.length + 1));
        md = pasteOwn(without, to, block);
        titles = [...titles.slice(0, to), title, ...titles.slice(to)];
        for (const id of ids) inserted.add(id);
        trace(`move own ${k} -> ${to}`);
      } else {
        md = without;
        clip = { block, title };
        trace(`cut own ${k}`);
      }
    } else if (x < 0.94 && clip !== null) {
      // The cut pasted (a later pass).
      const to = Math.floor(r() * (titles.length + 1));
      md = pasteOwn(md, to, clip.block);
      titles = [...titles.slice(0, to), clip.title, ...titles.slice(to)];
      for (const id of idsIn(clip.block)) inserted.add(id);
      clip = null;
      trace(`paste own -> ${to}`);
    } else {
      await online();
      expect(ownTasks(md)).toEqual(titles);
      expect(paragraph(md)).toBe(para);
      continue;
    }
    await passA(mode(), r() < 0.2);
  }
  // Settle: a cut still on the clipboard is pasted at the end; passes, the timer, the network.
  if (clip !== null) {
    md = pasteOwn(md, titles.length, clip.block);
    titles = [...titles, clip.title];
    for (const id of idsIn(clip.block)) inserted.add(id);
    clip = null;
  }
  for (let i = 0; i < 3; i++) {
    await a.pass(md, hints());
    md = a.note();
    await tick(a, 3000);
    await tick(b, 3000);
    await online();
  }
  expect(ownTasks(md)).toEqual(titles);
  expect(paragraph(md)).toBe(para);
  // A Task line that never had a title is never shared (MS27), so B shows the
  // titled ones; a shared Task whose title was deleted shows empty on both.
  const titled = (ts: readonly string[]) => ts.filter((t) => t !== "");
  expect(titled(ownTasks(b.note()))).toEqual(titled(titles));
  expect(paragraph(b.note())).toBe(para);
  expect(alpha(md)).toBe(`- [ ] ${alphaB}`);
}

describe(`interleavings never bring older text back (${SEEDS} seeds)`, () => {
  // The owner's log on 0.4.0-beta.8, Latin only: Enter, "draft" typed and
  // synced, its ref written; Backspace ×5 within a second; 400 ms later the
  // plugin wrote "draft" back.
  it("a new Task typed, synced, its title deleted at once: it stays deleted", async () => {
    const clock = { now: 0 };
    const { a, b } = await twoVaults(BODY, undefined, { now: () => clock.now });
    let md = enter(a.note(), "draft");
    // Typed with passes the host abandons (the user kept typing), then written.
    const half = setTitle(md, 0, "dra");
    const p = await a.engine.pass("Plan.md", half, ctx);
    a.engine.abandoned(p);
    await a.pass(md);
    md = a.note();
    await reconnect(a, b);
    md = a.note();
    expect(ownTasks(b.note())).toEqual(["draft"]);
    // Backspace ×5: one pass written 400 ms after the last.
    md = setTitle(md, 0, "");
    await a.pass(md);
    md = a.note();
    expect(ownTasks(md)).toEqual([""]);
    clock.now += 3000;
    await a.port.tick(clock.now);
    await a.pass(md);
    md = a.note();
    expect(ownTasks(md)).toEqual([""]);
    await reconnect(a, b);
    expect(ownTasks(a.note())).toEqual([""]);
    expect(ownTasks(b.note())).toEqual([""]);
  });

  for (let seed = FROM; seed <= SEEDS; seed++) it(`seed ${seed}`, () => run(seed));

  it("the seeds exercised concurrent moves of one node, and every editor move", () => {
    expect(concurrentMoves).toBeGreaterThan(0);
    for (const n of Object.values(gestures)) expect(n).toBeGreaterThan(0);
  });
});
