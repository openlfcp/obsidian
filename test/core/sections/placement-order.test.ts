// Moves in one pass that follow each other: a Task moved after a pasted one
// went where the paste was cut from, its placement sent before the pasted
// Task's. The peer-structure property test found it (seed 235).

import { describe, expect, it } from "vitest";
import { block, lines, taskId, twoVaults } from "../../support/section-vaults";

const tasks = (md: string) => lines(md).filter((l) => /\[ \]/.test(l));

describe("a Task moved after a cut Task pasted elsewhere, in one pass", () => {
  it("stays after it where the note shows them", async () => {
    const { a, b } = await twoVaults([
      "- [ ] Alpha",
      "- [ ] W",
      "- [ ] Y",
      "- [ ] Z",
      "",
      "A paragraph.",
    ]);
    const w = taskId(b.note(), "W");
    const z = taskId(b.note(), "Z");
    // B cuts W.
    const L = lines(b.note());
    const [wf, wt] = block(b.note(), "W");
    const clip = L.splice(wf, wt - wf);
    await b.pass(L.join("\n"), { deletedIds: new Set([w]), cut: new Set([w]) });
    // B pastes W after the paragraph and moves Z after it (Alt+Down).
    const md = b.note();
    const M = lines(md);
    const [zf, zt] = block(md, "Z");
    const zLines = M.splice(zf, zt - zf);
    M.splice(M.indexOf("A paragraph.") + 1, 0, ...clip, ...zLines);
    const note = M.join("\n");
    await b.pass(note, { deletedIds: new Set(), inserted: new Set([z, w]), cut: new Set([w]) });
    expect(tasks(b.note())).toEqual(["- [ ] Alpha", "- [ ] Y", "- [ ] W", "- [ ] Z"]);
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    await a.pass(a.note());
    await a.pass(a.note());
    expect(tasks(a.note())).toEqual(["- [ ] Alpha", "- [ ] Y", "- [ ] W", "- [ ] Z"]);
  });
});
