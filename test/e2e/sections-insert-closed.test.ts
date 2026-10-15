// @vitest-environment happy-dom
// LFCP-03-016: a section inserted into a closed note, which is then passed
// through its file. Up to the fix, that pass could end after the note was
// opened and a Task deleted there: the deletion was dropped as settled and
// never sent (sections-remote-delete with the pass). Here B inserts into
// its closed note and keeps it closed while A deletes a Task: B's file
// loses it. Then B opens the note at once and deletes another Task: A's
// note loses that one. Two real plugins on the reference server. Skipped
// without the server unless LFCP_REQUIRE_LIVE=1 (then an error).

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
  // Into B's closed note: written through its file, then passed there.
  await B.insert(resource);
  A.openEditor();
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

describe.skipIf(!live)("a section inserted into a closed note", () => {
  it("a peer's deletion reaches the closed note; a deletion made there right after opening reaches the peer", async () => {
    expect(B.vault.read(SECTION_NOTE)).toContain("a3 review item");
    A.deleteTask("a3 review item");
    await until(
      "B's closed note without a3",
      () => (B.vault.read(SECTION_NOTE).includes("a3 review item") ? undefined : true),
      60_000,
    );
    B.openEditor();
    B.deleteTask("b4 ship item");
    await until(
      "A's note without b4",
      () => (A.text(SECTION_NOTE).includes("b4 ship item") ? undefined : true),
      60_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    expect(B.text(SECTION_NOTE)).not.toContain("b4 ship item");
    expect(A.text(SECTION_NOTE)).not.toContain("a3 review item");
    expect(await B.sectionStates()).toEqual([
      expect.objectContaining({ state: "CURRENT", conditions: [] }),
    ]);
  }, 120_000);
});
