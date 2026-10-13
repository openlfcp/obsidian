// A collaborator's change to a Task a move of this vault re-indented, while
// that move's pass was abandoned (sweep seed 4839, 0.4.0-beta.15): B nests
// b1 (with a1 under it) under Gamma; its pass commits the move but its
// changes are not written; A retitles a1. B's next passes resume the move
// into the base, whose lines keep the old indentation, while the note shows
// the new one. A Task line's indentation is structure, not a field edit:
// A's title is rendered in B's note, not held as B's own edit for ever.

import { describe, expect, it } from "vitest";
import { lines, twoVaults } from "../../support/section-vaults";

const tasks = (md: string) =>
  md
    .split("\n")
    .filter((l) => /^\s*- \[.\] /.test(l))
    .map((l) => l.trim());

describe("a remote change to a Task an abandoned move of this vault re-indented", () => {
  for (const written of [false, true])
    it(`is rendered (the move's pass ${written ? "written" : "abandoned"})`, async () => {
      const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] Gamma", "- [ ] b1", "  - [ ] a1"]);
      // B: Tab on b1, its ref, its child a1 and a1's ref along; one pass.
      const L = lines(b.note());
      const from = L.findIndex((l) => l.includes("] b1"));
      for (let i = from; i < from + 4; i++) L[i] = `\t${L[i]}`;
      const tabbed = L.join("\n");
      if (written) await b.pass(tabbed);
      else
        await b.engine.pass("Plan.md", tabbed, {
          caretLine: null,
          deletedIds: new Set(),
          origin: "other",
        });
      await a.pass(a.note().replace("- [ ] a1", "- [ ] a1 edited"));
      // The network: both replicas exchange; each passes its own note.
      const ra = a.replica();
      const rb = b.replica();
      const fromA = ra.changes();
      ra.receiveChanges(rb.changes());
      rb.receiveChanges(fromA);
      let md = written ? b.note() : tabbed;
      for (let i = 0; i < 3; i++) {
        await a.pass(a.note());
        await b.pass(md);
        md = b.note();
      }
      expect(tasks(b.note())).toEqual([
        "- [ ] Alpha",
        "- [ ] Gamma",
        "- [ ] b1",
        "- [ ] a1 edited",
      ]);
      expect(tasks(b.note())).toEqual(tasks(a.note()));
      // Nested as the model nests them: under Gamma, a1 under b1.
      expect(b.note()).toMatch(/\t- \[ \] b1\n[^\n]*\n\t {2}- \[ \] a1 edited/);
    });
});
