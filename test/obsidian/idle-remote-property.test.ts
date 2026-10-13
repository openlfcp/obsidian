// @vitest-environment happy-dom
// A collaborator's edits in a row while the note is open and idle, through
// the section editor as the host runs it: a CodeMirror view of A's note, the
// editor's ViewPlugin and its coordinator, B's changes arriving one by one.
// The engine-level property tests pass on the text they hold, so they never
// saw the coordinator keep the text from before a pass's own write: every
// second edit of B was sent back over by A (0.4.0-beta.13). Each seed runs
// B's edits in runs of two to four with no edit of A between them; now and
// then A types. After every step both notes show B's latest titles and A's
// own, and A commits nothing while idle.
//
// LFCP_PROPERTY_SEEDS (default 20) and LFCP_PROPERTY_FROM pick the seeds.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { NotePass } from "../../src/core/sections/engine";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { PATH, twoVaults, type Vault } from "../support/section-vaults";

const SEEDS = Number(process.env.LFCP_PROPERTY_SEEDS ?? 20);
const FROM = Number(process.env.LFCP_PROPERTY_FROM ?? 1);
const TITLES = ["Alpha", "Beta", "Gamma", "Delta"];

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** Each replica of `from` sends its changes to `to`'s. */
function send(from: Vault, to: Vault) {
  for (const [res, r] of from.replicas) to.replicas.get(res)?.receiveChanges(r.changes());
}

async function run(seed: number) {
  const r = random(seed);
  const { a, b } = await twoVaults([...TITLES.map((t) => `- [ ] ${t}`), "", "A paragraph."]);
  // A's timer: the editor's idle delay runs when the test says so.
  let due: (() => void)[] = [];
  const timer = {
    set: (fn: () => void) => {
      due.push(fn);
      return fn;
    },
    clear: (h: unknown) => {
      due = due.filter((f) => f !== h);
    },
  };
  const passes: NotePass[] = [];
  const errors: unknown[] = [];
  const editor = sectionEditorExtension({
    engine: () => a.engine,
    timer,
    onPass: (_path, p) => passes.push(p),
    onError: (_path, e) => errors.push(e),
  });
  const view = new EditorView({
    doc: a.note(),
    extensions: [
      editor.extension,
      // The mock's field holds only the path the editor reads (a TFile in Obsidian).
      editorInfoField.init(() => ({ file: { path: PATH } }) as never),
    ],
  });
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const now = due;
      due = [];
      for (const fn of now) fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const committed = () =>
    passes.filter((p) => p.sections.some((s) => s.local?.kind === "committed")).length;
  // What each Task's title should read: the last edit of it, by either side.
  const want = new Map(TITLES.map((t) => [t, t]));
  const steps: string[] = [];
  const fail = (what: string) => `seed ${seed}: ${what}\n  after: ${steps.join(" | ")}`;
  const check = async () => {
    // B gets what A sent, if anything, and passes.
    send(a, b);
    await b.pass(b.note());
    await b.pass(b.note());
    for (const [task, title] of want)
      for (const [name, md] of [
        ["A", view.state.doc.toString()],
        ["B", b.note()],
      ] as const)
        expect(md.includes(`[ ] ${title}\n`), fail(`${name} shows ${task} as "${title}"`)).toBe(
          true,
        );
    expect(errors, fail("pass errors")).toEqual([]);
  };
  let n = 0;
  for (let round = 0; round < 5; round++) {
    // B edits, two to four times in a row; A only receives (idle).
    const before = committed();
    const run = 2 + Math.floor(r() * 3);
    for (let k = 0; k < run; k++) {
      const task = TITLES[Math.floor(r() * TITLES.length)] as string;
      const title = `${task} b${++n}`;
      const md = b.note();
      await b.pass(md.replace(`[ ] ${want.get(task)}\n`, `[ ] ${title}\n`));
      want.set(task, title);
      steps.push(`b: ${task} → ${title}`);
      send(b, a);
      editor.remoteChanged(PATH);
      await settle();
      await check();
    }
    expect(committed(), fail("A committed while idle")).toBe(before);
    // Now and then, A types a title of its own.
    if (r() < 0.5) {
      const task = TITLES[Math.floor(r() * TITLES.length)] as string;
      const doc = view.state.doc.toString();
      const at = doc.indexOf(`[ ] ${want.get(task)}\n`) + `[ ] ${want.get(task)}`.length;
      const add = ` a${++n}`;
      view.dispatch({ changes: { from: at, insert: add }, userEvent: "input.type" });
      want.set(task, `${want.get(task)}${add}`);
      steps.push(`a: types${add} on ${task}`);
      await settle();
      await check();
    }
  }
  view.destroy();
}

describe(`a collaborator's edits in a row while the note is idle (${SEEDS - FROM + 1} seeds)`, () => {
  for (let seed = FROM; seed <= SEEDS; seed++) it(`seed ${seed}`, () => run(seed), 20_000);
});
