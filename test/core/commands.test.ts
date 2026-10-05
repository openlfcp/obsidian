import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/core/commands";

describe("commands", () => {
  it("are the LFCP-065 product UI set and its conflict hook, with unique IDs", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "Share task under cursor",
      "Insert shared object",
      "Create collaboration",
      "Join collaboration",
      "Invite collaborator",
      "Resource status",
      "Detach shared task",
      "Resolve shared task conflict",
    ]);
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
