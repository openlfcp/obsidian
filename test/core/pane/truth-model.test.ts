// LFCP-03-013 (U03-06, U03-28; F-04): one truth model for the pane, the
// section card and the heading badge. On every frozen UX state, and on the
// combinations below, the three read one StatusView and say the same:
// - "current" on one surface only when the view is current, and then the
//   badge is quiet;
// - held edits on every surface, never hidden behind a server ACK of
//   earlier shared state;
// - unknown access neither a denial nor a grant: inviting and removing
//   access wait, and no surface says access was removed;
// - the card's Invite and the pane's read one descriptor.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESCRIPTORS, RUNNING, sectionFacts } from "../../../src/core/actions/descriptors";
import { type FixtureFacts, paneFactsOf } from "../../../src/core/pane/mock-facts";
import { type PaneFacts, paneModel, paneTexts } from "../../../src/core/pane/model";
import { headingBadge } from "../../../src/core/status/badge";
import { heldFact, sectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
) as { states: { id: string; facts: FixtureFacts }[] };

const CURRENT = "Current as last checked with the server";

function surfaces(f: PaneFacts) {
  const s = f.section;
  if (s === null) throw new Error("no section");
  const model = paneModel(f, { time: () => "t" });
  const pane = paneTexts(model);
  const card = sectionCard({ title: "Launch", view: s.view, resource: "R", sectionId: "S" });
  const cardTexts = [card.status, ...card.facts, ...card.problems];
  const badge = headingBadge("Launch", s.view);
  const actions = [...(model.primary === null ? [] : [model.primary]), ...model.secondary];
  return { s, model, pane, card, cardTexts, badge, actions };
}

function agree(f: PaneFacts) {
  const { s, pane, card, cardTexts, badge, actions } = surfaces(f);
  const v = s.view;
  const says = (texts: readonly string[]) => texts.some((t) => t.includes(CURRENT));
  // Current: on the pane and the card exactly when the view is; the badge quiet then.
  expect(says(pane), "pane current").toBe(v.sync.current);
  expect(says(cardTexts), "card current").toBe(v.sync.current);
  if (v.sync.current) expect(badge.icon).toBeNull();
  else expect(badge.tooltip).not.toContain(CURRENT);
  // Held: on every surface, and never current.
  for (const h of v.held) {
    expect(pane).toContain(heldFact(h));
    expect(card.facts).toContain(heldFact(h));
    expect(badge.accessibleName).toContain("edits not sent");
    expect(v.sync.current).toBe(false);
  }
  // Invite: the pane and the card read one descriptor (the card has no note and no flow).
  if (f.context.flow === null) {
    const card = DESCRIPTORS.invite.availability(sectionFacts(s, f.host ?? RUNNING));
    const pane = actions.find((a) => a.id === "invite");
    expect(pane === undefined ? "hidden" : pane.enabled ? "enabled" : "disabled").toBe(card.kind);
    if (pane !== undefined && card.kind === "disabled") expect(pane.reason).toBe(card.reason);
  }
  // Unknown access: neither a grant nor a denial.
  if (v.access.access === "unknown" || s.canInvite === null) {
    for (const id of ["invite", "remove-access"])
      expect(actions.find((a) => a.id === id)?.enabled ?? false, id).toBe(false);
    if (v.access.access === "unknown")
      for (const t of [...pane, ...cardTexts])
        expect(t).not.toMatch(/access (to this section )?was removed|not a member|refused/i);
  }
}

describe("one truth model for pane, card and badge (LFCP-03-013)", () => {
  for (const st of doc.states)
    if (st.facts.section !== null)
      it(`agree on ${st.id}`, () => {
        agree(paneFactsOf(st.facts));
      });

  const facts: StatusFacts = {
    session: "s",
    revision: 1,
    replica: "loaded",
    access: "writer",
    accessVerifiedAt: 1,
    accessCurrent: true,
    pendingControl: [],
    connection: "connected",
    catchUp: "current-at-checkpoint",
    problems: [],
    batches: [],
    acceptanceEvidence: "available",
    projections: [],
  };
  const section = (f: StatusFacts, canInvite: boolean | null = true): PaneFacts => ({
    context: {
      editor: "source",
      note: "Plan.md",
      cursor: "inside-section",
      selection: null,
      flow: null,
    },
    registry: { status: "ready", placementIndex: "complete", sections: 1, unplaced: 0 },
    section: {
      key: "R#S",
      sharedTitle: "Launch",
      localAlias: null,
      placements: 1,
      view: statusView(f),
      canInvite,
      hosting: "hosted",
    },
  });

  it("F2: an ACK of earlier shared state does not hide edits held in a note", () => {
    const acked: StatusFacts = {
      ...facts,
      batches: [
        { id: "b1", nodeIds: ["n"], durable: true, unitIds: ["u"], acceptedUnitIds: ["u"] },
      ],
      projections: [
        {
          id: "p",
          source: "binding-error",
          application: "blocked",
          held: {
            path: "Plan.md",
            projectionId: "p",
            cause: "boundary",
            count: 2,
            line: 4,
            nodeIds: [],
          },
        },
      ],
    };
    const f = section(acked);
    agree(f);
    const { s, model, pane, badge } = surfaces(f);
    expect(s.view.acceptedBatches).toBe(1);
    expect(s.view.sync.current).toBe(false);
    expect(model.primary?.id).toBe("repair-sections");
    expect(pane.join("\n")).not.toContain(CURRENT);
    expect(badge.icon).toBe("attention");
  });

  it("unknown access is neither a denial nor a grant on any surface", () => {
    const unknown = section(
      { ...facts, access: "unknown", accessVerifiedAt: null, accessCurrent: null },
      null,
    );
    agree(unknown);
    const { model } = surfaces(unknown);
    expect(model.primary?.id).toBe("open-details");
  });

  it("healthy with the access list's grant: invite on the pane and the card alike", () => {
    agree(section(facts, true));
    agree(section(facts, false));
    agree(section(facts, null));
  });
});
