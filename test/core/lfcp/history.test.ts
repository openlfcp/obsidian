// LFCP-02-117: a section's history size, as §13.1 counts a save's columns:
// every character ever inserted is a row, deleted text included.

import { principalId, resourceId } from "@openlfcp/core";
import { SectionReplica } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import { historyRows } from "../../../src/core/lfcp/history";

const R = resourceId(new Uint8Array(32).fill(3));
const ME = principalId(new Uint8Array(32).fill(4));
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const SECTION = id(1);
const P = id(2);

function section(text: string) {
  const replica = SectionReplica.empty({ resource: R, principal: ME });
  replica.commit([
    { intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: ME },
  ]);
  replica.commit([
    { intent: "paragraph.create", id: P, parent: SECTION, after: null, text, createdBy: ME },
  ]);
  return replica;
}

describe("historyRows", () => {
  it("grows with every character inserted", () => {
    const small = historyRows(section("x").save());
    expect(historyRows(section("x".repeat(1001)).save())).toBeGreaterThanOrEqual(small + 1000);
  });

  it("does not shrink when text is replaced: deleted text counts too", () => {
    const r = section("a".repeat(2000));
    const before = historyRows(r.save());
    r.commit([
      {
        intent: "text.edit",
        id: P,
        edits: [{ index: 0, deleteCount: 2000, insert: "b".repeat(10) }],
        base: r.revision(),
      },
    ]);
    expect(historyRows(r.save())).toBeGreaterThanOrEqual(before + 10);
  });

  it("measures past the §13.1 floor (262,144) instead of refusing", () => {
    expect(historyRows(section("z".repeat(300_000)).save())).toBeGreaterThan(262_144);
  });
});
