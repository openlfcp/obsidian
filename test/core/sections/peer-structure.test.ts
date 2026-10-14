// Both vaults change the section's structure at once (coverage gaps 1 and
// 3 after the 5000-seed sweep of 0.4.0-beta.12): each creates, retitles,
// deletes, cuts and pastes (in one pass or across passes), moves by Move
// line, pastes glued to the next line and nests (Tab, then Shift+Tab) Tasks
// of its own, while the other does the same, offline and online. Vault A
// sometimes closes its note: its passes then run as a closed note's do (the
// file route, with what its editor noted before it closed), while B keeps
// working and changes arrive.
//
// After every pass of either vault: the note is not damaged (one start and
// one end marker, every binding comment whole and alone on its line, no
// stray marker text, no ID twice), nothing is held back, no binding is
// lost, and the vault's own Tasks show as its user left them. After the
// network comes back: both models are the same, both notes show the same
// Tasks in the same order, and every Task either side kept is there once.
// The PR run uses 20 seeds; LFCP_PROPERTY_SEEDS=5000 runs more, in ranges
// with LFCP_PROPERTY_FROM.

import { describe, expect, it } from "vitest";
import { markdownState } from "../../../src/core/sections/base";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  indentWithNode,
  moveNodeLines,
  pasteOnOwnLines,
} from "../../../src/core/sections/line-moves";
import { parseSections } from "../../../src/core/sections/parser";
import type { RecoveryChoice, RecoveryItem } from "../../../src/core/sections/recovery";
import { freshHints } from "../../../src/obsidian/section-editor";
import { lines, twoVaults, type Vault } from "../../support/section-vaults";

const SEEDS = Number(process.env.LFCP_PROPERTY_SEEDS ?? 20);
const FROM = Number(process.env.LFCP_PROPERTY_FROM ?? 1);
const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "A paragraph."];
const WORDS = ["draft", "テスト", "仕事", "plan", "かみ", "x"];

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const TASK = /^(\s*)- \[[ x]\] (.*)$/;
/** A Task line of `side` ("a…" or "b…" titles). */
const ownOf = (side: "a" | "b") => (l: string) => {
  const m = TASK.exec(l);
  return m !== null && new RegExp(`^${side}\\d+( |$)`).test(m[2] ?? "");
};
/** The titles of the Task lines of `side`, in note order. */
const titlesOf = (md: string, side: "a" | "b") =>
  lines(md).flatMap((l) => (ownOf(side)(l) ? [TASK.exec(l)?.[2] ?? ""] : []));
/** The lines [from, to) of the Task at line `at`: its line and the more indented lines under it. */
function blockAt(L: readonly string[], at: number): [number, number] {
  const indent = /^\s*/.exec(L[at] ?? "")?.[0].length ?? 0;
  let to = at + 1;
  while (
    to < L.length &&
    /^\s+\S/.test(L[to] ?? "") &&
    (/^\s*/.exec(L[to] ?? "")?.[0].length ?? 0) > indent
  )
    to++;
  return [at, to];
}
const idsIn = (ls: readonly string[]) =>
  ls.flatMap((l) => {
    const m = /(?:#task:|lfcp-node: [a-z]+:)([0-9a-f-]{36})/.exec(l);
    return m === null ? [] : [m[1] as string];
  });
const offsetOf = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

/** The Task lines of a note with their IDs (the ref on the next line; "" while unbound). */
function tasksOf(md: string): { title: string; id: string }[] {
  const L = lines(md);
  return L.flatMap((l, i) => {
    const m = TASK.exec(l);
    if (m === null) return [];
    const ref = /#task:([0-9a-f-]{36})/.exec(L[i + 1] ?? "");
    return [{ title: m[2] ?? "", id: ref?.[1] ?? "" }];
  });
}

type Model = ReturnType<Vault["model"]>;
/** The nodes the model shows: active, under shown parents, from the section's root down. */
function shownIds(m: Model): Set<string> {
  const out = new Set<string>();
  const walk = (parent: string) => {
    for (const id of m?.order[parent] ?? []) {
      if (m?.nodes[id]?.lifecycle !== "active") continue;
      out.add(id);
      walk(id);
    }
  };
  walk("");
  return out;
}
/** The titles a note should show for the shown Tasks, in the model's depth-first order. */
function modelTitles(m: Model, shown: readonly { title: string; id: string }[]): string[] {
  const byId = new Map(shown.map((t) => [t.id, t.title]));
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const id of m?.order[parent] ?? []) {
      if (m?.nodes[id]?.lifecycle !== "active") continue;
      const t = byId.get(id);
      if (t !== undefined) out.push(t);
      walk(id);
    }
  };
  walk("");
  return out;
}

