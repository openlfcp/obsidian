// A predecessor the SDK refuses for a reason the snapshot does not show
// (soak finding #12 on 0.4.0-beta.18): with a structural conflict left open
// for hours, the owner's own new Tasks next to it failed to save, "Local
// save failed" (INVALID_PREDECESSOR), every pass, and every Task typed after
// them joined the refused batch. The pass now plans around the node the
// refusal names: after the nearest sibling before it, or first.

import { describe, expect, it } from "vitest";
import { CommitRefused } from "../../../src/core/sections/port";
import { lines, taskId, twoVaults } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "A paragraph."];

const titles = (md: string) =>
  lines(md).flatMap((l) => {
    const m = /^\s*- \[.\] (.*)$/.exec(l);
    return m === null ? [] : [m[1] as string];
  });

/** A's port refuses any intent placed after `refused`, as the SDK does for a node it does not hold eligible. */
function refuseAfter(port: { commit: (...a: never[]) => Promise<unknown> }, refused: string) {
  const commit = port.commit.bind(port) as (...a: unknown[]) => Promise<unknown>;
  const calls: number[] = [];
  (port as { commit: (...a: unknown[]) => Promise<unknown> }).commit = async (...a: unknown[]) => {
    const intents = a[1] as { after?: string | null }[];
    calls.push(intents.length);
    if (intents.some((i) => i.after === refused))
      throw new CommitRefused("INVALID_PREDECESSOR", refused, 0);
    return commit(...a);
  };
  return calls;
}

describe("a predecessor the SDK refuses (soak #12)", () => {
  it("a new Task after it is saved after the nearest sibling the SDK accepts, with no kept copy", async () => {
    const { a, b } = await twoVaults(BODY);
    const beta = taskId(a.note(), "Beta");
    const calls = refuseAfter(a.port as never, beta);
    const md = a.note();
    const at = md.indexOf("- [ ] Gamma");
    const result = await a.pass(`${md.slice(0, at)}- [ ] New after Beta\n${md.slice(at)}`);
    expect(result?.local?.kind).toBe("committed");
    // Refused once, planned again, committed.
    expect(calls.length).toBe(2);
    // The Task is in the model, shared: B receives it.
    for (const [res, r] of a.replicas) b.replicas.get(res)?.receiveChanges(r.changes());
    await b.pass(b.note());
    expect(titles(b.note())).toContain("New after Beta");
    // The refused attempt left no local copy behind.
    expect(await a.journal.candidates(result?.projectionId as string)).toEqual([]);
  });

  it("a refusal for another reason is kept as before", async () => {
    const { a } = await twoVaults(BODY);
    const port = a.port as unknown as { commit: (...a: unknown[]) => Promise<unknown> };
    port.commit = async () => {
      throw new CommitRefused("INVALID_PARENT", taskId(a.note(), "Alpha"), 0);
    };
    const md = a.note();
    const at = md.indexOf("- [ ] Gamma");
    const result = await a.pass(`${md.slice(0, at)}- [ ] Another\n${md.slice(at)}`);
    expect(result?.local).toMatchObject({ kind: "kept", code: "INVALID_PARENT" });
  });
});
