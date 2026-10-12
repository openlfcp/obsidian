// Passes the host abandons (the user typed meanwhile, or a composition
// opened during the pass: section-editor.ts) on the real section replica, two
// vaults. The owner's check of 0.4.0-beta.8: a new Task typed, deleted and
// composed again came back with an older title. Whatever passes are
// abandoned, the note never shows older text than the user's last, and the
// model and the peer end with exactly that text.

import { describe, expect, it } from "vitest";
import { lines, reconnect, twoVaults, type Vault } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "Clean paragraph."];
const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
const lastTask = (md: string) =>
  lines(md)
    .filter((l) => /^- \[ \] /.test(l))
    .at(-1) ?? "";
const titleOf = (v: Vault, title: string) =>
  Object.values(
    (v.replica().toJSON() as { objects?: Record<string, { title?: string }> }).objects ?? {},
  )
    .map((o) => o?.title)
    .includes(title);

/** A pass the host does not write. */
async function abandoned(v: Vault, md: string) {
  const p = await v.engine.pass("Plan.md", md, ctx);
  v.engine.abandoned(p);
}

describe("abandoned passes never bring older text back", () => {
  it("a pass that created a Task is abandoned: the next pass binds it, nothing throws", async () => {
    const { a, b } = await twoVaults(BODY);
    const typed = a.note().replace("- [ ] Gamma", "- [ ] Gamma\n- [ ] draf");
    // The pass that creates the Task is not written: the user typed "t" meanwhile.
    await abandoned(a, typed);
    const more = typed.replace("- [ ] draf", "- [ ] draft");
    await expect(a.pass(more)).resolves.toBeDefined();
    expect(lastTask(a.note())).toBe("- [ ] draft");
    expect(a.note()).toMatch(/- \[ \] draft\n {2}<!-- lfcp-ref: /);
    await reconnect(a, b);
    expect(lastTask(b.note())).toBe("- [ ] draft");
  });

  // A seeded generator: the same sequences on every run.
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const WORDS = ["draft", "テスト", "仕事", "plan", "かみ"];

  for (let seed = 1; seed <= 40; seed++)
    it(`random typing, deleting and composing with abandoned passes (seed ${seed})`, async () => {
      const r = random(seed);
      const { a, b } = await twoVaults(BODY);
      let md = a.note().replace("- [ ] Gamma", "- [ ] Gamma\n- [ ] start");
      await a.pass(md);
      md = a.note();
      let title = "start";
      for (let step = 0; step < 14; step++) {
        const roll = r();
        // The user's edit: type a character, delete some, or replace the title (a composition).
        if (roll < 0.35) title += "abcdefghij"[Math.floor(r() * 10)];
        else if (roll < 0.6)
          title = title.slice(0, Math.max(0, title.length - 1 - Math.floor(r() * 3)));
        else title = WORDS[Math.floor(r() * WORDS.length)] as string;
        md = md.replace(/^- \[ \] .*$(?![\s\S]*^- \[ \] )/m, `- [ ] ${title}`);
        if (r() < 0.4) await abandoned(a, md);
        else {
          await a.pass(md);
          md = a.note();
        }
        // The note shows what the user typed last, never older text.
        expect(lastTask(md)).toBe(`- [ ] ${title}`);
        if (r() < 0.25) await reconnect(a, b);
      }
      await a.pass(md);
      await a.pass(a.note());
      await reconnect(a, b);
      expect(lastTask(a.note())).toBe(`- [ ] ${title}`);
      if (title !== "") {
        expect(titleOf(a, title)).toBe(true);
        expect(lastTask(b.note())).toBe(`- [ ] ${title}`);
      }
    });
});

