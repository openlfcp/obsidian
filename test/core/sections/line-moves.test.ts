// The editor's own line moves in a shared section (the owner's checks of
// 0.4.0-beta.10 on macOS, step 6): Move line up/down moves whole nodes and
// names the one under the selection, not the neighbour CodeMirror moves the
// other way; Tab and Shift+Tab take a Task's ref line and subtree along; a
// paste that runs into the next line goes on lines of its own. Each case
// then runs on the real section replica: the user's move is the one sent,
// and a concurrent move of the same Task in the other vault needs attention.

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import {
  cutKeepsIndent,
  indentWithNode,
  moveNodeLines,
  pasteOnOwnLines,
} from "../../../src/core/sections/line-moves";
import { parseSections } from "../../../src/core/sections/parser";
import {
  block,
  lines,
  placementConflict,
  reconnect,
  taskId,
  twoVaults,
  type Vault,
} from "../../support/section-vaults";

const BODY = [
  "- [ ] Alpha",
  "- [ ] Beta",
  "- [ ] Gamma",
  "  - [ ] Child",
  "- [ ] テスト",
  "- [ ] 仕事して",
  "- [ ] omega",
];

const titles = (md: string) =>
  lines(md).flatMap((l) => {
    const m = /^\s*- \[.\] (.*)$/.exec(l);
    return m === null ? [] : [m[1] as string];
  });
/** The offset of line `n` (0-based). */
const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);
/** The line of the Task `title`. */
const lineOf = (md: string, title: string) => block(md, title)[0];

/** B moves `title` to the section's start (its whole block, before Alpha). */
async function moveFirstInB(b: Vault, title: string) {
  const L = lines(b.note());
  const [from, to] = block(b.note(), title);
  const moved = L.slice(from, to);
  const rest = [...L.slice(0, from), ...L.slice(to)];
  const at = rest.findIndex((l) => l.includes("[ ] Alpha"));
  await b.pass([...rest.slice(0, at), ...moved, ...rest.slice(at)].join("\n"));
}

