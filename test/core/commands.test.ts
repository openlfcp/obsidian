import { describe, expect, it } from "vitest";
import { COMMANDS, notImplementedMessage } from "../../src/core/commands";

describe("commands", () => {
  it("are the LFCP-065 product UI set, with unique IDs", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "Share task under cursor",
      "Insert shared object",
      "Create collaboration",
      "Join collaboration",
      "Invite collaborator",
      "Resource status",
      "Detach shared task",
    ]);
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("stub message names the command", () => {
    const [first] = COMMANDS;
    expect(first && notImplementedMessage(first)).toBe(
      'OpenLFCP: "Share task under cursor" is not implemented yet.',
    );
  });
});
