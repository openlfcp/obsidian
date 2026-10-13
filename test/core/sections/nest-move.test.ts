// The owner's check of 0.4.0-beta.14, step 4: A nests Delta under Gamma
// (Tab) while B moves Gamma above Alpha 4 (Move line up twice, or a cut and
// a paste), in either order of arrival. Both notes nest the Tasks as the
// model does, Delta under Gamma at the top. The blank line before the
// paragraph stays: the move used to take it along, leaving the last Task's
// ref glued to the paragraph's marker (the marker shown in Live Preview).

import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../src/core/sections/engine";
import { indentWithNode, moveNodeLines } from "../../../src/core/sections/line-moves";
import { block, lines, reconnect, taskId, twoVaults } from "../../support/section-vaults";

const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);
/** The Task lines, nested ones marked by two spaces whatever their indentation. */
const tree = (md: string) =>
  lines(md)
    .filter((l) => /\[.\]/.test(l))
    .map((l) => `${/^\s/.test(l) ? "  " : ""}${l.trim()}`);
const BODY = ["- [ ] Alpha 4", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta", "", "paragraph 1."];

describe("A nests Delta under Gamma while B moves Gamma to the top", () => {
  for (const how of ["Move line up", "cut and paste"])
    for (const when of ["A's nest reaches B before B's pass", "B's move reaches A before A's pass"])
      it(`${how}, ${when}: both notes nest alike, the blank line before the paragraph stays`, async () => {
        const { a, b } = await twoVaults(BODY);
        // Step 3: Beta completed in A, synced.
        await a.pass(a.note().replace("- [ ] Beta", "- [x] Beta"));
        await reconnect(a, b);
        const delta = taskId(a.note(), "Delta");
        const gamma = taskId(a.note(), "Gamma");
        const md = a.note();
        const at = offset(md, block(md, "Delta")[0]);
        const tab = { from: at, to: at, insert: "\t" };
        const nested = applyChanges(md, indentWithNode(md, [tab]) ?? [tab]);
        let moved = b.note();
        let hints = {};
        if (how === "Move line up") {
          for (let k = 0; k < 2; k++) {
            const g = block(moved, "Gamma")[0];
            moved = applyChanges(moved, moveNodeLines(moved, g, g, "up")?.changes ?? []);
          }
          hints = { inserted: new Set([gamma]) };
        } else {
          const L = lines(moved);
          const [f, t] = block(moved, "Gamma");
          const clip = L.splice(f, t - f);
          L.splice(block(L.join("\n"), "Alpha 4")[0], 0, ...clip);
          moved = L.join("\n");
          hints = {
            deletedIds: new Set([gamma]),
            inserted: new Set([gamma]),
            cut: new Set([gamma]),
          };
        }
        if (when === "A's nest reaches B before B's pass") {
          await a.pass(nested, { inserted: new Set([delta]) });
          for (const [res, ra] of a.replicas) b.replicas.get(res)?.receiveChanges(ra.changes());
          await b.pass(moved, hints);
        } else {
          await b.pass(moved, hints);
          for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
          await a.pass(nested, { inserted: new Set([delta]) });
        }
        await reconnect(a, b);
        await reconnect(a, b);
        const want = ["- [ ] Gamma", "  - [ ] Delta", "- [ ] Alpha 4", "- [x] Beta"];
        expect(tree(a.note())).toEqual(want);
        expect(tree(b.note())).toEqual(want);
        for (const note of [a.note(), b.note()])
          expect(note).toMatch(/-->\n\n<!-- lfcp-node: paragraph/);
      });
});