describe("Move line up/down in a section", () => {
  it("moves the Task under the caret with its ref and subtree past its sibling, and names it", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const g = lineOf(md, "Gamma");
    const move = moveNodeLines(md, g, g, "up");
    if (move === null) throw new Error("no move");
    const after = applyChanges(md, move.changes);
    expect(titles(after)).toEqual([
      "Alpha",
      "Gamma",
      "Child",
      "Beta",
      "テスト",
      "仕事して",
      "omega",
    ]);
    expect(move.moved).toEqual([taskId(md, "Gamma")]);
    // The selection moves with the Task: Gamma's line starts where the shift says.
    expect(after.slice(offset(md, g) + move.shift).startsWith("- [ ] Gamma")).toBe(true);
    // Its ref line stays right under it.
    const L = lines(after);
    expect(L[lineOf(after, "Gamma") + 1]).toContain(taskId(md, "Gamma"));
  });

  it("the caret on the ref line moves its Task; down moves past the next sibling", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const ref = lineOf(md, "Beta") + 1;
    const move = moveNodeLines(md, ref, ref, "down");
    if (move === null) throw new Error("no move");
    expect(titles(applyChanges(md, move.changes))).toEqual([
      "Alpha",
      "Gamma",
      "Child",
      "Beta",
      "テスト",
      "仕事して",
      "omega",
    ]);
    expect(move.moved).toEqual([taskId(md, "Beta")]);
  });

  it("several Tasks selected move together; a nested Task moves among its siblings only", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const both = moveNodeLines(md, lineOf(md, "テスト"), lineOf(md, "仕事して"), "up");
    expect(both?.moved).toEqual([taskId(md, "テスト"), taskId(md, "仕事して")]);
    expect(titles(applyChanges(md, both?.changes ?? []))).toEqual([
      "Alpha",
      "Beta",
      "テスト",
      "仕事して",
      "Gamma",
      "Child",
      "omega",
    ]);
    // The only child, or the first Task of the section: nothing to move past, nothing moves.
    expect(moveNodeLines(md, lineOf(md, "Child"), lineOf(md, "Child"), "up")).toEqual({
      changes: [],
      moved: [],
      shift: 0,
    });
    expect(moveNodeLines(md, lineOf(md, "Alpha"), lineOf(md, "Alpha"), "up")?.changes).toEqual([]);
    expect(moveNodeLines(md, lineOf(md, "omega"), lineOf(md, "omega"), "down")?.changes).toEqual(
      [],
    );
    // Outside the section the editor's move stands.
    expect(moveNodeLines(md, 0, 0, "down")).toBeNull();
  });

  it("offline, Gamma moved one place up while B moves it to the start: a placement conflict on both", async () => {
    const { a, b } = await twoVaults(BODY);
    const md = a.note();
    const gamma = taskId(md, "Gamma");
    const g = lineOf(md, "Gamma");
    const move = moveNodeLines(md, g, g, "up");
    if (move === null) throw new Error("no move");
    // The hint the editor collects for a Move line: the moved nodes (not the neighbour).
    await a.pass(applyChanges(md, move.changes), { inserted: new Set(move.moved) });
    await moveFirstInB(b, "Gamma");
    await reconnect(a, b);
    expect(placementConflict(a, gamma)).toBe(true);
    expect(placementConflict(b, gamma)).toBe(true);
  });

  it("a new Task after a Task in a placement conflict, and a deletion, in one pass: sent (sweep seed 3365)", async () => {
    const { a, b } = await twoVaults(BODY);
    const md = a.note();
    const gamma = taskId(md, "Gamma");
    const beta = taskId(md, "Beta");
    const g = lineOf(md, "Gamma");
    const move = moveNodeLines(md, g, g, "up");
    if (move === null) throw new Error("no move");
    await a.pass(applyChanges(md, move.changes), { inserted: new Set(move.moved) });
    await moveFirstInB(b, "Gamma");
    await reconnect(a, b);
    expect(placementConflict(b, gamma)).toBe(true);
    // B: a new Task typed right after Gamma's block, and Beta deleted with its ref.
    const L = lines(b.note());
    const [, end] = block(b.note(), "Gamma");
    L.splice(end, 0, "- [ ] Typed after Gamma");
    const [bf, bt] = block(L.join("\n"), "Beta");
    L.splice(bf, bt - bf);
    const res = await b.pass(L.join("\n"), { deletedIds: new Set([beta]) });
    // Not refused (INVALID_PREDECESSOR: Gamma is in no list while in conflict).
    expect(res?.local?.kind).toBe("committed");
    expect(b.model()?.nodes[beta]?.lifecycle).toBe("deleted");
    expect(titles(b.note())).toContain("Typed after Gamma");
    const again = await b.pass(b.note());
    expect(again?.lost).toEqual([]);
  });
});

describe("Tab and Shift+Tab on a Task line", () => {
  it("indent the Task's ref line and subtree with it: Gamma becomes Beta's child, nothing held", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const g = lineOf(md, "Gamma");
    // Obsidian's indent: a tab at the start of Gamma's line only.
    const tab = indentWithNode(md, [{ from: offset(md, g), to: offset(md, g), insert: "\t" }]);
    if (tab === null) throw new Error("not extended");
    const after = applyChanges(md, tab);
    const [from, to] = block(md, "Gamma");
    expect(lines(after).slice(from, to)).toEqual(
      lines(md)
        .slice(from, to)
        .map((l) => `\t${l}`),
    );
    const gamma = taskId(md, "Gamma");
    const beta = taskId(md, "Beta");
    await a.pass(after);
    expect(a.model()?.nodes[gamma]?.parent).toBe(beta);
    expect(a.note()).toBe(after);
    // Shift+Tab: the tab taken from its line, and from its other lines.
    const back = indentWithNode(after, [
      { from: offset(after, g), to: offset(after, g) + 1, insert: "" },
    ]);
    if (back === null) throw new Error("not extended");
    await a.pass(applyChanges(after, back));
    expect(a.model()?.nodes[gamma]?.parent).not.toBe(beta);
    expect(a.note()).toBe(md);
  });

  it("leaves a line that is not a node's first line, and lines the editor changed itself", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const ref = lineOf(md, "Gamma") + 1;
    expect(
      indentWithNode(md, [{ from: offset(md, ref), to: offset(md, ref), insert: "\t" }]),
    ).toBeNull();
    const [from, to] = block(md, "Gamma");
    const all = Array.from({ length: to - from }, (_, k) => {
      const at = offset(md, from + k);
      return { from: at, to: at, insert: "\t" };
    });
    expect(indentWithNode(md, all)).toBeNull();
  });
});

