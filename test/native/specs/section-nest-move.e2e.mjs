// The owner's check of 0.4.0-beta.14, step 4, in Live Preview: one vault
// nests Delta under Gamma (Tab) while the other moves Gamma to the top. Both
// badges said CURRENT with different trees. Vault A is real Obsidian with
// real keys, B the headless peer, the reference server at LFCP_SERVER_BIN;
// each case on its own note. After the step both notes and both models must
// nest every Task alike, not only list them in the same order, and the badge
// says CURRENT only then.
import {
  editorA,
  evidence,
  inA,
  jsonB,
  lineOf,
  mod,
  settle,
  shareAndJoin,
  startPeers,
  stateA,
  canonical,
} from "./support/section-checks.mjs";

const note = (heading) =>
  [heading, "- [ ] Alpha 4", "- [x] Beta", "- [ ] Gamma", "- [ ] Delta", "", "paragraph 1.", ""].join("\n");

const REF = /#task:([0-9a-f-]{36})/;
/** {title: parent title or null} as the note's indentation nests the Tasks. */
function noteTree(md) {
  const L = md.split("\n");
  const out = {};
  const stack = [];
  for (const line of L) {
    const m = /^([ \t]*)- \[.\] (.*)$/.exec(line);
    if (m === null) continue;
    const col = [...m[1]].reduce((c, ch) => (ch === "\t" ? c + 4 - (c % 4) : c + 1), 0);
    while (stack.length > 0 && stack.at(-1).col >= col) stack.pop();
    out[m[2]] = stack.at(-1)?.title ?? null;
    stack.push({ col, title: m[2] });
  }
  return out;
}
/** {title: parent title or null} as a model nests them, titles from the note's refs. */
function modelTree(entries, md) {
  const L = md.split("\n");
  const titleOf = {};
  for (let i = 0; i < L.length; i++) {
    const id = REF.exec(L[i])?.[1];
    if (id === undefined) continue;
    const t = /- \[.\] (.*?)(?:\s*<!--.*)?$/.exec(L[/- \[.\] /.test(L[i]) ? i : i - 1] ?? "")?.[1];
    if (t !== undefined) titleOf[id] = t;
  }
  const out = {};
  for (const e of entries) if (e.kind === "task") out[titleOf[e.id] ?? e.id] = titleOf[e.parent] ?? null;
  return out;
}
const treeA = (hex) =>
  inA(({ app }, hex) => {
    const R = Uint8Array.from(hex.match(/../g).map((h) => Number.parseInt(h, 16)));
    return app.plugins.plugins["shared-tasks"].runtime.sectionProfile(R).replica.tree().tree.map((e) => ({ id: e.id, parent: e.parent, kind: e.kind }));
  }, hex);
const treeB = (b, hex) =>
  b.runtime.sectionProfile(Uint8Array.from(Buffer.from(hex, "hex"))).replica.tree().tree.map((e) => ({ id: e.id, parent: e.parent, kind: e.kind }));

/** B nests Delta under Gamma in its file (a tab on Delta's line and its ref line) and passes. */
async function nestInB(ctx) {
  const L = ctx.b.files.get(ctx.bFile).split("\n");
  const d = L.findIndex((l) => /^- \[.\] Delta$/.test(l));
  L[d] = `\t${L[d]}`;
  L[d + 1] = `\t${L[d + 1]}`;
  ctx.b.files.set(ctx.bFile, L.join("\n"));
  await ctx.b.pass(ctx.bFile);
}

/** B moves Gamma (its line and ref) above Alpha 4 in its file and passes. */
async function moveInB(ctx) {
  const L = ctx.b.files.get(ctx.bFile).split("\n");
  const g = L.findIndex((l) => /^- \[.\] Gamma$/.test(l));
  const lines = L.splice(g, 2);
  const a = L.findIndex((l) => /^- \[.\] Alpha 4$/.test(l));
  L.splice(a, 0, ...lines);
  ctx.b.files.set(ctx.bFile, L.join("\n"));
  await ctx.b.pass(ctx.bFile);
}

