// LFCP-02-038: the local journal of section reconciliations, pending
// candidates, and what a rebuild may recover.

import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import {
  advance,
  diagnosticView,
  type JournalEntry,
  JournalError,
  MemorySectionJournalStore,
  rebuildFromNote,
  recovery,
} from "../../../src/core/sections/journal";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const captured: JournalEntry = {
  operationId: "op-1",
  projectionId: "p-1",
  phase: "captured",
  sourceHash: "h0",
  allocatedIds: {},
};

describe("journal phases (ARCHITECTURE-02 §5)", () => {
  it("move forward only; IDs and the receipt are never replaced", () => {
    const ids = advance(captured, "ids-allocated", { allocatedIds: { 4: id(9) } });
    expect(() => advance(ids, "committed")).toThrow(JournalError); // no receipt
    const committed = advance(ids, "committed", { receipt: "unit-abc" });
    expect(() => advance(committed, "ids-allocated")).toThrow(JournalError);
    expect(() => advance(committed, "projected", { receipt: "unit-other" })).toThrow(JournalError);
    expect(() => advance(committed, "projected", { allocatedIds: { 4: id(10) } })).toThrow(
      JournalError,
    );
    const done = advance(advance(committed, "projected", { patchedHash: "h1" }), "done");
    expect(done).toMatchObject({
      phase: "done",
      receipt: "unit-abc",
      allocatedIds: { 4: id(9) },
      patchedHash: "h1",
    });
    expect(() => advance(done, "abandoned")).toThrow(JournalError);
  });

  it("recovery follows the crash table: re-evaluate, query, project existing IDs, finish", () => {
    expect(recovery(captured)).toEqual({ kind: "re-evaluate", allocatedIds: {} });
    const ids = advance(captured, "ids-allocated", { allocatedIds: { 4: id(9) } });
    expect(recovery(ids)).toEqual({ kind: "query-receipt" });
    const committed = advance(ids, "committed", { receipt: "unit-abc" });
    expect(recovery(committed)).toEqual({
      kind: "project",
      receipt: "unit-abc",
      allocatedIds: { 4: id(9) },
    });
    expect(recovery(advance(committed, "projected", { patchedHash: "h1" }))).toEqual({
      kind: "finish",
      patchedHash: "h1",
    });
    expect(recovery(advance(captured, "abandoned", { reason: "access revoked" }))).toEqual({
      kind: "none",
    });
  });

  it("the store resumes unfinished entries and refuses to go back", async () => {
    const store = new MemorySectionJournalStore();
    await store.put(captured);
    await store.put({ ...captured, operationId: "op-2", phase: "done" });
    expect((await store.unfinished()).map((e) => e.operationId)).toEqual(["op-1"]);
    await store.put(advance(captured, "ids-allocated"));
    await expect(store.put(captured)).rejects.toThrow(JournalError);
  });
});

describe("pending candidates", () => {
  it("are kept until explicitly resolved; diagnostics show neither text nor path", async () => {
    const store = new MemorySectionJournalStore();
    const c = {
      candidateId: "c-1",
      projectionId: "p-1",
      reason: "binding-lost" as const,
      sourceText: "Secret plan 🦔",
    };
    await store.putCandidate(c);
    expect(await store.candidates("p-1")).toEqual([c]);
    expect(diagnosticView(c)).toEqual({
      projectionId: "p-1",
      reason: "binding-lost",
      characters: 14,
    });
    expect(JSON.stringify(diagnosticView(c))).not.toContain("Secret");
    await store.resolveCandidate("c-1");
    expect(await store.candidates("p-1")).toEqual([]);
  });
});

describe("rebuild from the note alone", () => {
  it("recovers identities and ranges, and always reports the base as unknown", () => {
    const md = `${[
      "Private.",
      "## Launch",
      formatBoundary("start", S),
      "- [ ] One",
      `  <!-- lfcp-ref: lfcp1:${R}#task:${id(2)} -->`,
      `  ${formatNodeMarker("paragraph", id(3))}`,
      "  Note",
      "- [ ] New, unbound",
      formatBoundary("end", S),
    ].join("\n")}\n`;
    expect(rebuildFromNote(md)).toEqual([
      { section: S, lines: { from: 1, to: 8 }, ids: [id(2), id(3)], baseUnknown: true },
    ]);
  });
});
