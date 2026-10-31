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
import { type PaneFacts, paneActions, paneModel, paneTexts } from "../../../src/core/pane/model";
import type {
  CardAction,
  SectionNotes,
  SectionPrompter,
  SectionServices,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { accessView, type MyAccess } from "../../../src/core/status/access";
import { headingBadge } from "../../../src/core/status/badge";
import { heldFact, type SectionCard, sectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
) as { states: { id: string; facts: FixtureFacts }[] };

const CURRENT = "Current as last checked with the server";

function surfaces(f: PaneFacts) {
  const s = f.section;
  if (s === null) throw new Error("no section");
  const model = paneModel(f);
  const pane = paneTexts(model);
  const card = sectionCard({ title: "Launch", view: s.view, resource: "R", sectionId: "S" });
  const cardTexts = [card.status, ...card.facts, ...card.problems];
  const badge = headingBadge("Launch", s.view);
  // What the pane offers beside the header: its primary, Details and the menu.
  const actions = paneActions(model);
  return { s, model, pane, card, cardTexts, badge, actions };
}

function agree(f: PaneFacts) {
  const { s, model, pane, card, cardTexts, badge, actions } = surfaces(f);
  const v = s.view;
  const says = (texts: readonly string[]) => texts.some((t) => t.includes(CURRENT));
  // Current: the details card says it exactly when the view is; the pane's state card only then
  // ("Synced"), and never with a section held, queued or checking; the badge quiet then.
  expect(says(cardTexts), "card current").toBe(v.sync.current);
  if (says(pane) || model.card.status.word === "Synced")
    expect(v.sync.current, "pane current").toBe(true);
  if (v.sync.current) expect(badge.icon).toBeNull();
  else expect(badge.tooltip).not.toContain(CURRENT);
  // Held: on every surface, and never current.
  // The pane's one line says the biggest copy's edits (counted, with the cause); the card lists each.
  const biggest = [...v.held].sort((a, b) => (b.count ?? 1) - (a.count ?? 1))[0];
  if (biggest !== undefined && f.context.flow === null)
    expect(pane.join("\n")).toContain(heldFact(biggest).split(" (")[0]);
  for (const h of v.held) {
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
    // Nothing to do yet: no primary; Details is beside, as the card's secondary.
    expect(model.primary).toBeNull();
    expect(model.card.secondary?.id).toBe("open-details");
  });

  it("healthy with the access list's grant: invite on the pane and the card alike", () => {
    agree(section(facts, true));
    agree(section(facts, false));
    agree(section(facts, null));
  });
});

// The card's own path (SectionActions.openCard → #cardFacts): its content
// built as the host builds it (sectionCard over the access list's
// AccessView, with its invite fact and hosting), its buttons as the
// prompter receives them. The pane and the card must agree on Invite and
// on the connection line in every fixture state.
describe("the card's real path agrees with the pane (LFCP-03-013)", () => {
  const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
  const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
  const KEY = `${R0}#${SID}`;
  const CONNECTION =
    /Connecting to the server|Could not connect|stopped responding|Offline|Not checked with the server/;

  /** This vault's access as the SDK would report it, for the access list to say `invite`. */
  const mineOf = (invite: boolean | null): MyAccess | null =>
    invite === null
      ? null
      : {
          allowed: true,
          current: true,
          verifiedAt: 1,
          abilities: invite ? ["data/write", "capability/grant"] : ["data/write"],
          owner: invite,
          pendingControl: [],
        };

  async function cardButtons(content: SectionCard): Promise<readonly CardAction[]> {
    let shown: readonly CardAction[] = [];
    const prompter = new Proxy(
      {},
      {
        get: (_t, name) => {
          if (name === "card")
            return (_c: SectionCard, actions: readonly CardAction[]) => {
              shown = actions;
              return { update: () => undefined, close: () => undefined };
            };
          if (name === "notice" || name === "announce") return () => undefined;
          return () => {
            throw new Error(`unexpected prompter.${String(name)}`);
          };
        },
      },
    ) as SectionPrompter;
    const services = {
      cardContent: async () => content,
      held: () => [],
      recoveryItems: () => [],
      candidates: () => null,
      bases: () => null,
      unavailable: () => null,
      readOnly: () => false,
      server: () => "wss://sync.example/v1/ws",
      known: () => true,
      commands: () => null,
    } as unknown as SectionServices;
    const actions = new SectionActions({ prompter, notes: {} as SectionNotes, services });
    await actions.openCard(KEY, "Launch");
    return shown;
  }

  for (const st of doc.states) {
    const s = st.facts.section;
    if (s === null || st.facts.context.flow !== null) continue;
    it(`agrees on ${st.id}`, async () => {
      const f = paneFactsOf(st.facts);
      const section = f.section;
      if (section === null) throw new Error("no section");
      const view = section.view;
      const access = accessView({
        participants: [],
        mine: mineOf(s.accessView.canInvite),
        aliases: {},
        connected: view.connection === "connected",
        time: () => "t",
      });
      expect(access.invite).toBe(s.accessView.canInvite);
      const content = sectionCard({
        title: "Launch",
        view,
        resource: R0,
        sectionId: SID,
        access,
        ...(s.hosting === undefined ? {} : { hosting: s.hosting }),
      });
      const card = (await cardButtons(content)).find((a) => a.label === "Invite collaborator…");
      const model = paneModel(f);
      const pane = paneActions(model).find((a) => a.id === "invite");
      expect(card === undefined ? "hidden" : (card.disabled ?? "enabled")).toBe(
        pane === undefined ? "hidden" : pane.enabled ? "enabled" : pane.reason,
      );
      // The connection line: the same sentence, or none, on both.
      const paneLine = [model.card.fact ?? ""].filter((t) => CONNECTION.test(t));
      const cardLine = content.facts.filter((t) => CONNECTION.test(t));
      for (const t of paneLine) expect(cardLine).toContain(t);
    });
  }
});
