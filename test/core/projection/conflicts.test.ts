import { describe, expect, it } from "vitest";
import { ConflictRegistry, conflictTitle } from "../../../src/core/projection/conflicts";

const rendered = (line: number, key: string, conflicts: string[]) =>
  ({ line, key, changed: [], conflicts, issues: [] }) as never;

describe("ConflictRegistry (LFCP-062 item 5)", () => {
  it("keeps per-note marks of surfaced fields, counts objects and notifies on change", () => {
    const r = new ConflictRegistry();
    let changes = 0;
    r.onChange(() => changes++);
    r.update("a.md", [rendered(0, "k1", ["due", "status"]), rendered(3, "k2", [])]);
    r.update("b.md", [rendered(1, "k1", ["due"])]);
    expect(r.marks("a.md")).toEqual([{ line: 0, key: "k1", fields: ["due", "status"] }]);
    expect(r.count).toBe(1);
    expect(r.summary()).toBe("OpenLFCP: 1 shared task has a conflict");
    r.update("b.md", [rendered(1, "k1", ["due"])]); // unchanged: no notification
    expect(changes).toBe(2);
    r.rename("b.md", "c.md");
    r.update("a.md", []);
    expect(r.marks("a.md")).toEqual([]);
    expect(r.marks("c.md").length).toBe(1);
    r.forget("c.md");
    expect(r.summary()).toBe("");
    expect(conflictTitle({ line: 0, key: "k", fields: ["status"] })).toContain("status");
  });
});
