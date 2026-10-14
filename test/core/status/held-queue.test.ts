// LFCP-03-003 (F-04, U03-25, U03-06): held local source, the outbound queue
// and the shared model are separate facts. A copy held for its boundary,
// unsupported content, read-only access or a missing base, with an empty
// queue and every update accepted, is never "current" in the view, the
// card or the badge; queued batches are never added to held edits; an
// unknown count stays unknown (a note not checked yet, a copy without a
// base); and computing the status changes neither the note nor the model.

import { describe, expect, it } from "vitest";
import { parseSections } from "../../../src/core/sections/parser";
import { headingBadge } from "../../../src/core/status/badge";
import { sectionCard } from "../../../src/core/status/card";
import { observedFacts } from "../../../src/core/status/facts";
import { damagedHeld, type HeldEdits, heldEdits } from "../../../src/core/status/held";
import { ProjectionFactsStore } from "../../../src/core/status/projections";
import {
  type BatchFacts,
  type ProjectionFacts,
  type StatusFacts,
  statusView,
} from "../../../src/core/status/reducer";
import { vaultSyncSummary } from "../../../src/core/status/summary";
import { lines, twoVaults, type Vault } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "", "A paragraph."];

/** One update the server accepted: the shared model has this vault's work. */
const acked: BatchFacts = {
  id: "b1",
  nodeIds: ["n1"],
  durable: true,
  unitIds: ["u1"],
  acceptedUnitIds: ["u1"],
};
const waiting = (id: string, units = 1): BatchFacts => ({
  id,
  nodeIds: ["n2"],
  durable: true,
  unitIds: Array.from({ length: units }, (_, i) => `${id}-u${i}`),
  acceptedUnitIds: [],
});

/** Queue empty, every update accepted, caught up, connected, a writer. */
const accepted: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [acked],
  acceptanceEvidence: "available",
  projections: [],
};

const projection = (h: HeldEdits, source: ProjectionFacts["source"]): ProjectionFacts => ({
  id: h.projectionId,
  source,
  application: "blocked",
  held: h,
});

function surfaces(facts: StatusFacts) {
  const view = statusView(facts);
  const card = sectionCard({ title: "Plan", view, resource: "BwcH", sectionId: "s1" });
  const badge = headingBadge("Plan", view);
  return { view, card, badge, text: card.facts.join(" ") };
}

/** What a pass of `md` in `v` holds back, as the host computes it. */
async function heldOf(v: Vault, md: string): Promise<HeldEdits> {
  const r = await v.pass(md);
  if (r === undefined) throw new Error("no section");
  const scan = parseSections(md);
  const section = scan.sections[0];
  if (section === undefined) throw new Error("no parsed section");
  const base = (await v.bases.load(r.projectionId))?.state;
  const h = heldEdits({ path: "Plan.md", markdown: md, scan, section, result: r, base });
  if (h === null) throw new Error("nothing held");
  return h;
}

/** Never current, the queue empty and said so apart, the held copy named. */
function expectHeldNotCurrent(s: ReturnType<typeof surfaces>, h: HeldEdits) {
  expect(s.view.state).toBe("ATTENTION");
  expect(s.view.sync.current).toBe(false);
  expect(s.view.sync.sharedModel).toBe("accepted");
  expect(s.view.sync.queue).toEqual({ batches: 0, counted: true, units: 0 });
  expect(s.view.sync.held.projections).toBe(1);
  expect(s.view.sync.held.edits).toBe(h.count);
  expect(s.view.sync.held.causes).toEqual([h.cause]);
  expect(s.text).not.toMatch(/No local changes waiting/);
  expect(s.text).not.toMatch(/Current as last checked/);
  expect(s.card.facts).toContain(
    "No updates waiting in the sync queue: the edits held in your note are not in it.",
  );
  expect(s.card.facts).toContain("1 update was accepted by the server.");
  expect(s.badge.icon).toBe("attention");
  expect(s.badge.accessibleName).toMatch(
    /^Shared section Plan, edits not sent, needs your attention, (read-only, )?open details$/,
  );
}

