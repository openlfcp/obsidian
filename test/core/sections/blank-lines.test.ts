// Blank lines in a shared section (the owner's check of 0.4.0-beta.8): a
// blank line is local layout (MARKDOWN-SECTIONS-01 §5), never a shared node,
// and an empty paragraph is its marker and an empty line (§4.3). On two
// vaults on the real section replica: a blank line added before a paragraph
// (where the editor puts Enter at its start), and blank lines deleted, send
// nothing and never break a binding; vault C's state (an empty paragraph
// whose empty line was deleted, its marker right before the next) binds.

import { describe, expect, it } from "vitest";
import { formatNodeMarker } from "../../../src/core/sections/grammar";
import { keepMarkerWithParagraph } from "../../../src/core/sections/rules";
import { projectionFact } from "../../../src/core/status/projections";
import { lines, reconnect, twoVaults, type Vault } from "../../support/section-vaults";

const BODY = ["- [ ] 仕事", "", "A paragraph for typing."];

/** One pass of `md` in `v`: what it sent, and its projection facts. */
async function passOf(v: Vault, md: string) {
  const r = await v.pass(md);
  if (r === undefined) throw new Error("no section");
  return { kind: r.local?.kind ?? "nothing", facts: projectionFact(r).facts, lost: r.lost };
}

const paragraphMarker = (md: string) =>
  lines(md).find((l) => l.startsWith("<!-- lfcp-node: paragraph:")) as string;

describe("blank lines are local layout (§4.3, §5)", () => {
  it("Enter at the start of the paragraph (as the editor puts it) sends nothing; the other vault is unchanged", async () => {
    const { a, b } = await twoVaults(BODY);
    const before = b.note();
    const at = before.indexOf("A paragraph");
    const moved = keepMarkerWithParagraph(before, { from: at, to: at, insert: "\n" });
    if (moved === null) throw new Error("not moved");
    const typed = before.slice(0, moved.from) + moved.insert + before.slice(moved.to);
    const r = await passOf(b, typed);
    expect(r.kind).toBe("nothing");
    expect(r.facts.source).toBe("clean");
    const nodes = Object.values(b.model()?.nodes ?? {}).filter((n) => n.kind === "paragraph");
    expect(nodes.map((n) => n.text)).toEqual(["A paragraph for typing."]);
    const aBefore = a.note();
    await reconnect(a, b);
    expect(a.note()).toBe(aBefore);
  });

  it("blank lines deleted in one vault send nothing and keep every binding", async () => {
    const { a, b } = await twoVaults(BODY);
    const tight = a.note().replace(/\n\n(<!-- lfcp-node: paragraph:)/, "\n$1");
    expect(tight).not.toBe(a.note());
    const r = await passOf(a, tight);
    expect(r.kind).toBe("nothing");
    expect(r.facts.source).toBe("clean");
    const bBefore = b.note();
    await reconnect(a, b);
    expect(b.note()).toBe(bBefore);
  });

  it("C's state: an empty paragraph whose empty line was deleted binds, current, nothing sent", async () => {
    const { a, b } = await twoVaults(BODY);
    // B split the paragraph at its start (0.4.0-beta.8): the old node empty, the text a new node.
    const marker = paragraphMarker(b.note());
    const split = b
      .note()
      .replace(`${marker}\nA paragraph for typing.`, `${marker}\n\nA paragraph for typing.`);
    await b.pass(split);
    await b.pass(b.note());
    await reconnect(a, b);
    const empty = Object.values(a.model()?.nodes ?? {}).filter(
      (n) => n.kind === "paragraph" && n.text === "",
    );
    expect(empty).toHaveLength(1);
    // A deletes the empty paragraph's empty line: the two markers are adjacent.
    const adjacent = a
      .note()
      .replace(/(<!-- lfcp-node: paragraph:[^>]*-->)\n\n(<!-- lfcp-node: paragraph:)/, "$1\n$2");
    expect(adjacent).not.toBe(a.note());
    const r = await passOf(a, adjacent);
    expect(r.lost).toEqual([]);
    expect(r.facts.source).toBe("clean");
    expect(r.kind).toBe("nothing");
    expect(a.note()).toContain(
      formatNodeMarker(
        "paragraph",
        (
          Object.entries(a.model()?.nodes ?? {}).find(
            ([, n]) => n.kind === "paragraph" && n.text === "",
          ) as [string, unknown]
        )[0],
      ),
    );
    const bBefore = b.note();
    await reconnect(a, b);
    expect(b.note()).toBe(bBefore);
  });
});