const CASES = {
  "A nests Delta (Tab), B moves Gamma to the top": async (ctx) => {
    await editorA((e, n) => {
      e.focus();
      e.setCursor({ line: n, ch: e.getLine(n).length });
    }, await lineOf("Delta"));
    await browser.keys(["Tab"]);
    await moveInB(ctx);
  },
  "A moves Gamma to the top (the owner's keys, Live Preview), B nests Delta": async (ctx) => {
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 0 });
    }, await lineOf("Gamma"));
    await browser.keys(["Shift", "ArrowDown"]);
    await browser.pause(150);
    await browser.keys(["Shift", "ArrowDown"]);
    await browser.pause(150);
    await browser.keys([mod, "x"]);
    await nestInB(ctx);
    await browser.pause(150);
    await editorA((e, a) => e.setCursor({ line: a, ch: 0 }), await lineOf("Alpha 4"));
    await browser.keys([mod, "v"]);
  },
  "A moves Gamma to the top (Move line up twice), B nests Delta": async (ctx) => {
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 3 });
    }, await lineOf("Gamma"));
    await browser.executeObsidianCommand("editor:swap-line-up");
    await browser.pause(100);
    await browser.executeObsidianCommand("editor:swap-line-up");
    await nestInB(ctx);
  },
  "A cuts Gamma, its pass runs, B nests Delta, then A pastes Gamma at the top": async (ctx) => {
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 0 });
    }, await lineOf("Gamma"));
    await browser.keys(["Shift", "ArrowDown"]);
    await browser.pause(150);
    await browser.keys(["Shift", "ArrowDown"]);
    await browser.pause(150);
    await browser.keys([mod, "x"]);
    await browser.pause(1500);
    await nestInB(ctx);
    await browser.pause(1500);
    await editorA((e, a) => e.setCursor({ line: a, ch: 0 }), await lineOf("Alpha 4"));
    await browser.keys([mod, "v"]);
  },
  "A moves Gamma up once, its pass runs, B nests Delta, then A moves Gamma up again": async (ctx) => {
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 3 });
    }, await lineOf("Gamma"));
    await browser.executeObsidianCommand("editor:swap-line-up");
    await browser.pause(1500);
    await nestInB(ctx);
    await browser.pause(1500);
    await editorA((e, g) => {
      e.focus();
      e.setCursor({ line: g, ch: 3 });
    }, await lineOf("Gamma"));
    await browser.executeObsidianCommand("editor:swap-line-up");
  },
  "B moves Gamma to the top, A's Tab on Delta lands after B's move arrived": async (ctx) => {
    await moveInB(ctx);
    await browser.pause(1500);
    await editorA((e, n) => {
      e.focus();
      e.setCursor({ line: n, ch: e.getLine(n).length });
    }, await lineOf("Delta"));
    await browser.keys(["Tab"]);
  },
};

describe("one vault nests Delta under Gamma while the other moves Gamma to the top", () => {
  let server;
  let b;
  before(async () => {
    ({ server, b } = await startPeers());
  });
  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  Object.entries(CASES).forEach(([name, step], k) =>
    it(`${name}: both notes and both models nest the Tasks alike`, async () => {
      const heading = `## Tasks${k + 2}`;
      const ctx = { b, ...(await shareAndJoin(b, `Nest${k}.md`, heading, note(heading))) };
      await settle(ctx.R);
      await step(ctx);
      let a = await settle(ctx.R);
      for (let i = 0; i < 4; i++) {
        await ctx.b.pass(ctx.bFile);
        await browser.pause(800);
      }
      a = await settle(ctx.R);
      await browser.waitUntil(async () => jsonB(ctx.b, ctx.R) === canonical(JSON.parse((await stateA(ctx.R)).json)), {
        timeout: 20_000,
        timeoutMsg: "models converge",
      });
      await ctx.b.pass(ctx.bFile);
      a = await settle(ctx.R);
      const bMd = ctx.b.files.get(ctx.bFile);
      const trees = {
        noteA: noteTree(a.md),
        modelA: modelTree(await treeA(ctx.R), a.md),
        noteB: noteTree(bMd),
        modelB: modelTree(treeB(ctx.b, ctx.R), bMd),
      };
      evidence(`nest-move ${k}`, { ...trees, badge: a.badge, mdA: a.md.split("\n"), mdB: bMd.split("\n") });
      // Two orders have another outcome both vaults agree on: a cut whose
      // pass ran before B's nest arrived takes Delta out (the deletion keeps
      // it where the note shows it), and a Tab after B's move arrived nests
      // Delta under the Task now above it, Beta.
      const want =
        k === 1 || k === 3
          ? null
          : k === 5
            ? { Gamma: null, "Alpha 4": null, Beta: null, Delta: "Beta" }
            : { Gamma: null, Delta: "Gamma", "Alpha 4": null, Beta: null };
      // Before anything else: the notes and the models agree (no silent divergence).
      expect(trees.noteA).toEqual(trees.modelA);
      expect(trees.noteB).toEqual(trees.modelB);
      expect(trees.modelB).toEqual(trees.modelA);
      if (want !== null) expect(trees.modelA).toEqual(want);
      expect(a.badge).toBe("CURRENT");
    }),
  );
});
