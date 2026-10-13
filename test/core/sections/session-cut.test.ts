// The session's last cut (session-cut.ts): it only recognises its own
// paste, in the note it was cut from, and does not outlive it. Up to
// 0.4.0-beta.14 the last cut went to every later pass of every note: a
// Move line next to a Task cut and pasted earlier named that Task as the
// one moved, and another copy still showing the cut Task was taken for its
// paste and undid the cut.

import { describe, expect, it } from "vitest";
import { SessionCut } from "../../../src/core/sections/session-cut";

describe("the session's last cut", () => {
  it("is pasted only where a user's paste in the note it came from re-inserts its bindings", () => {
    const c = new SessionCut();
    c.cut("Plan.md", ["gamma", "delta"]);
    // A paste there that re-inserts Gamma: Gamma is the cut's paste.
    expect([...c.pasted("Plan.md", new Set(["gamma"]))]).toEqual(["gamma"]);
    // Nothing re-inserted: no paste, whatever the note shows.
    expect([...c.pasted("Plan.md", new Set())]).toEqual([]);
    // Another note (another copy of the section) is never its paste.
    expect([...c.pasted("Copy.md", new Set(["gamma"]))]).toEqual([]);
  });

  it("is never a move hint on its own: a Move line next to it names only what it re-inserts", () => {
    const c = new SessionCut();
    c.cut("Plan.md", ["gamma"]);
    // Move line of Delta past Gamma: the editor's hint is Delta only.
    expect([...c.pasted("Plan.md", new Set(["delta"]))]).toEqual([]);
  });

  it("is done once a pass restored its nodes", () => {
    const c = new SessionCut();
    c.cut("Plan.md", ["gamma", "delta"]);
    c.restored(["gamma"]);
    expect(c.current).toEqual({ path: "Plan.md", ids: ["delta"] });
    c.restored(["delta"]);
    expect(c.current).toBeNull();
    expect([...c.pasted("Plan.md", new Set(["gamma", "delta"]))]).toEqual([]);
  });

  it("is superseded by the next cut, even one of plain text", () => {
    const c = new SessionCut();
    c.cut("Plan.md", ["gamma"]);
    c.cut("Other.md", ["beta"]);
    expect(c.current).toEqual({ path: "Other.md", ids: ["beta"] });
    c.cut("Other.md", []);
    expect(c.current).toBeNull();
  });

  it("follows its note's rename, and goes with its deletion", () => {
    const c = new SessionCut();
    c.cut("Plan.md", ["gamma"]);
    c.renamed("Plan.md", "Renamed.md");
    expect([...c.pasted("Renamed.md", new Set(["gamma"]))]).toEqual(["gamma"]);
    c.deleted("Renamed.md");
    expect(c.current).toBeNull();
  });

  it("a cut in a view without a note keeps nothing", () => {
    const c = new SessionCut();
    c.cut(null, ["gamma"]);
    expect(c.current).toBeNull();
  });
});
