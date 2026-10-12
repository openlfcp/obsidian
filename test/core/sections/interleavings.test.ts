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
// After every written pass, the note shows exactly what the user typed last:
// never older text. In the end the model and the peer have it too. The PR
// run uses 40 seeds; LFCP_PROPERTY_SEEDS=500 runs more.

import { describe, expect, it } from "vitest";
import { lines, reconnect, twoVaults, type Vault } from "../../support/section-vaults";

const SEEDS = Number(process.env.LFCP_PROPERTY_SEEDS ?? 40);
const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "Clean paragraph."];
const WORDS = ["draft", "テスト", "仕事", "plan", "かみ", "x"];
const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };

const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const TASK = /^- \[ \] (.*)$/;
/** The titles of the Task lines after "Gamma" (the ones this vault's user made). */
const ownTasks = (md: string) => {
  const L = lines(md);
  const at = L.indexOf("- [ ] Gamma");
  return L.slice(at + 1).flatMap((l) => {
    const m = TASK.exec(l);
    return m === null ? [] : [m[1] ?? ""];
  });
};
const paragraph = (md: string) => {
  const L = lines(md);
  const at = L.findIndex((l) => l.startsWith("<!-- lfcp-node: paragraph:"));
  return L[at + 1] ?? "";
};
const alpha = (md: string) => lines(md).find((l) => /^- \[ \] Alpha/.test(l)) ?? "";

/** `md` with the k-th own Task's title set. */
function setTitle(md: string, k: number, title: string): string {
  const L = lines(md);
  const at = L.indexOf("- [ ] Gamma");
  let seen = -1;
  for (let i = at + 1; i < L.length; i++)
    if (TASK.test(L[i] ?? "") && ++seen === k) {
      L[i] = `- [ ] ${title}`;
      return L.join("\n");
    }
  throw new Error(`no own Task ${k}`);
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

  /** The network comes back; each vault's passes run on what its editor shows now. */
  const online = async () => {
    for (const [res, ra] of a.replicas) {
      const rb = b.replicas.get(res);
      if (rb === undefined) continue;
      const fromA = ra.changes();
      ra.receiveChanges(rb.changes());
      rb.receiveChanges(fromA);
    }
    for (let i = 0; i < 2; i++) {
      await a.pass(md);
      md = a.note();
      await b.pass(b.note());
    }
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
    if (mode === "abandoned") {
      const p = await a.engine.pass("Plan.md", md, ctx);
      a.engine.abandoned(p);
    } else {
      await a.pass(md);
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
    } else if (x < 0.74) {
      await tick(a, Math.floor(r() * 2500));
      continue;
    } else if (x < 0.8) {
      // A composition: edits without a pass until its end.
      const k = titles.length - 1;
      for (const w of ["ｔ", "て", "てす"]) md = setTitle(md, k, w);
      const word = pick(WORDS);
      titles = titles.map((t, i) => (i === k ? word : t));
      md = setTitle(md, k, word);
    } else if (x < 0.88) {
      // The peer edits another Task.
      alphaB = `Alpha ${pick(WORDS)}`;
      bmd = b.note().replace(/^- \[ \] Alpha.*$/m, `- [ ] ${alphaB}`);
      await b.pass(bmd);
      await tick(b, 3000);
      continue;
    } else {
      await online();
      expect(ownTasks(md)).toEqual(titles);
      expect(paragraph(md)).toBe(para);
      continue;
    }
    await passA(mode(), r() < 0.2);
  }
  // Settle: passes, the timer, the network.
  for (let i = 0; i < 3; i++) {
    await a.pass(md);
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

  for (let seed = 1; seed <= SEEDS; seed++) it(`seed ${seed}`, () => run(seed));
});
