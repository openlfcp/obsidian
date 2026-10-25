import { describe, expect, it } from "vitest";
import { COMMANDS, INVITE_TO_SECTION } from "../../src/core/commands";

describe("commands", () => {
  it("are the LFCP-065 product UI set, its conflict hook and the POST-018 batch commands, with unique IDs", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "Legacy: Share task under cursor",
      "Legacy: Insert shared object",
      "Legacy: Share selected tasks",
      "Legacy: Insert all tasks from task collaboration",
      "Legacy: Create task collaboration",
      "Legacy: Join task collaboration",
      "Legacy: Invite to task collaboration",
      "Resource status",
      "Detach shared task",
      "Resolve shared task conflict",
      "Show or hide sharing metadata",
    ]);
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    // Obsidian's guidelines: sentence case, and no plugin name (the palette adds it).
    for (const { name: full } of COMMANDS) {
      const name = full.replace(/^Legacy: /, "");
      expect(name.slice(1)).toBe(name.slice(1).toLowerCase());
      expect(name.toLowerCase()).not.toContain("shared tasks:");
    }
  });

  it("UX-01: the six 0.1 commands wait for 0.1 data; the way into a 0.1 collaboration is always there", () => {
    const legacy = COMMANDS.filter((c) => c.legacy !== undefined);
    expect(legacy.map((c) => c.id)).toEqual([
      "share-task-under-cursor",
      "insert-shared-object",
      "share-selected-tasks",
      "insert-all-tasks",
      "create-collaboration",
      "join-collaboration",
      "invite-collaborator",
    ]);
    expect(legacy.filter((c) => c.legacy === "always").map((c) => c.id)).toEqual([
      "join-collaboration",
    ]);
    for (const c of legacy) expect(c.name).toMatch(/^Legacy: /);
    // The others are not 0.1 commands and keep their names.
    expect(COMMANDS.filter((c) => c.legacy === undefined).map((c) => c.name)).toEqual([
      "Resource status",
      "Detach shared task",
      "Resolve shared task conflict",
      "Show or hide sharing metadata",
    ]);
    expect(INVITE_TO_SECTION).toMatchObject({
      id: "invite-to-section",
      name: "Invite to this section…",
    });
  });
});
