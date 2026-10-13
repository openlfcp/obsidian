// @vitest-environment happy-dom
// A section's first base, seeded by a pass that changes nothing, while the
// user's edit lands during that pass: a keystroke, an IME composition
// opening, or (a closed note) the file rewritten between the pass's read and
// its write. The pass used to be abandoned whole, its base with it: every
// later pass then found no base and a note unlike the model, sent nothing,
// and the badge said ATTENTION (native section-ime, about one run in seven).
// Now its base is stored and nothing is written into the note; the user's
// text stays, and the next pass, planned on the note as it is now, sends it.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/projection/guard";
import type { NotePass, SectionEngine } from "../../src/core/sections/engine";
import { sectionEditorExtension, sectionWrite } from "../../src/obsidian/section-editor";
import { PATH, reconnect, twoVaults, type Vault } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "", "A paragraph."];

/** `v`'s engine, its next pass held until released (the race's window). */
function gated(v: Vault) {
  let hold: Promise<void> | null = null;
  let release = () => {};
  let started = () => {};
  const engine = new Proxy(v.engine, {
    get(target, key, receiver) {
      if (key !== "pass") return Reflect.get(target, key, receiver);
      return async (...args: Parameters<SectionEngine["pass"]>) => {
        const p = await target.pass(...args);
        if (hold !== null) {
          started();
          await hold;
        }
        return p;
      };
    },
  });
  return {
    engine: engine as SectionEngine,
    /** Resolves once the next pass is planned and held. */
    holdNext(): Promise<void> {
      hold = new Promise((r) => {
        release = () => {
          hold = null;
          r();
        };
      });
      return new Promise((r) => {
        started = r;
      });
    },
    release: () => release(),
  };
}

async function forgetBases(v: Vault) {
  for (const id of await v.bases.projectionsOf(PATH)) await v.bases.save(id, null);
}

async function hasBase(v: Vault) {
  for (const id of await v.bases.projectionsOf(PATH))
    if ((await v.bases.load(id)) !== undefined) return true;
  return false;
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("a seeding pass while the user's edit lands", () => {
  for (const how of ["a keystroke", "an IME composition"] as const)
    it(`${how} in the editor: the base is stored, nothing written, the edit sent next`, async () => {
      const { a, b } = await twoVaults(BODY);
      await forgetBases(b);
      const gate = gated(b);
      const passes: NotePass[] = [];
      const timer = {
        set: (fn: () => void) => setTimeout(fn, 0),
        clear: (h: unknown) => clearTimeout(h as number),
      };
      const editor = sectionEditorExtension({
        engine: () => gate.engine,
        timer,
        onPass: (_p, p) => passes.push(p),
      });
      // The plugin's own writes into the note (passes write with sectionWrite).
      const writes: string[] = [];
      const watch = EditorView.updateListener.of((u) => {
        for (const tr of u.transactions)
          if (tr.annotation(sectionWrite) !== undefined) writes.push(tr.newDoc.toString());
      });
      const view = new EditorView({
        doc: b.note(),
        extensions: [
          editor.extension,
          watch,
          editorInfoField.init(() => ({ file: { path: PATH } }) as never),
        ],
      });
      // The seeding pass, held while the edit lands.
      const held = gate.holdNext();
      editor.remoteChanged(PATH);
      await held;
      const at = view.state.doc.toString().indexOf("Alpha") + "Alpha".length;
      if (how === "an IME composition") {
        view.contentDOM.dispatchEvent(new Event("compositionstart"));
        view.dispatch({ changes: { from: at, insert: " 日本" }, userEvent: "input.type.compose" });
      } else view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
      const typed = view.state.doc.toString();
      gate.release();
      await settle();
      // Nothing written into the note by the seeding pass or after it, so far.
      expect(writes).toEqual([]);
      // The base is stored; nothing was written into the note; the text stays.
      expect(await hasBase(b)).toBe(true);
      expect(view.state.doc.toString()).toBe(typed);
      if (how === "an IME composition") view.contentDOM.dispatchEvent(new Event("compositionend"));
      await settle();
      // The next pass runs on the note as it is now and sends the edit.
      const last = passes.at(-1);
      expect(last?.sourceRevision).toBe(contentHash(view.state.doc.toString()));
      expect(last?.sections[0]?.local?.kind).toBe("committed");
      // Whatever a later pass wrote keeps the user's text.
      expect(writes.every((w) => w.includes(how === "a keystroke" ? "Alphax" : "Alpha 日本"))).toBe(
        true,
      );
      await reconnect(a, b);
      expect(a.note()).toContain(how === "a keystroke" ? "- [ ] Alphax" : "- [ ] Alpha 日本");
      view.destroy();
    });

  it("a closed note's file rewritten between the pass's read and its write: the same", async () => {
    const { a, b } = await twoVaults(BODY);
    await forgetBases(b);
    const gate = gated(b);
    let file = b.note();
    const rewrites: string[] = [];
    const files = {
      rewrite: async (_path: string, fn: (current: string) => string) => {
        const next = fn(file);
        if (next !== file) rewrites.push(next);
        file = next;
        return file;
      },
      read: async () => file,
    };
    const editor = sectionEditorExtension({ engine: () => gate.engine, files });
    const held = gate.holdNext();
    editor.remoteChanged(PATH, file);
    await held;
    // Another app edits the file meanwhile.
    file = file.replace("- [ ] Beta", "- [ ] Betay");
    const edited = file;
    gate.release();
    await settle();
    expect(await hasBase(b)).toBe(true);
    expect(rewrites).toEqual([]);
    expect(file).toBe(edited);
    // The next pass (the file changed) sends the edit.
    await settle();
    await reconnect(a, b);
    expect(a.note()).toContain("- [ ] Betay");
  });
});
