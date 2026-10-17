// @vitest-environment happy-dom
// LFCP-03-049 on the real plugin, offline, sections on: the 0.1 pickers
// ("Share the task in…", "Insert a task from…", "Insert all tasks from…")
// offer 0.1 collaborations only. A shared section is not among them: it
// cannot hold 0.1 Tasks, and choosing it used to fail with "needs a newer
// version". With only a shared section on the device, the insert commands
// say so and point to "Insert shared section…", writing nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRefs } from "../../src/core/refs";
import { SoakPeer } from "../soak/peer";
import type { Answer } from "../support/e2e-vault";

const SERVER = "ws://127.0.0.1:9/v1/ws";
const ONLY_SECTIONS =
  'Shared Tasks: this device has shared sections, but no shared tasks to insert. Use "Insert shared section…" to place a section in a note.';

let A: SoakPeer;

/** Picks `label`, recording every label the picker offered. */
const pick = (offered: string[][], label: string): Answer => ({
  choose: (choices) => {
    offered.push(choices.map((c) => c.label));
    return choices.find((c) => c.label === label)?.value ?? null;
  },
});

beforeAll(async () => {
  // Nothing listens there, and the network is off: no server is used.
  A = await SoakPeer.open("A", "a", SERVER, 1);
  A.vault.network.offline = true;
  await A.runtime.createSectionResource({
    name: "Launch",
    endpoints: [SERVER],
    coordinatorUrl: SERVER,
  });
}, 60_000);

afterAll(async () => {
  await A?.vault.close();
});

describe("LFCP-03-049: the 0.1 pickers offer 0.1 collaborations only", () => {
  it("only a shared section here: both insert commands refuse before any picker, nothing is written", async () => {
    const note = "# Inbox\n\nkeep\n";
    await A.vault.write("inbox.md", note);
    for (const id of ["insert-all-tasks", "insert-shared-object"]) {
      A.vault.focus("inbox.md", "# Inbox");
      expect(await A.vault.command(id)).toBe(ONLY_SECTIONS);
    }
    expect(A.vault.read("inbox.md")).toBe(note);
  });

  it("a 0.1 collaboration is offered, a section is not; its Task is shared and inserted", async () => {
    expect(await A.vault.command("create-collaboration", ["Team", SERVER])).toContain(
      '"Team" created on this device',
    );
    const offered: string[][] = [];
    await A.vault.write("plan.md", "# Plan\n- [ ] Ship LEGACYPICK\n");
    A.vault.focus("plan.md", "LEGACYPICK");
    expect(await A.vault.command("share-task-under-cursor", [pick(offered, "Team")])).toBe(
      "Shared Tasks: task shared.",
    );
    const [ref] = scanRefs(A.vault.read("plan.md")).projections;
    expect(ref).toBeDefined();

    await A.vault.write("one.md", "# One\n");
    A.vault.focus("one.md", "# One");
    expect(
      await A.vault.command("insert-shared-object", [pick(offered, "Team"), "Ship LEGACYPICK"]),
    ).toBe("Shared Tasks: shared task inserted.");
    expect(scanRefs(A.vault.read("one.md")).projections.map((p) => p.objectId)).toEqual([
      ref?.objectId,
    ]);

    await A.vault.write("all.md", "# All\n");
    A.vault.focus("all.md", "# All");
    expect(await A.vault.command("insert-all-tasks", [pick(offered, "Team")])).toBe(
      "Shared Tasks: 1 shared task inserted.",
    );
    expect(A.vault.read("all.md")).toContain("- [ ] Ship LEGACYPICK");

    // Each picker offered the collaboration and the way to create one, never the section.
    expect(offered).toEqual([["Team", "Create a new collaboration…"], ["Team"], ["Team"]]);
  });
});