describe("a paste that runs into the next line", () => {
  /** Gamma's lines cut without the trailing newline (the empty line stays), as the macOS M1 check did. */
  function cutWithoutNewline(md: string) {
    const [from, to] = block(md, "Gamma");
    const start = offset(md, from);
    const end = offset(md, to) - 1;
    return { text: md.slice(start, end), after: md.slice(0, start) + md.slice(end) };
  }

  it("a ref glued to the next Task's line gets a line break; the Task pasted is the one moved", async () => {
    const { a, b } = await twoVaults(BODY);
    const md = a.note();
    const gamma = taskId(md, "Gamma");
    const { text, after } = cutWithoutNewline(md);
    const at = offset(after, lineOf(after, "Beta"));
    const change = { from: at, to: at, insert: text };
    const fixed = pasteOnOwnLines(after, change);
    expect(fixed?.insert).toBe(`${text}\n`);
    const pasted = applyChanges(after, [fixed ?? change]);
    expect(titles(pasted)).toEqual([
      "Alpha",
      "Gamma",
      "Child",
      "Beta",
      "テスト",
      "仕事して",
      "omega",
    ]);
    await a.pass(pasted, {
      deletedIds: new Set([gamma]),
      cut: new Set([gamma]),
      inserted: new Set([gamma]),
    });
    expect(a.recovery()).toEqual([]);
    await moveFirstInB(b, "Gamma");
    await reconnect(a, b);
    expect(placementConflict(a, gamma)).toBe(true);
    expect(placementConflict(b, gamma)).toBe(true);
  });

  it("pasted at the end of a line: the Task's line starts a line of its own", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const { text, after } = cutWithoutNewline(md);
    const ref = lineOf(after, "Alpha") + 1;
    const at = offset(after, ref) + (lines(after)[ref]?.length ?? 0);
    const fixed = pasteOnOwnLines(after, { from: at, to: at, insert: text });
    expect(fixed?.insert).toBe(`\n${text}`);
  });

  it("pasted at the start of the section's end marker line: the marker keeps its own line (sweep seed 1822)", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const { text, after } = cutWithoutNewline(md);
    const end = lines(after).findIndex((l) => l.startsWith("<!-- /lfcp-section"));
    const at = offset(after, end);
    const fixed = pasteOnOwnLines(after, { from: at, to: at, insert: text });
    expect(fixed?.insert).toBe(`${text}\n`);
    const pasted = applyChanges(after, [fixed ?? { from: at, to: at, insert: text }]);
    expect(lines(pasted).some((l) => l.startsWith("<!-- /lfcp-section"))).toBe(true);
    const r = await a.pass(pasted);
    expect(r?.skipped).toBeUndefined();
    expect(titles(a.note()).slice(-2)).toEqual(["Gamma", "Child"]);
  });

  it("list lines without bindings glued before a Task's line get a line break; nothing held (sweep seed 1593)", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    // Tasks typed and not bound yet (or copied from another note), the last one nested.
    const text = "- [ ] b1 仕事\n\t- [ ] b2 かみ";
    const at = offset(md, lineOf(md, "Beta"));
    const fixed = pasteOnOwnLines(md, { from: at, to: at, insert: text });
    expect(fixed?.insert).toBe(`${text}\n`);
    const pasted = applyChanges(md, [fixed ?? { from: at, to: at, insert: text }]);
    const res = await a.pass(pasted);
    expect(res?.skipped).toBeUndefined();
    expect(res?.lost).toEqual([]);
    expect(titles(a.note())).toContain("Beta");
    expect(titles(a.note())).toContain("b2 かみ");
  });

  it("list lines without bindings pasted at the end of a Task's line start a line of their own", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const text = "- [ ] b1\n- [ ] b2";
    const L = lines(md);
    const at = offset(md, lineOf(md, "Beta")) + (L[lineOf(md, "Beta")]?.length ?? 0);
    expect(pasteOnOwnLines(md, { from: at, to: at, insert: text })?.insert).toBe(`\n${text}`);
  });

  it("one line, or lines that are not a list, stand as pasted", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const at = offset(md, lineOf(md, "Beta"));
    expect(pasteOnOwnLines(md, { from: at, to: at, insert: "- [ ] b1" })).toBeNull();
    expect(pasteOnOwnLines(md, { from: at, to: at, insert: "plain\ntext " })).toBeNull();
  });

  it("a paste on lines of its own, or outside the section, stands as it is", async () => {
    const { a } = await twoVaults(BODY);
    const md = a.note();
    const [from, to] = block(md, "Gamma");
    const text = lines(md).slice(from, to).join("\n");
    const at = offset(md, lineOf(md, "Beta"));
    expect(pasteOnOwnLines(md, { from: at, to: at, insert: `${text}\n` })).toBeNull();
    expect(pasteOnOwnLines(md, { from: 0, to: 0, insert: text })).toBeNull();
  });
});

