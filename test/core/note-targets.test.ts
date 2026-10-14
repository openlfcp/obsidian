// The note a flow acts on, followed across renames (LFCP-03-002): one
// identity for every holder while held, moved by a rename, without a path
// once deleted; a new identity once nobody holds it.

import { describe, expect, it } from "vitest";
import { NoteTargets } from "../../src/core/note-targets";

describe("NoteTargets", () => {
  it("holders of one note share its identity; a rename moves it, the new path finds it", () => {
    const t = new NoteTargets();
    const a = t.hold("A.md");
    const again = t.hold("A.md");
    expect(again.target.id).toBe(a.target.id);
    expect(t.hold("B.md").target.id).not.toBe(a.target.id);
    t.renamed("A.md", "Renamed.md");
    expect(a.target.path).toBe("Renamed.md");
    expect(t.hold("Renamed.md").target.id).toBe(a.target.id);
    // The old path is another note now.
    expect(t.hold("A.md").target.id).not.toBe(a.target.id);
  });

  it("a deleted note has no path; a note nobody holds gets a new identity", () => {
    const t = new NoteTargets();
    const a = t.hold("A.md");
    t.deleted("A.md");
    expect(a.target.path).toBeNull();
    const b = t.hold("B.md");
    const id = b.target.id;
    b.release();
    b.release(); // twice: once
    expect(t.hold("B.md").target.id).not.toBe(id);
    // Not held: a rename or a delete is nothing to it.
    t.renamed("C.md", "D.md");
    t.deleted("E.md");
  });
});
