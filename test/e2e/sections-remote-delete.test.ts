// @vitest-environment happy-dom
// A collaborator deletes a Task of a shared section (soak #5): the other
// vault's note loses it, and its badge is current, with nothing to review.
// Up to the fix, the pass that received the deletion reported the Task as
// shown again while deleted (it was, in the text the pass read, not in the
// text it wrote): the badge said the note differs from the shared version,
// and "Review conflicts…" offered to restore a Task the note no longer
// showed, until a later pass, which a quiet note never had. Two real
// plugins (sections on, a CodeMirror editor each) on the reference server.
// Skipped without the server unless LFCP_REQUIRE_LIVE=1 (then an error).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
  const { resource } = await A.share(6, ["a", "b"]);
  await B.join(await A.invite(resource), "Soak");
  await B.insert(resource);
  A.openEditor();
  B.openEditor();
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

const current = async (p: SoakPeer) =>
  (await p.sectionStates()).every((s) => s.state === "CURRENT") ? true : undefined;

describe.skipIf(!live)("a collaborator's deletion (soak #5)", () => {
  it("leaves the other note without the Task, current, nothing to review", async () => {
    await until("A current", () => current(A), 60_000);
    await until("B current", () => current(B), 60_000);
    expect(A.text(SECTION_NOTE)).toContain("b2 draft item");
    B.deleteTask("b2 draft item");
    await until(
      "A's note without the Task",
      () => (A.text(SECTION_NOTE).includes("b2 draft item") ? undefined : true),
      60_000,
    );
    // Quiet: nothing else happens in either note.
    await new Promise((r) => setTimeout(r, 3000));
    expect(await A.sectionStates()).toEqual([
      expect.objectContaining({ state: "CURRENT", conditions: [] }),
    ]);
    expect(await A.reviewConflicts()).toBe(false);
    expect(await B.sectionStates()).toEqual([
      expect.objectContaining({ state: "CURRENT", conditions: [] }),
    ]);
  }, 120_000);
});
