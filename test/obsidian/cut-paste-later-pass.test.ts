// @vitest-environment happy-dom
// Moving one's own Task by cut and paste (soak finding #9 on 0.4.0-beta.17,
// robust-simon's seed 4): the user cuts a root Task's block and, a moment
// later, pastes it after another root block. The cut's pass may commit the
// deletion first; the paste must then restore the Task where it was pasted
// (session-cut.ts, undo.ts compensate), never leave it deleted for
// collaborators while the note still shows it. Each timing a person can
// produce: the paste in the cut's own pass, after the cut's pass was
// written, after a collaborator's change was projected in between, and
// while the cut's pass is still running.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { NotePass } from "../../src/core/sections/engine";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { block, lines, PATH, twoVaults, type Vault } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta", "", "A paragraph."];

function send(from: Vault, to: Vault) {
  for (const [res, r] of from.replicas) to.replicas.get(res)?.receiveChanges(r.changes());
}

const titles = (md: string) =>
  lines(md).flatMap((l) => {
    const m = /^\s*- \[.\] (.*)$/.exec(l);
    return m === null ? [] : [m[1] as string];
  });

async function setup() {
  // Text edits coalesce as on the plugin's runtime; `tick` is the coalescer's timer.
  const clock = { now: 0 };
  const { a, b } = await twoVaults(BODY, undefined, { now: () => clock.now });
  const tick = async (ms = 2000) => {
    clock.now += ms;
    await a.port.tick(clock.now);
    await a.flushed();
  };
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
    extensions: [editor.extension, editorInfoField.init(() => ({ file: { path: PATH } }) as never)],
  });
  /** Until nothing moves for three turns (idle-remote-property.test.ts). */
  const settle = async () => {
    const mark = () => `${passes.length}\u0000${view.state.doc.toString()}`;
    for (let i = 0, quiet = 0; i < 200 && quiet < 3; i++) {
      const now = due;
      due = [];
      for (const fn of now) fn();
      const before = mark();
      await new Promise((resolve) => setTimeout(resolve, 0));
      quiet = now.length === 0 && due.length === 0 && mark() === before ? quiet + 1 : 0;
    }
  };
  /** Runs the passes due now without waiting for them. */
  const fireDue = () => {
    const now = due;
    due = [];
    for (const fn of now) fn();
  };
  const doc = () => view.state.doc.toString();
  const offset = (n: number) => view.state.doc.line(n + 1).from;
  /** Cuts the Task titled `title` with its ref line (Ctrl+X on the selected lines). */
  const cut = (title: string) => {
    const [from, to] = block(doc(), title);
    const text = doc().slice(offset(from), offset(to));
    view.dispatch({ changes: { from: offset(from), to: offset(to) }, userEvent: "delete.cut" });
    return text;
  };
  /** Pastes `text` at the start of the line after the block of `title` (Ctrl+V). */
  const pasteAfter = (title: string, text: string) => {
    const [, to] = block(doc(), title);
    const at = offset(to);
    view.dispatch({
      changes: { from: at, insert: text },
      userEvent: "input.paste",
    });
  };
  /** Types `words` at the end of the Task titled `title`. */
  const retitle = (title: string, words: string) => {
    const [from] = block(doc(), title);
    const line = view.state.doc.line(from + 1);
    view.dispatch({ changes: { from: line.to, insert: words }, userEvent: "input.type" });
  };
  return { a, b, view, editor, settle, fireDue, cut, pasteAfter, doc, errors, tick, retitle };
}

/** A's model has Beta active after Delta; B, after receiving, shows the same. */
async function expectMoved(s: Awaited<ReturnType<typeof setup>>, beta = "Beta") {
  const { a, b, view } = s;
  await s.settle();
  await s.tick();
  await s.settle();
  expect(s.errors).toEqual([]);
  expect(titles(view.state.doc.toString())).toEqual(["Alpha", "Gamma", "Delta", beta]);
  const model = a.model();
  const shown = (model?.order[""] ?? []).filter((id) => model?.nodes[id]?.lifecycle === "active");
  expect(shown.length).toBe(5);
  send(a, b);
  await b.pass(b.note());
  await b.pass(b.note());
  expect(titles(b.note())).toEqual(["Alpha", "Gamma", "Delta", beta]);
  view.destroy();
}

