// Undo and redo across the plugin's own writes in a shared section, Live
// Preview, real keys in vault A, the headless peer B, the reference server
// at LFCP_SERVER_BIN. Each move is made, its pass written (a cut is a
// node.delete, its paste a restore at the new place; Move line a node.move);
// then Ctrl/Cmd+Z until the Tasks are back in their first order, and
// Ctrl/Cmd+Shift+Z until they are moved again. After every key: no stray
// marker text, every ID bound once, no ref without its Task (orphaned) and
// no Task without its ref, the section balanced, A's model in the note's
// order, B's model A's; at the end of each the Tasks keep their IDs.
import { caret, checkStep, editorA, evidence, lineOf, mod, shareAndJoin, startPeers } from "./support/section-checks.mjs";

const TITLES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
const note = (heading) => [heading, ...TITLES.map((t) => `- [ ] ${t}`), ""].join("\n");

/** Move line by its keys; Obsidian's own command when the keys are not bound (said in the evidence). */
async function moveLine(title, dir) {
  await caret(await lineOf(title), 3);
  const before = await editorA((e) => e.getValue());
  await browser.keys(["Alt", dir === "up" ? "ArrowUp" : "ArrowDown"]);
  await browser.pause(500);
  if ((await editorA((e) => e.getValue())) === before) {
    evidence(`Alt+${dir} not bound`, { title });
    // Unbound, the keys still move the caret (macOS: Option+Up/Down go to the
    // paragraph's start or end): the command must act on the title's line.
    await caret(await lineOf(title), 3);
    await browser.executeObsidianCommand(dir === "up" ? "editor:swap-line-up" : "editor:swap-line-down");
  }
}

const SCENARIOS = [
  {
    name: "a cut and paste move (Gamma above Beta)",
    moved: ["Alpha", "Gamma", "Beta", "Delta", "Epsilon"],
    gesture: async (ctx, label) => {
      const g = await lineOf("Gamma");
      // Gamma's line and its ref line, whole.
      await editorA((e, g) => {
        e.focus();
        e.setSelection({ line: g, ch: 0 }, { line: g + 2, ch: 0 });
      }, g);
      await browser.keys([mod, "x"]);
      const cut = await checkStep(`${label} cut`, ctx);
      expect(cut.titles).toEqual(["Alpha", "Beta", "Delta", "Epsilon"]);
      await caret(await lineOf("Beta"), 0);
      await browser.keys([mod, "v"]);
    },
  },
  {
    name: "Move line up (Alt+Up on Delta)",
    moved: ["Alpha", "Beta", "Delta", "Gamma", "Epsilon"],
    gesture: () => moveLine("Delta", "up"),
  },
  {
    name: "Move line down (Alt+Down on Beta)",
    moved: ["Alpha", "Gamma", "Beta", "Delta", "Epsilon"],
    gesture: () => moveLine("Beta", "down"),
  },
];

describe("undo and redo across the plugin's writes in a shared section", () => {
  let server;
  let b;

  before(async () => {
    ({ server, b } = await startPeers());
  });

  after(async () => {
    await b?.stop();
    await server?.stop();
  });

  SCENARIOS.forEach((sc, k) =>
    it(`${sc.name}: undone and redone, the note and both models sound after every key`, async () => {
      const label = `UNDO${k}`;
      const ctx = { b };
      Object.assign(ctx, await shareAndJoin(b, `Undo${k}.md`, `## Undo${k}`, note(`## Undo${k}`)));
      const first = await checkStep(`${label} shared`, ctx);
      expect(first.titles).toEqual(TITLES);
      const ids = first.tasks;

      await sc.gesture(ctx, label);
      const moved = await checkStep(`${label} moved`, ctx);
      expect(moved.titles).toEqual(sc.moved);
      const movedIds = moved.tasks;

      let undos = 0;
      let s = moved;
      while (undos < 5 && JSON.stringify(s.titles) !== JSON.stringify(TITLES)) {
        await browser.keys([mod, "z"]);
        undos++;
        s = await checkStep(`${label} undo ${undos}`, ctx);
      }
      expect(s.titles).toEqual(TITLES);
      expect(s.tasks).toEqual(ids);

      let redos = 0;
      while (redos < 5 && JSON.stringify(s.titles) !== JSON.stringify(sc.moved)) {
        await browser.keys([mod, "Shift", "z"]);
        redos++;
        s = await checkStep(`${label} redo ${redos}`, ctx);
      }
      evidence(`${label} keys`, { undos, redos });
      expect(s.titles).toEqual(sc.moved);
      expect(s.tasks).toEqual(movedIds);
    }),
  );
});
