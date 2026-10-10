// LFCP-02-059: what the section card says (unit evidence on mock facts):
// qualified facts, pending counts in batch units, problems first in the
// user's words, technical identifiers last, markup kept as plain text.

import { describe, expect, it } from "vitest";
import { HISTORY_ADVICE_AT, sectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const base: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "unavailable",
  projections: [],
};
const card = (f: Partial<StatusFacts>, extra = {}) =>
  sectionCard({
    title: "Launch",
    view: statusView({ ...base, ...f }),
    resource: "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE",
    sectionId: "0192e4a0-0000-7000-8000-000000000001",
    ...extra,
  });

describe("the section card", () => {
  it("current: qualified, no claim that anyone has seen it", () => {
    const c = card({}, { counts: { tasks: 2, paragraphs: 1, items: 0 } });
    expect(c.heading).toBe('Shared section "Launch"');
    expect(c.status).toBe("No pending local changes; current as last checked");
    expect(c.facts).toEqual([
      "No local changes waiting.",
      "Current as last checked with the server. This does not mean others have seen it.",
      "You can edit this section.",
    ]);
    expect(c.problems).toEqual([]);
    expect(c.shared.at(-1)).toBe("Now: 2 tasks, 1 paragraph, 0 list items.");
  });

  it("pending: counted in updates, evidence unavailable said plainly, offline kept", () => {
    const c = card({
      connection: "offline",
      batches: [1, 2].map((n) => ({
        id: `b${n}`,
        nodeIds: ["n"],
        durable: true,
        unitIds: [`u${n}`],
        acceptedUnitIds: [],
      })),
    });
    expect(c.facts).toContain("2 local updates saved on this device, waiting to be sent.");
    expect(c.facts).toContain(
      "The server acknowledged some updates without confirming it stored them: they are not shown as accepted.",
    );
    expect(c.facts).toContain("Offline: local updates wait on this device.");
    expect(c.facts.join(" ")).not.toMatch(/accepted by the server/);
  });

  it("problems first, in words; the technical part last", () => {
    const c = card({
      access: "revoked",
      problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds: ["a", "b"] }],
    });
    expect(c.problems).toEqual([
      "Your access to this section was removed. Your local copy stays; new edits are kept on this device only.",
      "Conflicting edits on 2 items: both values are kept until you choose.",
    ]);
    expect(c.technical[0]).toBe("State: ATTENTION");
    expect(c.technical.join(" ")).toContain("Conditions: access, scalar-conflict");
  });

  it("115: refused by the server: says so without a cause, keeps the copy, names the owner", () => {
    const c = card({ access: "refused" });
    expect(c.problems).toEqual([
      "The sync server no longer accepts changes from this vault for this section. Your local copy stays; new edits are kept on this device only. Ask the section's owner to check your access.",
    ]);
    expect(c.problems.join(" ")).not.toMatch(/removed|revoked/);
    expect(c.facts).toContain("The sync server does not accept your edits to this section now.");
    expect(c.facts).not.toContain("You can edit this section.");
    expect(c.technical[0]).toBe("State: ATTENTION");
  });

  it("read-only, and markup in a title is plain text", () => {
    const c = sectionCard({
      title: '<img src=x onerror="alert(1)">',
      view: statusView({ ...base, access: "reader" }),
      resource: "r",
      sectionId: "s",
      hosting: "hosted",
    });
    expect(c.heading).toBe('Shared section "<img src=x onerror="alert(1)">"');
    expect(c.facts).toContain("You can read this section, not edit it.");
    expect(c.access).toBeUndefined();
  });
});

describe("LFCP-02-117: the history's size", () => {
  const withHistory = (history?: number) =>
    sectionCard({
      title: "Launch",
      view: statusView(base),
      resource: "r",
      sectionId: "s",
      ...(history === undefined ? {} : { history }),
    });
  const advice = (c: ReturnType<typeof withHistory>) =>
    c.shared.some((l) => l.includes("consider starting a new section"));

  it("shown when measured; no advice below about 200,000", () => {
    const c = withHistory(12_345);
    expect(c.shared).toContain(
      "History: about 12,345 characters inserted since the section was shared (deleted text counts too).",
    );
    expect(advice(c)).toBe(false);
    expect(advice(withHistory(HISTORY_ADVICE_AT - 1))).toBe(false);
  });

  it("from about 200,000 a new section is suggested; the status does not change", () => {
    const c = withHistory(HISTORY_ADVICE_AT);
    expect(advice(c)).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.status).toBe(withHistory(undefined).status);
  });

  it("not measured: nothing said", () => {
    expect(withHistory(undefined).shared.join(" ")).not.toMatch(/History/);
  });
});
