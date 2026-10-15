// @vitest-environment happy-dom
// LFCP-03-043 (obsidian#35): a copy of a shared section in another note has
// no base. When its Task's title differs from the shared Task, the copy is
// not taken as showing the model: its edit is kept as it is (a base-unknown
// comparison candidate), never published and never overwritten by the model
// on a later pass. Up to the fix, the first pass seeded a base from the
// edited copy and the next one rendered the shared title over the edit. A
// copy that shows the model seeds as before and follows it. One real plugin
// on the reference server. Skipped without the server unless
// LFCP_REQUIRE_LIVE=1 (then an error).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  await A.share(3, ["a"]);
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await server?.stop();
});

/** The section's lines of the shared note: its heading through its end marker. */
function sectionBlock(md: string): string {
  const lines = md.split("\n");
  const from = lines.indexOf("## Work");
  const to = lines.findIndex((l) => /^<!-- \/lfcp-section: /.test(l));
  if (from < 0 || to < from) throw new Error("no section block");
  return lines.slice(from, to + 1).join("\n");
}

/** A few more passes on every note, with the plugin's own ticks in between. */
async function passes(paths: readonly string[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const p of paths) await A.vault.write(p, A.vault.read(p));
    await new Promise((r) => setTimeout(r, 600));
    await A.vault.settle();
  }
}

describe.skipIf(!live)("a copied section without a base (LFCP-03-043)", () => {
  it("keeps a Task title edited in the copy; a copy that shows the model follows it", async () => {
    await until(
      "A current",
      async () =>
        (await A.sectionStates()).every((s) => s.state === "CURRENT") ? true : undefined,
      60_000,
    );
    const shared = A.vault.read(SECTION_NOTE);
    const block = sectionBlock(shared);
    const title = /- \[ \] (a1 [^<\n]*?)(?=\s*(<!--|\n|$))/.exec(block)?.[1];
    expect(title).toBeDefined();

    const edited = `# Copy\n\n${block.replace(title as string, "a1 Local edit")}\n`;
    const same = `# Same\n\n${block}\n`;
    await A.vault.write("Copy.md", edited);
    await A.vault.write("Same.md", same);
    await passes(["Copy.md", "Same.md", SECTION_NOTE]);

    // The edit stays in the copy; the shared Task and its note keep the title.
    expect(A.vault.read("Copy.md")).toBe(edited);
    expect(A.vault.read(SECTION_NOTE)).toContain(title as string);
    expect(A.vault.read(SECTION_NOTE)).not.toContain("a1 Local edit");
    expect(A.vault.read("Same.md")).toBe(same);

    // A restart (bases, journal and candidates from storage): still kept.
    await A.vault.shutdown("clean");
    await A.vault.boot(false);
    await passes(["Copy.md", "Same.md", SECTION_NOTE]);
    expect(A.vault.read("Copy.md")).toBe(edited);
    expect(A.vault.read(SECTION_NOTE)).not.toContain("a1 Local edit");

    // The copy that shows the model seeded a base: an edit there is shared.
    await A.vault.write("Same.md", same.replace(title as string, "a1 From the copy"));
    await until(
      "the shared note follows the seeded copy",
      async () => {
        await A.vault.settle();
        return A.vault.read(SECTION_NOTE).includes("a1 From the copy") ? true : undefined;
      },
      60_000,
    );
    // The edited copy still keeps its own title (no base, nothing rendered over it).
    await passes(["Copy.md"]);
    expect(A.vault.read("Copy.md")).toBe(edited);
  }, 300_000);
});
