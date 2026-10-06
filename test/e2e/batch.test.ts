// POST-018 live: "Share selected tasks" in vault A shares the three Tasks
// under a heading in one command; "Insert all tasks from collaboration" in
// vault B places all three; edits then sync both ways. Two vaults, the real
// reference server, real WebSockets, the plugin driven through its
// commands. Skipped without cargo or ../server unless LFCP_REQUIRE_LIVE=1.

import type { ResourceId } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRefs } from "../../src/core/refs";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { E2EVault, until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

const PATH_A = "a-batch.md";
const PATH_B = "b-batch.md";
const NOTE_A = `# Plan

## Sprint
- [ ] One BATCHMARK
  - [ ] Two nested BATCHMARK
- [ ] Three BATCHMARK

## Later
- [ ] Stays local
`;

let server: E2EServer;
let A: E2EVault;
let B: E2EVault;
let R: ResourceId;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await E2EVault.open("A");
  B = await E2EVault.open("B");
}, 300_000);

afterAll(async () => {
  await A?.close();
  await B?.close();
  await server?.stop();
});

const pending = async (v: E2EVault) => (await v.runtime.storage?.outbound.list())?.length ?? 0;
const taskLines = (text: string) =>
  text.split("\n").filter((l) => /^\s*- \[.\] /.test(l) && l.includes("BATCHMARK"));

describe.skipIf(!live)("share and insert many tasks at once (POST-018)", () => {
  it("1. A shares the three Tasks under ## Sprint in one command", async () => {
    await A.write(PATH_A, NOTE_A);
    expect(await A.command("create-collaboration", ["Batch", server.url])).toContain(
      "created and hosted",
    );
    R = (await A.runtime.registry()).find((e) => e.localName === "Batch")?.resourceId as ResourceId;
    A.focus(PATH_A, "## Sprint");
    expect(await A.command("share-selected-tasks", ["Batch"])).toBe(
      "Shared Tasks: 3 tasks shared.",
    );
    const scan = scanRefs(A.read(PATH_A));
    expect(scan.projections).toHaveLength(3);
    expect(scan.tasks.filter((t) => t.binding === "local")).toHaveLength(1); // ## Later
    await until("A's three Tasks on the server", async () =>
      (await pending(A)) === 0 ? true : undefined,
    );
  }, 120_000);

  it("2. B joins and inserts all three, in A's order", async () => {
    await A.command("invite-collaborator", ["Batch", "Read + write"]);
    const link = A.prompter.invitations.at(-1)?.reveal() as string;
    expect(await B.command("join-collaboration", [link, "Batch at B"])).toContain("joined");
    await until("the three Tasks on B", async () =>
      (await B.runtime.profileOf(R)).replica.objectIds().length === 3 ? true : undefined,
    );
    await B.write(PATH_B, "# From A\n");
    B.focus(PATH_B, "# From A");
    expect(await B.command("insert-all-tasks", ["Batch at B"])).toBe(
      "Shared Tasks: 3 shared tasks inserted.",
    );
    const b = B.read(PATH_B);
    expect(scanRefs(b).projections.map((p) => p.objectId)).toEqual(
      scanRefs(A.read(PATH_A)).projections.map((p) => p.objectId),
    );
    // Nesting is local presentation: B shows three Tasks of its own level.
    expect(taskLines(b)).toEqual([
      "- [ ] One BATCHMARK",
      "- [ ] Two nested BATCHMARK",
      "- [ ] Three BATCHMARK",
    ]);
  }, 120_000);

  it("3. edits sync both ways", async () => {
    await B.editLine(PATH_B, "- [ ] One BATCHMARK", "- [x] One BATCHMARK");
    await until("B's completion in A's note", () =>
      A.read(PATH_A).includes("- [x] One BATCHMARK") ? true : undefined,
    );
    await A.editLine(PATH_A, "- [ ] Three BATCHMARK", "- [ ] Three BATCHMARK renamed");
    await until("A's rename in B's note", () =>
      B.read(PATH_B).includes("- [ ] Three BATCHMARK renamed") ? true : undefined,
    );
    expect(taskLines(A.read(PATH_A))).toEqual([
      "- [x] One BATCHMARK",
      "  - [ ] Two nested BATCHMARK",
      "- [ ] Three BATCHMARK renamed",
    ]);
  }, 120_000);
});