describe("a Task moved by cut and paste stays shared (soak #9)", () => {
  it("pasted before the cut's pass runs", async () => {
    const s = await setup();
    await s.settle();
    const text = s.cut("Beta");
    s.pasteAfter("Delta", text);
    await expectMoved(s);
  });

  it("pasted after the cut's pass committed the deletion", async () => {
    const s = await setup();
    await s.settle();
    const text = s.cut("Beta");
    await s.settle();
    expect(titles(s.doc())).toEqual(["Alpha", "Gamma", "Delta"]);
    s.pasteAfter("Delta", text);
    await expectMoved(s);
  });

  it("a collaborator's change projected between the cut and the paste", async () => {
    const s = await setup();
    await s.settle();
    const text = s.cut("Beta");
    await s.settle();
    send(s.a, s.b);
    await s.b.pass(s.b.note());
    await s.b.pass(s.b.note().replace("- [ ] Alpha", "- [ ] Alpha by B"));
    send(s.b, s.a);
    s.editor.remoteChanged(PATH);
    await s.settle();
    expect(s.doc()).toContain("Alpha by B");
    s.pasteAfter("Delta", text);
    await s.settle();
    expect(titles(s.doc())).toEqual(["Alpha by B", "Gamma", "Delta", "Beta"]);
    const model = s.a.model();
    expect(
      (model?.order[""] ?? []).filter((id) => model?.nodes[id]?.lifecycle === "active").length,
    ).toBe(5);
    s.view.destroy();
  });

  for (const at of ["before the cut", "after the cut", "after the paste"] as const)
    it(`retitled just before, its Text edit still coalescing; the coalescer commits ${at}`, async () => {
      const s = await setup();
      await s.settle();
      s.retitle("Beta", " now");
      await s.settle();
      if (at === "before the cut") await s.tick();
      const text = s.cut("Beta now");
      await s.settle();
      if (at === "after the cut") await s.tick();
      s.pasteAfter("Delta", text);
      await expectMoved(s, "Beta now");
    });

  it("pasted while a later pass is writing (the soak's interleaving)", async () => {
    const s = await setup();
    await s.settle();
    const text = s.cut("Beta");
    await s.settle();
    // A collaborator's change: its pass runs, and the user pastes during its last await.
    send(s.a, s.b);
    await s.b.pass(s.b.note());
    await s.b.pass(s.b.note().replace("- [ ] Gamma", "- [ ] Gamma by B"));
    send(s.b, s.a);
    const engine = s.a.engine as unknown as { written: (...a: unknown[]) => Promise<unknown> };
    const written = engine.written.bind(engine);
    let armed = true;
    engine.written = async (...a: unknown[]) => {
      if (armed) {
        armed = false;
        s.pasteAfter("Delta", text);
        // The editor's idle timer fires during the await (a slow write under load).
        s.fireDue();
      }
      return written(...a);
    };
    s.editor.remoteChanged(PATH);
    await s.settle();
    engine.written = written;
    await s.settle();
    await s.tick();
    await s.settle();
    expect(s.errors).toEqual([]);
    expect(titles(s.doc())).toEqual(["Alpha", "Gamma by B", "Delta", "Beta"]);
    const model = s.a.model();
    const shown = (model?.order[""] ?? []).filter((id) => model?.nodes[id]?.lifecycle === "active");
    expect(shown.length).toBe(5);
    s.view.destroy();
  });

  it("pasted while the cut's pass is still running", async () => {
    const s = await setup();
    await s.settle();
    const text = s.cut("Beta");
    s.fireDue();
    s.pasteAfter("Delta", text);
    await expectMoved(s);
  });
});
