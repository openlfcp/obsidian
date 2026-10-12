// A Text edit goes against the revision its base Text came from. A pass the
// typing coalescer committed later moved the base's Text but not its stored
// revision (0.4.0-beta.5): the next edit of the node was refused
// (INVALID_INTENT), kept as "rejected", and the section stayed
// LOCAL_SAVE_FAILED for good. A vault in that state heals at its next pass.

import { describe, expect, it } from "vitest";
import { PATH, reconnect, twoVaults } from "../../support/section-vaults";

const BODY = ["- [ ] One", "- [ ] Two", "", "A paragraph for typing."];

/** The section's lines of `md`, from its heading to its end marker, as a kept candidate holds them. */
const sectionText = (md: string) => {
  const L = md.split("\n");
  const from = L.findIndex((l) => l.startsWith("## "));
  const to = L.findIndex((l) => l.startsWith("<!-- /lfcp-section"));
  return L.slice(from, to + 1)
    .map((l) => `${l}\n`)
    .join("");
};

describe("a base whose stored revision fell behind its Text (0.4.0-beta.5)", () => {
  it("heals at the next pass: the edit commits, the kept copy it supersedes is resolved", async () => {
    const { a, b } = await twoVaults(BODY);
    const before = a.model()?.revision as string;
    const typed = a.note().replace("A paragraph for typing.", "A paragraph for typing. 日本");
    await a.pass(typed);
    const pid = Object.entries(a.model()?.nodes ?? {}).find(
      ([, n]) => n.kind === "paragraph",
    )?.[0] as string;
    expect(a.model()?.nodes[pid]?.text).toBe("A paragraph for typing. 日本");
    // The persisted beta.5 state: the base holds the new Text at the revision before it.
    const [projection] = await a.bases.projectionsOf(PATH);
    const stored = await a.bases.load(projection as string);
    if (stored === undefined) throw new Error("no base");
    await a.bases.save(projection as string, {
      ...stored,
      nodeRevisions: { ...(stored.nodeRevisions ?? {}), [pid]: before },
    });
    const deleted = a.note().replace(" 日本", "");
    await a.journal.putCandidate({
      candidateId: "beta5-refused",
      projectionId: projection as string,
      reason: "rejected",
      sourceText: sectionText(deleted),
    });

    const r = await a.pass(deleted);
    expect(r?.local?.kind).toBe("committed");
    expect(a.model()?.nodes[pid]?.text).toBe("A paragraph for typing.");
    expect(await a.journal.candidates(projection as string)).toEqual([]);
    await reconnect(a, b);
    expect(b.note()).toContain("A paragraph for typing.\n");
    expect(b.note()).not.toContain("日本");
  });
});