/**
 * Each node's parent as the note shows it (the section parser's): the
 * nesting a flat list of titles does not see (a Task nested under the wrong
 * one reads the same in order; the owner's check of 0.4.0-beta.14 step 4).
 */
function noteParents(md: string): Map<string, string | null> {
  const section = parseSections(md).sections[0];
  if (section === undefined) return new Map();
  const { state } = markdownState(md, section);
  return new Map(Object.entries(state.nodes).map(([id, n]) => [id, n.parent]));
}

/** What is wrong with a note's section, or null (the damage checks). */
function damage(md: string): string | null {
  const L = lines(md);
  const starts = L.flatMap((l, i) => (/^<!-- lfcp-section: \S+ -->$/.test(l) ? [i] : []));
  const ends = L.flatMap((l, i) => (/^<!-- \/lfcp-section: \S+ -->$/.test(l) ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || (starts[0] as number) > (ends[0] as number))
    return `section markers: starts ${JSON.stringify(starts)}, ends ${JSON.stringify(ends)}`;
  const ids = new Map<string, number>();
  for (const [i, l] of L.entries()) {
    const opens = (l.match(/<!--/g) ?? []).length;
    const closes = (l.match(/-->/g) ?? []).length;
    if (opens !== closes) return `line ${i + 1} has stray marker text: ${JSON.stringify(l)}`;
    if (/lfcp-(ref|node|section)/.test(l) && !/^\s*<!--[^>]*-->$/.test(l))
      return `line ${i + 1} has a binding not alone on its line: ${JSON.stringify(l)}`;
    for (const id of idsIn([l])) {
      const seen = ids.get(id);
      if (seen !== undefined) return `ID ${id} on lines ${seen + 1} and ${i + 1}`;
      ids.set(id, i);
    }
  }
  return null;
}

/** One vault and what its user is doing. */
interface Side {
  readonly name: "a" | "b";
  readonly v: Vault;
  md: string;
  /** The titles of this side's own Tasks, in the order its user left them. */
  mine: string[];
  next: number;
  deletedIds: Set<string>;
  inserted: Set<string>;
  cut: Set<string>;
  /** A cut not pasted yet. */
  clip: string[] | null;
  /** A's note closed: no user edits, passes as a closed note's (no hints). */
  closed: boolean;
  /** Changes of the other vault received since this side's last written pass. */
  remote: boolean;
  /** What the last written pass found back in the note while deleted (the host lists it in Review conflicts). */
  reappeared: readonly string[];
}

async function run(seed: number) {
  const r = random(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
  const { a, b } = await twoVaults(BODY);
  const side = (name: "a" | "b", v: Vault): Side => ({
    name,
    v,
    md: v.note(),
    mine: [],
    next: 1,
    deletedIds: new Set(),
    inserted: new Set(),
    cut: new Set(),
    clip: null,
    closed: false,
    remote: false,
    reappeared: [],
  });
  const A = side("a", a);
  const B = side("b", b);
  const log: string[] = [];
  const trace = (s: Side, what: string) => {
    log.push(`${s.name}: ${what}`);
    if (process.env.LFCP_PROPERTY_TRACE === String(seed))
      process.stderr.write(`\nTRACE ${s.name}: ${what} mine=${JSON.stringify(s.mine)}`);
  };
  const fail = (what: string) => `${what}\n  after: ${log.slice(-12).join(" | ")}`;

  /** A pass of `s`: written, abandoned or none; the checks after a written one. */
  const pass = async (s: Side, mode: "written" | "abandoned" | "none") => {
    if (mode === "none") return;
    // A closed note's pass takes what its editor noted before it closed
    // (section-editor.ts PendingHints); no edit adds to it while closed.
    // As the editor gives them (section-editor.ts freshHints): a node noted
    // as removed that the note binds again (restored by a collaborator
    // meanwhile) is no longer removed.
    const h = {
      ...freshHints({ deletedIds: s.deletedIds, inserted: s.inserted }, s.md),
      cut: s.cut,
    };
    s.deletedIds = new Set();
    s.inserted = new Set();
    if (mode === "abandoned") {
      const p = await s.v.engine.pass("Plan.md", s.md, {
        caretLine: null,
        origin: "other",
        ...h,
      });
      s.v.engine.abandoned(p);
      for (const id of h.deletedIds) s.deletedIds.add(id);
      for (const id of h.inserted) s.inserted.add(id);
      trace(s, "pass abandoned");
      return;
    }
    const res = await s.v.pass(s.md, h);
    // As the editor: a batch not taken (refused and kept) leaves its hints for the next pass.
    for (const id of res?.unsent?.deletedIds ?? []) s.deletedIds.add(id);
    for (const id of res?.unsent?.inserted ?? []) s.inserted.add(id);
    s.md = s.v.note();
    s.reappeared = res?.reappeared ?? [];
    trace(s, `pass written${s.closed ? " (closed)" : ""}`);
    const d = damage(s.md);
    expect(d, fail(`${s.name}'s note damaged`)).toBeNull();
    if (res?.skipped === "blocked" && process.env.LFCP_PROPERTY_TRACE === String(seed))
      process.stderr.write(`\nHELD ${s.name}\n${s.md.replace(/lfcp1:[^#]*#/g, "")}\n`);
    expect(res?.skipped, fail(`${s.name}'s pass held`)).not.toBe("blocked");
    expect(res?.lost ?? [], fail(`${s.name}'s pass lost a binding`)).toEqual([]);
    // The user's own Tasks as they left them, unless remote changes came in
    // since (a restore, a Task following its moved anchor): then as shown.
    if (s.remote) s.mine = titlesOf(s.md, s.name);
    else expect(titlesOf(s.md, s.name), fail(`${s.name}'s own Tasks`)).toEqual(s.mine);
    s.remote = false;
  };
  const mode = (): "written" | "abandoned" | "none" => {
    const x = r();
    return x < 0.6 ? "written" : x < 0.85 ? "abandoned" : "none";
  };

  /** One gesture of `s` on its own Tasks (the user's edits, with the editor's hints). */
  const gesture = (s: Side) => {
    const L = lines(s.md);
    const own = L.flatMap((l, i) => (ownOf(s.name)(l) ? [i] : []));
    const x = r();
    // A cut whose Task came back meanwhile (a collaborator restored it in
    // Review conflicts): pasted, it would be a second copy, held with
    // "Duplicate as new" offered (§4.5, MS08). This user drops the cut.
    if (s.clip !== null && idsIn(s.clip).some((id) => s.md.includes(id))) {
      s.clip = null;
      trace(s, "cut dropped (its Task came back)");
    }
    if (s.clip !== null && x < 0.3) {
      // The cut pasted before a random Task of any side, or after the last Task.
      const tasks = L.flatMap((l, i) => (TASK.test(l) && !/^\s/.test(l) ? [i] : []));
      const at = r() < 0.3 || tasks.length === 0 ? null : pick(tasks);
      const end = at ?? blockAt(L, tasks.at(-1) ?? 0)[1];
      // At the top level, as the user means it: a Task cut from under
      // another keeps its indentation in the clip, and pasted after a blank
      // line that would be an indented code block, the Task gone (seed 655).
      const lead = /^[ \t]*/.exec(s.clip[0] ?? "")?.[0] ?? "";
      L.splice(
        end,
        0,
        ...s.clip.map((l) => (l.startsWith(lead) ? l.slice(lead.length) : l.trimStart())),
      );
      for (const id of idsIn(s.clip)) s.inserted.add(id);
      s.clip = null;
      s.md = L.join("\n");
      trace(s, `paste at ${end}`);
    } else if (own.length === 0 || x < 0.25) {
      // Enter after the last Task's block, a new title typed.
      const tasks = L.flatMap((l, i) => (TASK.test(l) && !/^\s/.test(l) ? [i] : []));
      const end = blockAt(L, tasks.at(-1) ?? 0)[1];
      L.splice(end, 0, `- [ ] ${s.name}${s.next++} ${pick(WORDS)}`);
      s.md = L.join("\n");
      trace(s, "create");
    } else {
      const at = pick(own);
      const [from, to] = blockAt(L, at);
      const ids = idsIn(L.slice(from, to));
      const y = r();
      if (y < 0.2) {
        L[at] = `${L[at]}${pick(["a", "b", "日"])}`;
        s.md = L.join("\n");
        trace(s, "retitle");
      } else if (y < 0.35) {
        L.splice(from, to - from);
        for (const id of ids) s.deletedIds.add(id);
        s.md = L.join("\n");
        trace(s, "delete");
      } else if (y < 0.5 && s.clip === null) {
        s.clip = L.splice(from, to - from);
        for (const id of ids) s.deletedIds.add(id);
        s.cut = new Set(ids);
        s.md = L.join("\n");
        trace(s, "cut");
      } else if (y < 0.65) {
        const move = moveNodeLines(s.md, at, at, r() < 0.5 ? "up" : "down");
        if (move !== null) {
          s.md = applyChanges(s.md, move.changes);
          for (const id of move.moved) s.inserted.add(id);
        }
        trace(s, "move line");
      } else if (y < 0.8 && to - from > 1 && /^- /.test(L[at] ?? "")) {
        // Cut without the trailing newline, pasted at the start of another Task's line.
        const text = s.md.slice(offsetOf(s.md, from), offsetOf(s.md, to) - 1);
        const without = s.md.slice(0, offsetOf(s.md, from)) + s.md.slice(offsetOf(s.md, to) - 1);
        for (const id of ids) {
          s.deletedIds.add(id);
          s.inserted.add(id);
        }
        s.cut = new Set(ids);
        const W = lines(without);
        const tasks = W.flatMap((l, i) => (TASK.test(l) && !/^\s/.test(l) ? [i] : []));
        const dest = pick(tasks.length > 0 ? tasks : [W.length - 1]);
        const pos = offsetOf(without, dest);
        const change = { from: pos, to: pos, insert: text };
        s.md = applyChanges(without, [pasteOnOwnLines(without, change) ?? change]);
        trace(s, "glued paste");
      } else if (
        /^- /.test(L[at] ?? "") &&
        (TASK.test(L[at - 1] ?? "") || (L[at - 1] ?? "").includes("lfcp-ref:"))
      ) {
        const pos = offsetOf(s.md, at);
        const tab = { from: pos, to: pos, insert: "\t" };
        s.md = applyChanges(s.md, indentWithNode(s.md, [tab]) ?? [tab]);
        trace(s, "tab");
      } else {
        // Shift+Tab of a nested own Task, if any.
        const nested = own.filter((i) => (L[i] ?? "").startsWith("\t"));
        if (nested.length > 0) {
          const n = pick(nested);
          const pos = offsetOf(s.md, n);
          const dedent = { from: pos, to: pos + 1, insert: "" };
          s.md = applyChanges(s.md, indentWithNode(s.md, [dedent]) ?? [dedent]);
          trace(s, "shift+tab");
        }
      }
    }
    s.mine = titlesOf(s.md, s.name);
  };

  /** The network: each vault receives the other's changes, then passes; until both settle. */
  const exchange = () => {
    A.remote = true;
    B.remote = true;
    for (const [res, ra] of a.replicas) {
      const rb = b.replicas.get(res);
      if (rb === undefined) continue;
      const fromA = ra.changes();
      ra.receiveChanges(rb.changes());
      rb.receiveChanges(fromA);
    }
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      exchange();
      await pass(A, "written");
      await pass(B, "written");
    }
    exchange();
    await pass(A, "written");
    await pass(B, "written");
  };
  /** The choice "Review conflicts…" gets here: restore what was edited under a deletion, keep, the first place or value. */
  const choiceFor = (item: RecoveryItem): RecoveryChoice | null => {
    switch (item.kind) {
      case "retained":
        return { restore: true };
      case "lifecycle":
        return { keep: true };
      case "placement":
        return item.choices[0] === undefined ? null : item.choices[0];
      case "cycle":
        return item.members[0] === undefined ? null : { move: item.members[0].nodeId };
      case "title":
      case "field":
        return item.values[0] === undefined ? null : { value: item.values[0] };
      case "reappeared":
      case "stale-work":
        return null;
    }
  };
  const online = async () => {
    await settle();
    // What needs attention is resolved in A (the structure waits for it: MS14).
    for (let round = 0; round < 6 && (a.model()?.problems.length ?? 0) > 0; round++) {
      const item = a.recovery().find((i) => choiceFor(i) !== null);
      if (item === undefined) break;
      const choice = choiceFor(item) as RecoveryChoice;
      trace(A, `resolve ${item.kind}`);
      await a.choose(item, choice);
      await settle();
    }
    // Converged: the same model, the same Tasks in the same order in both notes.
    const am = a.model();
    const bm = b.model();
    expect(am?.problems ?? [], fail("problems left after Review conflicts")).toEqual([]);
    expect(JSON.stringify(bm?.order), fail("models' order")).toBe(JSON.stringify(am?.order));
    expect(JSON.stringify(Object.keys(bm?.nodes ?? {}).sort()), fail("models' nodes")).toBe(
      JSON.stringify(Object.keys(am?.nodes ?? {}).sort()),
    );
    // Both notes show what the model shows, in its order. A note may keep
    // more: a Task the model hides (deleted, or under a deleted node) that
    // was edited there concurrently stays as local text (SSP §9, MS14), and
    // Review conflicts lists it.
    const visible = shownIds(am);
    for (const s of [A, B]) {
      const shown = tasksOf(s.md);
      expect(
        shown.filter((t) => visible.has(t.id)).map((t) => t.title),
        fail(`${s.name}'s note against the model`),
      ).toEqual(shown.filter((t) => visible.has(t.id)).length === 0 ? [] : modelTitles(am, shown));
      // And nested as the model nests them: every Task both show has the
      // model's parent in the note.
      const parents = noteParents(s.md);
      const nesting = shown
        .filter((t) => visible.has(t.id))
        .flatMap((t) => {
          const want = am?.nodes[t.id]?.parent ?? null;
          const got = parents.get(t.id);
          return got === want
            ? []
            : [`${t.title}: note ${got?.slice(-3)}, model ${want?.slice(-3)}`];
        });
      expect(nesting, fail(`${s.name}'s nesting against the model`)).toEqual([]);
      const kept = shown.filter((t) => !visible.has(t.id));
      if (kept.length > 0)
        // As the host lists them (sections-host.ts): the model's items and
        // what the note shows back while deleted.
        expect(
          s.v.recovery().length + s.reappeared.length,
          fail(`${s.name} keeps ${kept.map((t) => t.title)} unlisted`),
        ).toBeGreaterThan(0);
    }
    expect(
      tasksOf(B.md)
        .filter((t) => visible.has(t.id))
        .map((t) => t.title),
      fail("both notes"),
    ).toEqual(
      tasksOf(A.md)
        .filter((t) => visible.has(t.id))
        .map((t) => t.title),
    );
    // Every Task a side kept is there once, in either note (a Task anchored
    // after another follows it where a concurrent move takes it).
    for (const s of [A, B]) {
      const own = tasksOf(A.md).filter(
        (t) => visible.has(t.id) && ownOf(s.name)(`- [ ] ${t.title}`),
      );
      const kept = new Set(
        tasksOf(s.md)
          .filter((t) => visible.has(t.id))
          .map((t) => t.title),
      );
      expect(own.map((t) => t.title).sort(), fail(`${s.name}'s Tasks in A`)).toEqual(
        s.mine.filter((t) => kept.has(t)).sort(),
      );
    }
    for (const s of [A, B]) s.mine = titlesOf(s.md, s.name);
    trace(A, "online");
  };

  for (let step = 0; step < 30; step++) {
    const x = r();
    if (x < 0.4) {
      if (A.closed) continue;
      gesture(A);
      await pass(A, mode());
    } else if (x < 0.75) {
      gesture(B);
      await pass(B, mode());
    } else if (x < 0.85 && !A.closed) {
      // A closes its note: Obsidian saves it; its next passes are a closed
      // note's (the file route), with what the editor noted before it closed,
      // possibly abandoned (the file changed meanwhile).
      A.closed = true;
      trace(A, "close");
      await pass(A, r() < 0.7 ? "written" : "abandoned");
    } else if (x < 0.9 && A.closed) {
      // Opened again: the file as saved when it closed, and as its closed
      // passes wrote it (A.md follows both).
      A.closed = false;
      trace(A, "open");
    } else {
      await online();
    }
  }
  // Settle: clipboards pasted at the end (unless their Task came back
  // meanwhile, as in a gesture), the note open again, the network back.
  for (const s of [A, B])
    if (s.clip !== null && !idsIn(s.clip).some((id) => s.md.includes(id))) {
      const L = lines(s.md);
      const tasks = L.flatMap((l, i) => (TASK.test(l) && !/^\s/.test(l) ? [i] : []));
      L.splice(blockAt(L, tasks.at(-1) ?? 0)[1], 0, ...s.clip);
      for (const id of idsIn(s.clip)) s.inserted.add(id);
      s.clip = null;
      s.md = L.join("\n");
      s.mine = titlesOf(s.md, s.name);
    }
  A.closed = false;
  await online();
  await online();
}

describe(`both vaults change the structure at once (${SEEDS - FROM + 1} seeds)`, () => {
  for (let seed = FROM; seed <= SEEDS; seed++) it(`seed ${seed}`, () => run(seed));
});

// Seeds whose histories found a bug, run whatever the range: the path to the
// state matters as much as the state (346: a paste while the section waited
// for Review conflicts, then Keep; 778: a Task added under a tab-indented
// parent whose children use spaces).
const REGRESSIONS = [346, 778, 1593, 1602, 2998, 3365, 3776, 4658, 4839, 8501].filter(
  (s) => s < FROM || s > SEEDS,
);
if (REGRESSIONS.length > 0)
  describe("seeds that found a bug", () => {
    for (const seed of REGRESSIONS) it(`seed ${seed}`, () => run(seed));
  });
