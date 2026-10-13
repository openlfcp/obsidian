// What tells a pass that the user moved or deleted a node (the owner's trace
// on macOS, 0.4.0-beta.10 step 6): the move hints came from transactions that
// were not the user's (no userEvent: another plugin, Obsidian's API, the
// plugin's own edits; a note reloaded from disk) and outlived their passes,
// so every node looked moved and the neighbour took the user's move. Only
// the user's own edits give hints; edits without a userEvent still sync as
// edits; a removal the note no longer shows is dropped.

import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { editHints, freshHints, pluginEdit } from "../../src/obsidian/section-editor";
import {
  block,
  lines,
  placementConflict,
  reconnect,
  taskId,
  twoVaults,
} from "../support/section-vaults";

const BODY = [
  "- [ ] Alpha",
  "- [ ] Beta",
  "- [ ] Gamma",
  "- [ ] テスト",
  "- [ ] 仕事して",
  "- [ ] omega",
];
const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

/** The hint sets of one view, as the editor collects them, transaction by transaction. */
function collector() {
  const deletedIds = new Set<string>();
  const inserted = new Set<string>();
  let cut = new Set<string>();
  return {
    add(tr: Transaction) {
      const h = editHints(tr);
      for (const id of h.removed) deletedIds.add(id);
      for (const id of h.inserted) inserted.add(id);
      if (tr.isUserEvent("delete.cut")) cut = new Set(h.removed);
      return tr.state;
    },
    hints: (source: string) => ({ ...freshHints({ deletedIds, inserted }, source), cut }),
  };
}

describe("only the user's own edits give move hints", () => {
  it("a reload, another plugin's rewrite and the plugin's own edit give none; a cut and a paste do", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    let state = EditorState.create({ doc: md });
    const c = collector();
    // Obsidian reloads the note from disk ("set"), a plugin rewrites the whole
    // section (no userEvent): every binding removed and inserted again.
    state = c.add(
      state.update({ changes: { from: 0, to: md.length, insert: md }, userEvent: "set" }),
    );
    state = c.add(state.update({ changes: { from: 0, to: md.length, insert: md } }));
    expect(c.hints(md)).toMatchObject({ deletedIds: new Set(), inserted: new Set() });
    // The user's cut of Gamma (with its ref line) and its paste at Beta's line start.
    const [gf, gt] = block(md, "Gamma");
    const from = offset(md, gf);
    const to = offset(md, gt);
    const text = md.slice(from, to);
    state = c.add(
      state.update({
        changes: { from, to },
        selection: EditorSelection.cursor(from),
        userEvent: "delete.cut",
      }),
    );
    const at = offset(md, block(md, "Beta")[0]);
    state = c.add(state.update({ changes: { from: at, insert: text }, userEvent: "input.paste" }));
    const gamma = taskId(md, "Gamma");
    expect(c.hints(state.doc.toString())).toEqual({
      deletedIds: new Set([gamma]),
      inserted: new Set([gamma]),
      cut: new Set([gamma]),
    });
  });

  it("after remote renders and reloads, the user's Gamma one place up meets B's move in a conflict", async () => {
    const { a, b } = await twoVaults(BODY);
    const md = a.note();
    const gamma = taskId(md, "Gamma");
    let state = EditorState.create({ doc: md });
    const c = collector();
    // Not the user's: a reload of the whole note, the plugin's own edit
    // (Use shared version, Review conflicts: the section replaced, marked as
    // the plugin's), another plugin's rewrite (no userEvent).
    const all = { from: 0, to: md.length, insert: md };
    state = c.add(state.update({ changes: all, userEvent: "set" }));
    state = c.add(state.update({ changes: all, annotations: pluginEdit.of(true) }));
    state = c.add(state.update({ changes: all }));
    // Then the user: Gamma cut with its ref line, pasted at the start of Beta's line.
    const [gf, gt] = block(md, "Gamma");
    const text = md.slice(offset(md, gf), offset(md, gt));
    state = c.add(
      state.update({
        changes: { from: offset(md, gf), to: offset(md, gt) },
        userEvent: "delete.cut",
      }),
    );
    const at = offset(md, block(md, "Beta")[0]);
    state = c.add(state.update({ changes: { from: at, insert: text }, userEvent: "input.paste" }));
    const moved = state.doc.toString();
    await a.pass(moved, c.hints(moved));
    // B moves Gamma to the section's start, offline too.
    const L = lines(b.note());
    const [bf, bt] = block(b.note(), "Gamma");
    const g = L.splice(bf, bt - bf);
    L.splice(block(b.note(), "Alpha")[0], 0, ...g);
    await b.pass(L.join("\n"));
    await reconnect(a, b);
    expect(placementConflict(a, gamma)).toBe(true);
    expect(placementConflict(b, gamma)).toBe(true);
  });

  it("a removal the note no longer shows is dropped: a node noted as removed but bound, not pasted", () => {
    const md = "x\n  <!-- lfcp-ref: lfcp1:R#task:019a2f85-7b31-7c42-b85a-fc843e2f4064 -->\n";
    const id = "019a2f85-7b31-7c42-b85a-fc843e2f4064";
    const other = "019a2f85-7b31-7c42-b85a-fc843e2f4065";
    expect(
      freshHints({ deletedIds: new Set([id, other]), inserted: new Set<string>() }, md),
    ).toEqual({
      deletedIds: new Set([other]),
      inserted: new Set(),
    });
    // Cut and pasted back elsewhere: still a move.
    expect(
      freshHints({ deletedIds: new Set([id]), inserted: new Set([id]) }, md).deletedIds,
    ).toEqual(new Set([id]));
  });
});

describe("edits without a userEvent still sync as edits", () => {
  it("a checkbox toggled by Obsidian or the Tasks plugin, with its ✅ date: sent, no move", async () => {
    const { a, b } = await twoVaults(BODY);
    const md = a.note();
    const at = offset(md, block(md, "Beta")[0]);
    const state = EditorState.create({ doc: md });
    const line = "- [ ] Beta";
    const tr = state.update({
      changes: { from: at, to: at + line.length, insert: "- [x] Beta ✅ 2026-10-13" },
    });
    expect(editHints(tr)).toEqual({ removed: [], inserted: [] });
    const r = await a.pass(tr.state.doc.toString(), {});
    expect(r?.skipped).toBeUndefined();
    await reconnect(a, b);
    expect(b.note()).toContain("- [x] Beta ✅ 2026-10-13");
    expect(a.model()?.order[""]).toEqual(b.model()?.order[""]);
  });

  it("a bound Task deleted by another plugin is a binding lost, its shared Task kept", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const beta = taskId(md, "Beta");
    const [from, to] = block(md, "Beta");
    const state = EditorState.create({ doc: md });
    const tr = state.update({ changes: { from: offset(md, from), to: offset(md, to) } });
    expect(editHints(tr).removed).toEqual([]);
    const r = await a.pass(tr.state.doc.toString(), {});
    expect(r?.lost).toContain(beta);
    expect(a.model()?.nodes[beta]?.lifecycle).toBe("active");
  });
});
