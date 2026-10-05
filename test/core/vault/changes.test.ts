import { describe, expect, it } from "vitest";
import { type VaultChange, VaultChangeHub } from "../../../src/core/vault/changes";

const timers = () => {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    pending,
    setTimeout: (fn: () => void) => {
      pending.set(++n, fn);
      return n;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    fire: () => {
      for (const [k, fn] of [...pending]) {
        pending.delete(k);
        fn();
      }
    },
  };
};

describe("VaultChangeHub (LFCP-059)", () => {
  it("batches Markdown changes after a quiet period, the last change per path winning", () => {
    const t = timers();
    const hub = new VaultChangeHub(t, 300);
    const got: (readonly VaultChange[])[] = [];
    hub.subscribe((b) => got.push(b));
    hub.record({ kind: "create", path: "a.md" });
    hub.record({ kind: "modify", path: "a.md" });
    hub.record({ kind: "modify", path: "b.MD" });
    hub.record({ kind: "modify", path: "c.canvas" });
    expect(t.pending.size).toBe(1); // one debounce timer
    t.fire();
    expect(got).toEqual([
      [
        { kind: "modify", path: "a.md" },
        { kind: "modify", path: "b.MD" },
      ],
    ]);
  });

  it("keeps a rename into or out of Markdown, and drops everything on close", () => {
    const t = timers();
    const hub = new VaultChangeHub(t);
    const got: (readonly VaultChange[])[] = [];
    hub.subscribe((b) => got.push(b));
    hub.record({ kind: "rename", path: "notes.txt", oldPath: "notes.md" });
    hub.close();
    expect(t.pending.size).toBe(0);
    hub.record({ kind: "modify", path: "x.md" });
    hub.flush();
    expect(got).toEqual([]);
  });
});