// The owner's check of 0.4.0-beta.19, step 4: A nests Delta under Gamma;
// B, with that in its note, selects Gamma from its line start with
// Shift+Down (Live Preview lands after Delta's indentation), cuts, and
// pastes at the start of Alpha's line. The cut took Delta's indentation
// (Delta out of Gamma, its ref left at the old depth) and the paste gave it
// to Alpha (Alpha under Gamma, its ref at the old depth): "binding line
// damaged". The cut now ends at Delta's line start and the paste leaves the
// trailing indentation out: every binding still matches.
describe("a cut that ends inside the next line's indentation", () => {
  it("keeps that line's indentation, and its paste does not indent the line it lands on", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha 4",
      "- [x] Beta",
      "- [ ] Gamma",
      "- [ ] Delta",
      "",
      "A paragraph.",
    ]);
    // A: Delta under Gamma (Tab), and B receives it.
    const nested = a
      .note()
      .replace(/\n- \[ \] Delta\n {2}(<!--[^\n]*)\n/, "\n  - [ ] Delta\n    $1\n");
    await a.pass(nested);
    await reconnect(a, b);
    const md = b.note();
    expect(md).toMatch(/\n {2}- \[ \] Delta\n/);
    // B: from Gamma's line start to just after Delta's indentation.
    const from = md.indexOf("- [ ] Gamma");
    const to = md.indexOf("  - [ ] Delta") + 2;
    const clipboard = md.slice(from, to);
    expect(clipboard.endsWith("\n  ")).toBe(true);
    const cut = cutKeepsIndent(md, { from, to, insert: "" });
    expect(cut).toEqual({ from, to: to - 2, insert: "" });
    const afterCut = applyChanges(md, [cut as never]);
    expect(afterCut).toMatch(/\n {2}- \[ \] Delta\n/);
    const at = afterCut.indexOf("- [ ] Alpha 4");
    const paste = pasteOnOwnLines(afterCut, { from: at, to: at, insert: clipboard });
    expect(paste?.insert.endsWith("\n")).toBe(true);
    const out = applyChanges(afterCut, [paste as never]);
    expect(out).toMatch(/\n- \[ \] Alpha 4\n {2}<!--/);
    expect(out).toMatch(/\n- \[ \] Gamma\n {2}<!--[^\n]*\n- \[ \] Alpha 4/);
    // Every binding still matches its line: nothing lost, nothing damaged.
    expect(parseSections(out).diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const ids = new Set([taskId(md, "Gamma")]);
    const r = await b.pass(out, { cut: ids, inserted: ids });
    expect(r?.lost ?? []).toEqual([]);
  });

  it("a cut that ends at a line start, or outside a section, stands as it is", () => {
    const md = "# Notes\n\n- [ ] one\n  - [ ] two\n";
    expect(
      cutKeepsIndent(md, { from: 8, to: md.indexOf("  - [ ] two") + 2, insert: "" }),
    ).toBeNull();
  });
});
