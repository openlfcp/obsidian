// LFCP-02-041: one source per note across editor views, file events,
// external writes and renames; passes coalesced per note.

import { describe, expect, it } from "vitest";
import { type PassRequest, SourceCoordinator } from "../../../src/core/sections/coordinator";

/** A coordinator whose passes are recorded and can be held open. */
function harness() {
  const passes: PassRequest[] = [];
  const errors: unknown[] = [];
  let hold: Promise<void> | null = null;
  let release: () => void = () => {};
  const c = new SourceCoordinator(
    async (r) => {
      passes.push(r);
      if (hold !== null) await hold;
      if (r.source.includes("THROW")) throw new Error("pass failed");
    },
    (_p, e) => errors.push(e),
  );
  return {
    c,
    passes,
    errors,
    holdNext() {
      hold = new Promise((r) => {
        release = () => {
          hold = null;
          r();
        };
      });
    },
    release: () => release(),
  };
}

const brief = (p: PassRequest) => [p.path, p.route, p.source, [...p.triggers].sort().join("+")];

describe("one source per note", () => {
  it("reconciles a closed note from its file, and an open one only from its editor", async () => {
    const h = harness();
    h.c.fileChanged("a.md", "v1");
    await h.c.whenIdle("a.md");
    h.c.opened("a.md", "view-1", "v1");
    expect(h.c.route("a.md")).toBe("editor");
    h.c.editorChanged("a.md", "v1 typed");
    await h.c.whenIdle("a.md");
    // The file lags behind the editor (autosave, or an external write the editor reloads next).
    h.c.fileChanged("a.md", "v1");
    h.c.fileChanged("a.md", "external");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "file", "v1", "local"],
      ["a.md", "editor", "v1 typed", "local"],
    ]);
  });

  it("split views share one source and write through the editor route", async () => {
    const h = harness();
    h.c.opened("a.md", "left", "v1");
    h.c.opened("a.md", "right", "v1");
    h.c.editorChanged("a.md", "v2");
    await h.c.whenIdle("a.md");
    h.c.closed("a.md", "left");
    expect(h.c.route("a.md")).toBe("editor");
    h.c.closed("a.md", "right");
    expect(h.c.route("a.md")).toBe("file");
    h.c.fileChanged("a.md", "v2 saved");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "editor", "v2", "local"],
      ["a.md", "file", "v2 saved", "local"],
    ]);
  });

  it("repeated notifications of a reconciled source plan nothing; a remote change still projects", async () => {
    const h = harness();
    h.c.fileChanged("a.md", "v1");
    await h.c.whenIdle("a.md");
    h.c.fileChanged("a.md", "v1");
    h.c.fileChanged("a.md", "v1");
    await h.c.whenIdle("a.md");
    h.c.remoteChanged("a.md");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "file", "v1", "local"],
      ["a.md", "file", "v1", "remote"],
    ]);
  });

  it("an editor brought back to the source last reconciled runs no pass, and says so (its hints are dropped)", async () => {
    const settled: string[] = [];
    const passes: string[] = [];
    const c = new SourceCoordinator(
      async (r) => {
        passes.push(r.source);
      },
      () => {},
      (path) => settled.push(path),
    );
    c.opened("a.md", "v", "v1");
    c.editorChanged("a.md", "v2");
    await c.whenIdle("a.md");
    // Typed, then undone: the source of the last pass again.
    c.editorChanged("a.md", "v2");
    await c.whenIdle("a.md");
    expect(passes).toEqual(["v2"]);
    expect(settled).toEqual(["a.md"]);
  });
});

describe("coalescing", () => {
  it("events during a pass make one more pass, with the latest source and every trigger", async () => {
    const h = harness();
    h.c.opened("a.md", "v", "v0");
    h.holdNext();
    h.c.editorChanged("a.md", "v1");
    // Typing and a remote change while the first pass runs.
    h.c.editorChanged("a.md", "v12");
    h.c.remoteChanged("a.md");
    h.c.editorChanged("a.md", "v123");
    h.release();
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "editor", "v1", "local"],
      ["a.md", "editor", "v123", "local+remote"],
    ]);
  });

  it("a slow pass delays only its own note", async () => {
    const h = harness();
    h.holdNext();
    h.c.fileChanged("slow.md", "s");
    h.c.fileChanged("fast.md", "f");
    await Promise.resolve();
    expect(h.passes.map((p) => p.path)).toEqual(["slow.md", "fast.md"]);
    h.release();
    await h.c.whenIdle("slow.md");
  });

  it("a failed pass is reported and the note is reconciled again on its next event", async () => {
    const h = harness();
    h.c.fileChanged("a.md", "THROW");
    await h.c.whenIdle("a.md");
    expect(h.errors).toHaveLength(1);
    h.c.fileChanged("a.md", "THROW");
    await h.c.whenIdle("a.md");
    expect(h.passes).toHaveLength(2);
  });
});