describe("U03-25: a held copy with an empty queue and an accepted shared model", () => {
  it("unsupported content (a heading inside): counted, not current; note and model untouched", async () => {
    const { a } = await twoVaults(BODY);
    const L = lines(a.note());
    L.splice(L.indexOf("A paragraph.") + 1, 0, "", "### Inside");
    const h = await heldOf(a, L.join("\n"));
    expect(h).toMatchObject({ cause: "unsupported", count: 1 });
    const note = a.note();
    const model = JSON.stringify(a.model());
    const facts = Object.freeze({ ...accepted, projections: [projection(h, "unsupported")] });
    const s = surfaces(facts);
    expectHeldNotCurrent(s, h);
    // The status changes nothing: not the note, not the model.
    expect(a.note()).toBe(note);
    expect(JSON.stringify(a.model())).toBe(model);
  });

  it("read-only: the typed edit is held as read-only, not current", async () => {
    const { a } = await twoVaults(BODY);
    a.setAccess({ allowed: false, reason: "read-only" });
    const L = lines(a.note());
    L[L.indexOf("- [ ] Alpha")] = "- [ ] Alpha typed";
    const h = await heldOf(a, L.join("\n"));
    expect(h).toMatchObject({ cause: "read-only", count: 1 });
    const s = surfaces({
      ...accepted,
      access: "reader",
      projections: [projection(h, "diverged")],
    });
    expectHeldNotCurrent(s, h);
    expect(s.view.readOnly).toBe(true);
  });

  it("a damaged boundary: the whole copy held, its edits unknown, not a number", () => {
    const h = damagedHeld("Plan.md", "damaged:Plan.md", 4);
    const s = surfaces({ ...accepted, projections: [projection(h, "binding-error")] });
    expectHeldNotCurrent(s, h);
    expect(s.view.sync.held.edits).toBeNull();
    expect(s.card.facts[0]).toMatch(/^Edits not sent: the section's start or end marker/);
  });

  it("no base (unbased copy): held, uncountable, not current", () => {
    const h: HeldEdits = {
      path: "Plan.md",
      projectionId: "p",
      cause: "base-unknown",
      count: null,
      line: 2,
      nodeIds: [],
    };
    const s = surfaces({ ...accepted, projections: [projection(h, "base-unknown")] });
    expectHeldNotCurrent(s, h);
    expect(s.view.sync.held.edits).toBeNull();
  });

  it("the same facts without the held copy are current: the held copy alone decides", () => {
    const s = surfaces(accepted);
    expect(s.view.state).toBe("CURRENT");
    expect(s.view.sync.current).toBe(true);
    expect(s.view.sync.held).toEqual({
      projections: 0,
      edits: 0,
      causes: [],
      persistence: null,
    });
    expect(s.text).toMatch(/Current as last checked/);
  });
});

describe("U03-06: combinations", () => {
  it("held edits and queued batches: two separate counts, never added up", () => {
    const h: HeldEdits = {
      path: "Plan.md",
      projectionId: "p",
      cause: "unsupported",
      count: 2,
      line: 5,
      nodeIds: ["n3"],
    };
    const s = surfaces({
      ...accepted,
      batches: [acked, waiting("b2", 3)],
      projections: [projection(h, "unsupported")],
    });
    expect(s.view.state).toBe("ATTENTION");
    expect(s.view.sync.queue).toEqual({ batches: 1, counted: true, units: 3 });
    expect(s.view.sync.held.edits).toBe(2);
    expect(s.card.facts).toContain("1 local update saved on this device, waiting to be sent.");
    expect(s.card.facts[0]).toMatch(/^2 edits not sent:/);
    expect(s.text).not.toMatch(/\b3 (edits|local updates)\b/);
    expect(s.badge.accessibleName).toBe(
      "Shared section Plan, edits not sent, 1 local update waiting, open details",
    );
  });

  it("ACK and a damaged boundary in one copy, another copy healthy: the section is not current", () => {
    const h = damagedHeld("Other.md", "damaged:Other.md", 0);
    const s = surfaces({
      ...accepted,
      projections: [
        { id: "ok", source: "clean", application: "current" },
        projection(h, "binding-error"),
      ],
    });
    expect(s.view.state).toBe("ATTENTION");
    expect(s.view.projections).toEqual({ ok: "CURRENT", "damaged:Other.md": "ATTENTION" });
    expect(s.view.sync.current).toBe(false);
    // Per copy: the healthy one is current on its own, the damaged one holds edits.
    expect(s.view.sync.projections).toEqual([
      { id: "ok", state: "CURRENT", held: null, checked: true, current: true },
      { id: "damaged:Other.md", state: "ATTENTION", held: h, checked: true, current: false },
    ]);
    expect(s.text).not.toMatch(/Current as last checked/);
  });

  it("offline with a conflict: attention, offline said, never current", () => {
    const s = surfaces({
      ...accepted,
      connection: "offline",
      problems: [{ kind: "scalar", code: "SCALAR_CONFLICT", nodeIds: ["n1"] }],
    });
    expect(s.view.state).toBe("ATTENTION");
    expect(s.view.sync.current).toBe(false);
    expect(s.card.facts).toContain("Offline: local updates wait on this device.");
    expect(s.card.problems[0]).toMatch(/^Conflicting edits on 1 item/);
  });

  it("a server refusal with work queued: attention, not synced, the queue kept apart", () => {
    const s = surfaces({
      ...accepted,
      refusal: "RESOURCE_NOT_HOSTED",
      batches: [waiting("b2")],
    });
    expect(s.view.state).toBe("ATTENTION");
    expect(s.view.sync.current).toBe(false);
    expect(s.view.sync.queue.batches).toBe(1);
    expect(s.view.sync.held.projections).toBe(0);
    expect(s.card.facts).toContain("Not synced: the server refuses this section.");
    expect(s.text).not.toMatch(/Current as last checked/);
  });

  it("updates still being sent: the shared version is current, this vault's updates are not in it", () => {
    const s = surfaces({ ...accepted, batches: [acked, waiting("b2")] });
    expect(s.view.state).toBe("SENDING");
    expect(s.view.sync.sharedModel).toBe("accepted");
    expect(s.view.sync.current).toBe(false);
    expect(s.text).not.toMatch(/Current as last checked/);
    expect(s.card.facts).toContain(
      "The shared version is current as last checked with the server; changes from this vault above are not in it yet.",
    );
  });
});

describe("the shared version's line (review L1)", () => {
  it("no own changes waiting (a conflict, access being checked): no claim about this vault's changes", () => {
    for (const facts of [
      {
        ...accepted,
        problems: [{ kind: "scalar" as const, code: "SCALAR_CONFLICT", nodeIds: ["n1"] }],
      },
      { ...accepted, accessChecking: true },
    ]) {
      const s = surfaces(facts);
      expect(s.view.sync.current).toBe(false);
      expect(s.card.facts).toContain(
        "The shared version is current as last checked with the server.",
      );
      expect(s.text).not.toMatch(/changes from this vault|Current as last checked/);
    }
  });

  it("local changes being processed: they are not in the shared version yet", () => {
    const s = surfaces({
      ...accepted,
      projections: [{ id: "p", source: "editing", application: "current" }],
    });
    expect(s.view.state).toBe("LOCAL_EDIT");
    expect(s.card.facts).toContain(
      "The shared version is current as last checked with the server; changes from this vault above are not in it yet.",
    );
  });
});

describe("unknown stays unknown", () => {
  it("a note not checked yet since the start: no count, no current, said so", () => {
    const s = surfaces({ ...accepted, heldCheck: "pending" });
    expect(s.view.state).toBe("LOADING");
    expect(s.view.label).toBe("Checking notes for edits not sent");
    expect(s.view.sync).toMatchObject({
      held: { projections: null, edits: null, persistence: "unknown" },
      current: false,
    });
    expect(s.text).not.toMatch(/No local changes waiting|Current as last checked/);
    expect(s.card.facts).toContain(
      "Not current yet: not every note with this section was checked.",
    );
  });

  it("observedFacts carries the check (absent: checked)", () => {
    const o = {
      session: "s",
      load: { ready: true, loaded: true },
      phase: "LIVE",
      wasLive: true,
      problems: [],
      projections: [],
      sdk: undefined,
    };
    expect(observedFacts({ ...o, heldCheck: "pending" }).heldCheck).toBe("pending");
    expect(observedFacts({ ...o, heldCheck: "failed" }).heldCheck).toBe("failed");
    expect("heldCheck" in observedFacts(o)).toBe(false);
  });

  it("an unchecked note does not hide offline or sending: they speak first, still not current", () => {
    const offline = surfaces({ ...accepted, connection: "offline", heldCheck: "pending" });
    expect(offline.view.state).toBe("OFFLINE");
    expect(offline.view.sync.current).toBe(false);
    expect(offline.view.conditions.map((c) => c.kind)).toEqual(["offline", "held-unchecked"]);
    const sending = surfaces({ ...accepted, batches: [waiting("b2")], heldCheck: "pending" });
    expect(sending.view.state).toBe("SENDING");
    expect(sending.view.sync.held.projections).toBeNull();
  });

  it("a note whose check failed: attention, held edits unknown, no promise of progress", () => {
    const s = surfaces({ ...accepted, heldCheck: "failed" });
    expect(s.view.state).toBe("ATTENTION");
    expect(s.view.sync).toMatchObject({
      held: { projections: null, edits: null, persistence: "unknown" },
      current: false,
    });
    expect(s.card.problems).toEqual([
      "Checking a note with this section for edits not sent failed, so whether it holds any is unknown. Edits in it may not have been sent.",
    ]);
    expect(s.text).not.toMatch(/being checked|Current as last checked|No local changes waiting/);
    expect(s.card.facts).toContain(
      "Not current: whether a note with this section holds edits not sent is unknown.",
    );
  });
});

describe("persistence evidence of held text", () => {
  const h: HeldEdits = {
    path: "Plan.md",
    projectionId: "p",
    cause: "binding",
    count: 1,
    line: 3,
    nodeIds: ["n1"],
  };

  it("saved on disk: confirmed, said in the held line", () => {
    const s = surfaces({
      ...accepted,
      projections: [projection({ ...h, persistence: "saved" }, "binding-error")],
    });
    expect(s.view.sync.held.persistence).toBe("saved");
    expect(s.view.sync.localPersistence).toBe("confirmed");
    expect(s.card.facts[0]).toMatch(/ Kept only in this note, saved\.$/);
  });

  it("an open note not saved to disk yet: unconfirmed", () => {
    const s = surfaces({
      ...accepted,
      projections: [projection({ ...h, persistence: "unsaved" }, "binding-error")],
    });
    expect(s.view.sync.held.persistence).toBe("unsaved");
    expect(s.view.sync.localPersistence).toBe("unconfirmed");
    expect(s.card.facts[0]).toMatch(/ Kept only in this note, not saved to disk yet\.$/);
  });

  it("the store marks a note's held entries, and a damaged copy keeps what was known", () => {
    const store = new ProjectionFactsStore();
    store.held("k", "p", h);
    store.damaged("Plan.md", new Set(["k"]));
    expect(store.holds("Plan.md")).toBe(true);
    expect(store.holds("Other.md")).toBe(false);
    expect(store.persisted("Plan.md", "unsaved")).toBe(true);
    expect(store.persisted("Plan.md", "unsaved")).toBe(false);
    // The next pass's damaged() keeps the evidence until the next check.
    store.damaged("Plan.md", new Set(["k"]));
    const held = store.allHeld().get("k") ?? [];
    expect(held.map((x) => x.persistence)).toEqual(["unsaved", "unsaved"]);
  });
});

describe("the vault's summary (pane-ready)", () => {
  const h = (count: number | null): HeldEdits => ({
    path: "Plan.md",
    projectionId: `p${count}`,
    cause: count === null ? "boundary" : "unsupported",
    count,
    line: 1,
    nodeIds: [],
  });

  it("queue and held summed each on its own, never into one number", () => {
    const sum = vaultSyncSummary([
      statusView(accepted),
      statusView({ ...accepted, batches: [waiting("b2", 2)] }),
      statusView({ ...accepted, projections: [projection(h(3), "unsupported")] }),
    ]);
    expect(sum).toEqual({
      sections: 3,
      current: 1,
      attention: 1,
      queue: { batches: 1, counted: true, units: 2 },
      held: { sections: 1, projections: 1, edits: 3, causes: ["unsupported"] },
      unchecked: 0,
      connection: { connected: 3, connecting: 0, failed: 0, offline: 0 },
      // These facts carry no access freshness: not known current.
      accessNotCurrent: 3,
    });
  });

  it("an uncountable copy or an unchecked note makes the totals unknown, not zero", () => {
    const sum = vaultSyncSummary([
      statusView({ ...accepted, projections: [projection(h(2), "unsupported")] }),
      statusView({ ...accepted, projections: [projection(h(null), "binding-error")] }),
      statusView({ ...accepted, heldCheck: "pending" }),
    ]);
    expect(sum.held).toEqual({
      sections: null,
      projections: null,
      edits: null,
      causes: ["unsupported", "boundary"],
    });
    expect(sum.unchecked).toBe(1);
    expect(sum.current).toBe(0);
  });
});