// Found by the interleavings test with moves (0.4.0-beta.10): a cut Task
// pasted back, and new Tasks cut before their bindings were written.
describe("pasting a cut Task, and cutting a new one, with abandoned passes", () => {
  const BODY3 = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma"];
  const L = (md: string) => lines(md);
  /** `md` with the Task block at `title` moved before the line starting with `before` (or appended). */
  const blockOf = (md: string, title: string) => {
    const ls = L(md);
    const at = ls.findIndex((l) => l === `- [ ] ${title}`);
    let to = at + 1;
    while (to < ls.length && /^\s+\S/.test(ls[to] ?? "")) to++;
    return { at, to, block: ls.slice(at, to), rest: [...ls.slice(0, at), ...ls.slice(to)] };
  };
  const tasksOf = (md: string) =>
    L(md)
      .filter((l) => /^- \[ \] /.test(l))
      .map((l) => l.slice(6));

  it("a paste restored by an abandoned pass, then the title typed: the new title is sent", async () => {
    const { a, b } = await twoVaults(BODY3);
    const { block, rest } = blockOf(a.note(), "Beta");
    const id = /#task:([0-9a-f-]{36})/.exec(block.join("\n"))?.[1] as string;
    const ids = new Set([id]);
    // Cut (its own pass: deleted), pasted after Gamma (that pass abandoned: restored).
    await a.pass(rest.join("\n"), { deletedIds: ids, cut: ids });
    const g = blockOf(a.note(), "Gamma");
    const pasted = [...L(a.note()).slice(0, g.to), ...block, ...L(a.note()).slice(g.to)].join("\n");
    await abandoned(a, pasted);
    // The title typed over, then a written pass.
    const typed = pasted.replace("- [ ] Beta", "- [ ] Beta typed");
    await a.pass(typed, { cut: ids });
    await a.pass(a.note());
    expect(tasksOf(a.note())).toEqual(["Alpha", "Gamma", "Beta typed"]);
    await reconnect(a, b);
    expect(tasksOf(b.note())).toEqual(["Alpha", "Gamma", "Beta typed"]);
  });

  it("a cut Task pasted and its title edited in one pass: the edit stays and is sent", async () => {
    const { a, b } = await twoVaults(BODY3);
    const { block, rest } = blockOf(a.note(), "Beta");
    const id = /#task:([0-9a-f-]{36})/.exec(block.join("\n"))?.[1] as string;
    const ids = new Set([id]);
    await a.pass(rest.join("\n"), { deletedIds: ids, cut: ids });
    const g = blockOf(a.note(), "Gamma");
    const pasted = [...L(a.note()).slice(0, g.to), ...block, ...L(a.note()).slice(g.to)]
      .join("\n")
      .replace("- [ ] Beta", "- [ ] Beta edited");
    await a.pass(pasted, { inserted: ids, cut: ids });
    expect(tasksOf(a.note())).toEqual(["Alpha", "Gamma", "Beta edited"]);
    await a.pass(a.note());
    expect(tasksOf(a.note())).toEqual(["Alpha", "Gamma", "Beta edited"]);
    await reconnect(a, b);
    expect(tasksOf(b.note())).toEqual(["Alpha", "Gamma", "Beta edited"]);
  });

  it("a cut Task pasted and a new Task typed right after it in one pass: committed, not refused", async () => {
    const { a, b } = await twoVaults(BODY3);
    const { block, rest } = blockOf(a.note(), "Beta");
    const id = /#task:([0-9a-f-]{36})/.exec(block.join("\n"))?.[1] as string;
    const ids = new Set([id]);
    await a.pass(rest.join("\n"), { deletedIds: ids, cut: ids });
    const g = blockOf(a.note(), "Gamma");
    const pasted = [
      ...L(a.note()).slice(0, g.to),
      ...block,
      "- [ ] New after it",
      ...L(a.note()).slice(g.to),
    ].join("\n");
    const r = await a.pass(pasted, { inserted: ids, cut: ids });
    expect(r?.local?.kind).toBe("committed");
    await a.pass(a.note());
    await reconnect(a, b);
    expect(tasksOf(b.note())).toEqual(["Alpha", "Gamma", "Beta", "New after it"]);
  });

  it("a new Task whose creating pass was abandoned, cut before its ref was written: never back", async () => {
    const { a, b } = await twoVaults(BODY3);
    const typed = a.note().replace("- [ ] Gamma", "- [ ] Gamma\n- [ ] fresh");
    await abandoned(a, typed);
    // Cut (no binding to see: its ref was never written), then later passes.
    const cutAway = typed.replace("\n- [ ] fresh", "");
    await a.pass(cutAway);
    await a.pass(a.note());
    expect(tasksOf(a.note())).toEqual(["Alpha", "Beta", "Gamma"]);
    await reconnect(a, b);
    expect(tasksOf(a.note())).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(tasksOf(b.note())).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