describe("rename and deletion", () => {
  it("a note renamed while a pass is queued is reconciled under its new path", async () => {
    const h = harness();
    h.holdNext();
    h.c.fileChanged("old.md", "v1");
    h.c.fileChanged("old.md", "v2");
    h.c.renamed("old.md", "new.md");
    expect(h.c.route("new.md")).toBe("file");
    h.release();
    await h.c.whenIdle("new.md");
    expect(h.passes.map(brief)).toEqual([
      ["old.md", "file", "v1", "local"],
      ["new.md", "file", "v2", "local"],
    ]);
  });

  it("a deleted note is forgotten", async () => {
    const h = harness();
    h.c.opened("a.md", "v", "v1");
    h.c.deleted("a.md");
    expect(h.c.route("a.md")).toBe("file");
    await h.c.whenIdle("a.md");
  });
});

describe("the text a pass wrote (the idle editor that reverted a collaborator's edit, 0.4.0-beta.13)", () => {
  it("is the source of the next pass: a remote change is projected onto it, not onto the text before the write", async () => {
    const h = harness();
    h.c.opened("a.md", "view", "v1");
    h.c.remoteChanged("a.md");
    await h.c.whenIdle("a.md");
    // The pass wrote the first remote change into the editor (no user transaction).
    h.c.written("a.md", "v1 + remote 1");
    h.c.remoteChanged("a.md");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "editor", "v1", "remote"],
      ["a.md", "editor", "v1 + remote 1", "remote"],
    ]);
  });

  it("is reconciled, also when written during the pass: the same text again runs no pass", async () => {
    const h = harness();
    h.c.opened("a.md", "view", "v1");
    h.holdNext();
    h.c.remoteChanged("a.md");
    await Promise.resolve();
    h.c.written("a.md", "v2");
    h.release();
    await h.c.whenIdle("a.md");
    h.c.editorChanged("a.md", "v2");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([["a.md", "editor", "v1", "remote"]]);
  });

  it("of a closed note is its file source", async () => {
    const h = harness();
    h.c.fileChanged("a.md", "v1");
    await h.c.whenIdle("a.md");
    h.c.written("a.md", "v1 rewritten");
    h.c.remoteChanged("a.md");
    await h.c.whenIdle("a.md");
    expect(h.passes.map(brief)).toEqual([
      ["a.md", "file", "v1", "local"],
      ["a.md", "file", "v1 rewritten", "remote"],
    ]);
  });
});

describe("a change while a pass writes (soak finding #9)", () => {
  it("stays the source: the next pass takes it, and the editor's hints are not dropped", async () => {
    const passes: PassRequest[] = [];
    const settled: string[] = [];
    let during: (() => void) | null = null;
    const c = new SourceCoordinator(
      async (r) => {
        passes.push(r);
        // The pass wrote nothing new; the user pastes before it is done writing.
        during?.();
        during = null;
        c.written(r.path, r.source);
      },
      () => {},
      (p) => settled.push(p),
    );
    c.opened("a.md", "view", "cut");
    during = () => c.editorChanged("a.md", "cut, then pasted");
    c.editorChanged("a.md", "cut");
    await c.whenIdle("a.md");
    expect(passes.map((p) => p.source)).toEqual(["cut", "cut, then pasted"]);
    expect(settled).toEqual([]);
  });

  it("a closed note's file changing while its pass writes is passed again too", async () => {
    const passes: PassRequest[] = [];
    let during: (() => void) | null = null;
    const c = new SourceCoordinator(async (r) => {
      passes.push(r);
      during?.();
      during = null;
      c.written(r.path, r.source);
    });
    during = () => c.fileChanged("a.md", "v2");
    c.fileChanged("a.md", "v1");
    await c.whenIdle("a.md");
    expect(passes.map((p) => p.source)).toEqual(["v1", "v2"]);
  });

  it("an open note's file event (autosave) during a pass does not ask for another", async () => {
    const passes: PassRequest[] = [];
    let during: (() => void) | null = null;
    const c = new SourceCoordinator(async (r) => {
      passes.push(r);
      during?.();
      during = null;
      c.written(r.path, `${r.source} written`);
    });
    c.opened("a.md", "view", "v1");
    during = () => c.fileChanged("a.md", "v1");
    c.editorChanged("a.md", "v1 typed");
    await c.whenIdle("a.md");
    expect(passes.map((p) => p.source)).toEqual(["v1 typed"]);
  });
});
