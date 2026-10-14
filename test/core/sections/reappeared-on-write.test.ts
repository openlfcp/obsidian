// A Task a collaborator deleted is removed from the note by the pass that
// receives the deletion; that pass reported it "shown again while deleted"
// (reappeared), so the badge said the note differs from the shared version
// until a later pass, and Review conflicts offered to restore a Task the
// note no longer showed (soak #5). The result describes the note as
// written: what the remote patch removes is not reported; a Task the note
// still shows while deleted is.

import { describe, expect, it } from "vitest";
import { projectionFact } from "../../../src/core/status/projections";
import { taskId, twoVaults, type Vault } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma"];
const lineOf = (md: string, title: string) => {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.endsWith(`] ${title}`));
  return lines.slice(at, at + 2).join("\n");
};

/** Each vault receives what the other committed. */
function exchange(a: Vault, b: Vault) {
  const ra = a.replica();
  const rb = b.replica();
  const fromA = ra.changes();
  ra.receiveChanges(rb.changes());
  rb.receiveChanges(fromA);
}

describe("a collaborator's deletion, as the note is written", () => {
  it("is removed from the note, and nothing is reported shown again", async () => {
    const { a, b } = await twoVaults(BODY);
    const beta = taskId(b.note(), "Beta");
    await b.pass(b.note().replace(`${lineOf(b.note(), "Beta")}\n`, ""), {
      deletedIds: new Set([beta]),
    });
    exchange(a, b);
    const r = await a.pass(a.note());
    expect(a.note()).not.toContain("Beta");
    expect(r?.reappeared).toBeUndefined();
    // The badge: the projection is clean (not "differs from the shared version").
    if (r === undefined) throw new Error("no result");
    expect(projectionFact(r).facts.source).toBe("clean");
  });

  it("over an edit of that Task: the note keeps it, and it is reported", async () => {
    const { a, b } = await twoVaults(BODY);
    const beta = taskId(b.note(), "Beta");
    await b.pass(b.note().replace(`${lineOf(b.note(), "Beta")}\n`, ""), {
      deletedIds: new Set([beta]),
    });
    // A edits Beta, not sent yet, when the deletion arrives.
    const edited = a.note().replace("- [ ] Beta", "- [ ] Beta edited");
    exchange(a, b);
    const r = await a.pass(edited);
    expect(a.note()).toContain("Beta edited");
    expect(a.model()?.nodes[beta]?.lifecycle).toBe("deleted");
    expect(r?.reappeared).toEqual([beta]);
  });

  it("brought back into the note after the deletion arrived: reported", async () => {
    const { a, b } = await twoVaults(BODY);
    const before = a.note();
    const beta = taskId(b.note(), "Beta");
    await b.pass(b.note().replace(`${lineOf(b.note(), "Beta")}\n`, ""), {
      deletedIds: new Set([beta]),
    });
    exchange(a, b);
    await a.pass(a.note());
    expect(a.note()).not.toContain("Beta");
    // The old lines pasted back from elsewhere (no cut of this session).
    const back = a
      .note()
      .replace(
        lineOf(a.note(), "Gamma"),
        `${lineOf(before, "Beta")}\n${lineOf(a.note(), "Gamma")}`,
      );
    const r = await a.pass(back);
    expect(r?.reappeared).toEqual([beta]);
    expect(a.model()?.nodes[beta]?.lifecycle).toBe("deleted");
  });
});
