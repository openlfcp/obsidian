import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/core/commands";

describe("commands", () => {
  it("are the LFCP-065 product UI set, its conflict hook and the POST-018 batch commands, with unique IDs", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "Share task under cursor",
      "Insert shared object",
      "Share selected tasks",
      "Insert all tasks from collaboration",
      "Create collaboration",
      "Join collaboration",
      "Invite collaborator",
      "Resource status",
      "Detach shared task",
      "Resolve shared task conflict",
      "Show or hide sharing metadata",
    ]);
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    // Obsidian's guidelines: sentence case, and no plugin name (the palette adds it).
    for (const { name } of COMMANDS) {
      expect(name.slice(1)).toBe(name.slice(1).toLowerCase());
      expect(name.toLowerCase()).not.toContain("shared tasks:");
    }
  });
});
