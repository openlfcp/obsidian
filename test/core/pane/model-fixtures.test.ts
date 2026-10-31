// The pane view model on the frozen UX states (LFCP-03-007; contract
// docs/architecture/ux-contract-0.3.md §13). Each fixture's facts go
// through the real status reducer (mock-facts.ts) and the view model; the
// reducer must give back the fixture's own view, and the model must give
// the fixture's primary call to action, its enabled and disabled actions
// (with the disabled reasons word for word), its required claims and none
// of its forbidden ones.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_IDS, ACTIONS } from "../../../src/core/actions/catalog";
import { type FixtureFacts, paneFactsOf, statusFactsOf } from "../../../src/core/pane/mock-facts";
import {
  type PaneAction,
  type PaneFacts,
  paneActions,
  paneFocus,
  paneModel,
  paneTexts,
} from "../../../src/core/pane/model";
import type { PaneProblem } from "../../../src/core/pane/problems";
import { DETACH_CONFIRMATION } from "../../../src/core/sections/actions";
import { accessView } from "../../../src/core/status/access";
import { BODY_DELETE_TEXT, sectionCard, WHOLE_COPY_TEXT } from "../../../src/core/status/card";
import { statusView } from "../../../src/core/status/reducer";

interface Expected {
  primaryCta: string | null;
  primaryCtaNone?: string;
  enabled: { action: string; reason: string }[];
  disabled: { action: string; reason: string }[];
  /** What the pane's surface says (its card, flow, preview, problems). */
  requiredClaims: string[];
  /** What the section list says (needs the host's registry rows: the real-host test checks these). */
  requiredListClaims?: string[];
  /** What Details (the section's card) says: the caveats and facts that left the surface. */
  requiredDetailsClaims?: string[];
  forbiddenClaims: string[];
}
interface State {
  id: string;
  facts: FixtureFacts;
  expected: Expected;
}

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
) as {
  actions: { id: string; label: string; destructive: boolean }[];
  globalForbiddenClaims: string[];
  states: State[];
};

/**
 * What Details says for a fixture's section, as the host builds it: the
 * section card over the access list's view (its freshness from the verified
 * time and whether the view is current).
 */
function detailsTexts(s: State): string[] {
  const section = s.facts.section;
  if (section === null) return [];
  const view = statusView(statusFactsOf(section));
  const a = section.access;
  const access = accessView({
    participants: [],
    mine:
      a.verifiedAt === null
        ? null
        : {
            allowed: true,
            current: a.current,
            verifiedAt: a.verifiedAt,
            abilities: [],
            owner: false,
            pendingControl: [],
          },
    aliases: {},
    connected: view.connection === "connected",
    time: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  const card = sectionCard({
    title: "Launch",
    view,
    resource: "R",
    sectionId: "S",
    access,
    ...(section.hosting === undefined ? {} : { hosting: section.hosting }),
  });
  return [card.status, ...card.problems, ...card.facts, ...card.shared, access.freshness];
}

describe("pane action catalogue", () => {
  it("is the fixtures' catalogue: same IDs, labels and destructive flags, in order", () => {
    expect(ACTION_IDS.map((id) => ACTIONS[id])).toEqual(doc.actions);
  });
});

describe("pane view model on the UX 0.3 fixtures", () => {
  it("covers all 21 states", () => {
    expect(doc.states.length).toBe(21);
  });

  for (const s of doc.states) {
    describe(s.id, () => {
      const facts = paneFactsOf(s.facts);
      const model = paneModel(facts);
      // What the pane offers: the join, the primary, Details beside it and the menu (the header repeats three).
      const actions: PaneAction[] = [
        model.join,
        ...(model.primary === null ? [] : [model.primary]),
        ...(model.card.secondary === null ? [] : [model.card.secondary]),
        ...model.menu,
      ];
      const byId = new Map([...model.header, ...actions].map((a) => [a.id as string, a]));
      const texts = paneTexts(model);

      it("binds to the real reducer: its view is the fixture's", () => {
        const section = s.facts.section;
        if (section === null) return;
        const view = statusView(statusFactsOf(section));
        expect(view.state).toBe(section.state);
        expect(view.sync).toEqual(section.sync);
        expect(view.access).toEqual(section.access);
        expect(view.connection).toBe(section.connection);
        expect(view.connectionQualifier).toBe(section.connectionQualifier);
        expect(view.refusal).toBe(section.refusal);
      });

      it("gives the expected primary call to action", () => {
        expect(model.primary?.id ?? null).toBe(s.expected.primaryCta);
        if (model.primary !== null) {
          expect(model.primary.enabled).toBe(true);
          expect(model.primary.destructive).toBe(false);
        } else expect(model.primaryNone).toBe(s.expected.primaryCtaNone);
      });

      it("enables the expected actions", () => {
        for (const e of s.expected.enabled) {
          const a = byId.get(e.action);
          expect(a, `${e.action} shown`).toBeDefined();
          expect(a?.enabled, `${e.action} enabled (${a?.reason})`).toBe(true);
        }
      });

      it("disables the expected actions, each with its reason", () => {
        for (const d of s.expected.disabled) {
          const a = byId.get(d.action);
          expect(a, `${d.action} shown`).toBeDefined();
          expect(a?.enabled, `${d.action} disabled`).toBe(false);
          expect(a?.reason).toBe(d.reason);
        }
      });

      it("A8: the header is Share, Insert, Join in every state; Join is the model's join", () => {
        expect(model.header.map((a) => a.id)).toEqual([
          "share-section",
          "insert-into-note",
          "join-with-link",
        ]);
        expect(model.header[2]).toEqual(model.join);
        for (const a of model.header)
          expect(a.enabled || (a.reason ?? "") !== "", `${a.id} disabled without a reason`).toBe(
            true,
          );
        // The same descriptors as the actions below: a header entry agrees with its twin.
        for (const a of model.header) {
          const twin = byId.get(a.id);
          if (twin !== undefined) expect(a).toEqual(twin);
        }
      });

      it("keeps destructive actions in the menu alone and every action unique", () => {
        // Never the primary, Details or a header icon; only ever a menu item (A1).
        expect(model.primary?.destructive ?? false).toBe(false);
        expect(model.card.secondary?.destructive ?? false).toBe(false);
        expect(model.header.every((a) => !a.destructive)).toBe(true);
        for (const a of actions.filter((x) => x.destructive)) expect(model.menu).toContain(a);
        expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
        // What the card and the header draw is not in the menu as well.
        const drawn = new Set<string>([
          ...model.header.map((a) => a.id),
          ...(model.primary === null ? [] : [model.primary.id]),
          ...(model.card.secondary === null ? [] : [model.card.secondary.id]),
        ]);
        expect(model.menu.filter((a) => drawn.has(a.id))).toEqual([]);
      });

      it("a problem on the card is one the details card lists, in its words", () => {
        const section = facts.section;
        if (section === null || model.flow !== null || !model.card.problem) return;
        const details = sectionCard({
          title: section.sharedTitle ?? "",
          view: section.view,
          resource: "R",
          sectionId: "S",
        });
        // The card's line is a cut of the details card's problem or held fact (the first words of it).
        const line = (model.card.fact ?? "").replace(
          / As last verified; it may have changed\.$/,
          "",
        );
        const listed = [...details.problems, ...details.facts];
        expect(
          listed.some((t) => t.startsWith(line.replace(/\.$/, ""))) ||
            /^Some local changes/.test(line),
          `"${line}" in ${JSON.stringify(listed)}`,
        ).toBe(true);
      });

      it("UXD-11: one card, with a status word, one line of fact and the model's primary", () => {
        const c = model.card;
        expect(c.title).not.toBe("");
        expect(c.status.word).not.toBe("");
        expect(c.status.icon).not.toBe("");
        expect(c.secondary === null || model.primary?.id !== c.secondary.id).toBe(true);
        // One line, in words: no hex and no identifier on the surface.
        expect(c.fact ?? "").not.toContain("\n");
        expect(c.fact ?? "").not.toMatch(/[0-9a-f]{16,}/i);
        // Beside the primary at most Details, and never Details twice.
        expect(c.secondary === null || c.secondary.id === "open-details").toBe(true);
        expect(c.secondary !== null && model.primary?.id === "open-details").toBe(false);
        expect(c.secondary === null || c.secondary.enabled).toBe(true);
        // A problem card is named a problem; "Synced" only for a section that is current.
        const section = facts.section;
        if (c.status.word === "Synced") {
          expect(section?.view.sync.current).toBe(true);
          expect(section?.view.conditions).toEqual([]);
          expect(section?.view.held).toEqual([]);
        }
        if (c.problem) expect(c.status.tone).toBe("problem");
        if (section !== null && model.flow === null)
          expect(c.problem).toBe(
            section.view.held.length > 0 ||
              c.status.word === "Needs repair" ||
              c.status.tone === "problem",
          );
      });

      it("makes the required claims", () => {
        const all = texts.join("\n");
        for (const claim of s.expected.requiredClaims) expect(all, claim).toContain(claim);
      });

      it("UX-08: each caveat that left the surface is reachable from Details", () => {
        const details = detailsTexts(s).join("\n");
        for (const claim of s.expected.requiredDetailsClaims ?? [])
          expect(details, claim).toContain(claim);
      });

      it("makes none of the forbidden claims, on the surface or in Details", () => {
        for (const claim of [...s.expected.forbiddenClaims, ...doc.globalForbiddenClaims])
          for (const t of [...texts, ...detailsTexts(s)])
            expect(t.toLowerCase(), `"${t}" says "${claim}"`).not.toContain(claim.toLowerCase());
      });

      it("UX-08: no status bullet, no caveat and no timestamp on the surface", () => {
        const surface = texts.join("\n");
        for (const caveat of [
          "This does not mean others have seen it",
          "You can edit this section.",
          "Access verified",
          "Access as last verified",
        ])
          expect(surface, caveat).not.toContain(caveat);
        expect(surface).not.toMatch(/\b\d{1,2}:\d{2}(:\d{2})?\b/);
      });
    });
  }
});

describe("the state card (UXD-11, UX-08)", () => {
  const modelOf = (id: string) => {
    const s = doc.states.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return paneModel(paneFactsOf(s.facts));
  };
  const cardOf = (id: string) => modelOf(id).card;

  it("names the section and its status in a word, with the primary of P1", () => {
    const c = cardOf("healthy-can-invite");
    expect([c.title, c.status.word, c.status.icon, c.status.tone]).toEqual([
      "Launch",
      "Synced",
      "check-check",
      "ok",
    ]);
    expect(modelOf("healthy-can-invite").primary?.id).toBe("invite");
    expect(c.secondary?.id).toBe("open-details");
    expect(c.problem).toBe(false);
  });

  it("a problem owns the card: its fix is the primary", () => {
    const c = cardOf("held-boundary-queue-empty");
    expect([c.status.word, c.status.icon, c.status.tone, c.problem]).toEqual([
      "Not syncing",
      "triangle-alert",
      "problem",
      true,
    ]);
    expect(c.fact).toBe("3 edits not sent: the section's start or end marker is damaged.");
    expect(modelOf("held-boundary-queue-empty").primary?.id).toBe("repair-sections");
  });

  it("a conflict, offline and read-only each say their own word", () => {
    expect(cardOf("offline-conflict").status.word).toBe("Conflict");
    expect(cardOf("offline-queued").status).toEqual({
      word: "Offline",
      icon: "cloud-off",
      tone: "muted",
    });
    expect(cardOf("healthy-read-only").status).toEqual({
      word: "Read-only",
      icon: "eye",
      tone: "info",
    });
  });

  it("a section that is still loading is progress, never current", () => {
    const c = cardOf("loading");
    expect(c.status).toEqual({ word: "Loading", icon: "loader", tone: "busy" });
    expect(modelOf("loading").primary?.id).toBe("open-details");
    expect(c.secondary).toBeNull();
  });

  it("no section: says so, and why there is no primary in its place", () => {
    const none = modelOf("no-editor");
    expect(none.card).toMatchObject({
      title: "No note open",
      status: { word: "No note" },
      secondary: null,
    });
    expect([none.primary, none.primaryNone]).toEqual([
      null,
      "Open a note to share from it, or join with a link.",
    ]);
    const crossing = modelOf("selection-crossing");
    expect(crossing.card).toMatchObject({
      title: "No section at the cursor",
      fact: "The selection runs past the end of the heading's section.",
    });
    expect(crossing.primaryNone).toBe(
      "Select the lines of one section, from its heading, to share it.",
    );
  });

  it("a problem row that says what the card says, with the card's button, is not listed again", () => {
    const held = doc.states.find((x) => x.id === "held-boundary-queue-empty");
    if (held === undefined) throw new Error("fixture missing");
    const base = paneFactsOf(held.facts);
    const fact = "3 edits not sent: the section's start or end marker is damaged.";
    const row = (id: string, text: string, action: PaneProblem["action"]): PaneProblem => ({
      id,
      category: "held",
      text,
      source: "Plan.md, line 15",
      action,
      ref: null,
    });
    const m = paneModel({
      ...base,
      problems: [
        row("same", fact, "repair-sections"),
        row("other", "A line of the section cannot be shared.", "go-to-problem"),
        row("same-text-other-button", fact, "go-to-problem"),
      ],
    });
    expect(m.problems.map((p) => p.id)).toEqual(["other", "same-text-other-button"]);
  });

  it("a flow owns the card while it runs; an unknown result is a problem", () => {
    expect(cardOf("running-share")).toMatchObject({
      title: "Sharing a section",
      status: { word: "In progress" },
      secondary: null,
    });
    expect(cardOf("unknown-result-join")).toMatchObject({
      status: { word: "Result unknown" },
      problem: true,
    });
  });
});

describe("pane view model rules beyond the fixtures", () => {
  const state = (id: string) => {
    const s = doc.states.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return paneFactsOf(s.facts);
  };
  const find = (f: PaneFacts, id: string) => {
    const m = paneModel(f);
    return [m.join, ...paneActions(m)].find((a) => a.id === id);
  };

  it("LFCP-03-019: Remove access by the access list's own guards, not by inviting", () => {
    const healthy = state("healthy-can-invite");
    const section = healthy.section;
    if (section === null) throw new Error("no section");
    const remove = (over: Partial<NonNullable<PaneFacts["section"]>>) =>
      find({ ...healthy, section: { ...section, ...over } }, "remove-access");
    expect(find(healthy, "remove-access")?.enabled).toBe(true);
    // Removing needs capability/revoke, inviting capability/grant: one does not stand for the other.
    expect(remove({ canInvite: false })?.enabled).toBe(true);
    expect(remove({ canInvite: true, canRemove: false })).toBeUndefined();
    const unknown = remove({ canRemove: null });
    expect(unknown?.enabled).toBe(false);
    expect(unknown?.reason).toBe(
      "Removing access waits until this device has checked access with the server.",
    );
    // The card's reason when it waits (an earlier access change not recorded yet), word for word.
    const pending = remove({
      removeNote:
        "Removing access waits until this device's earlier access change is recorded by the server.",
    });
    expect(pending?.enabled).toBe(false);
    expect(pending?.reason).toBe(
      "Removing access waits until this device's earlier access change is recorded by the server.",
    );
  });

  it("A8: an entry the descriptors hide is still in the header, disabled with its reason", () => {
    // A selection and no shared section on this device: "Insert into a note…" is not offered below.
    const m = paneModel(state("selection-exact"));
    expect([m.primary, m.card.secondary, ...m.menu].some((a) => a?.id === "insert-into-note")).toBe(
      false,
    );
    const insert = m.header.find((a) => a.id === "insert-into-note");
    expect(insert?.enabled).toBe(false);
    expect(insert?.reason).toMatch(/share one/);
    expect(m.header.length).toBe(3);
    expect(m.header[2]?.enabled).toBe(true);
  });

  it("D10: hides what does not apply, disables with a reason what applies but is blocked", () => {
    expect(find(state("no-editor"), "copy-readable")).toBeUndefined();
    const detach = find(state("loading"), "detach-section");
    expect(detach?.enabled).toBe(false);
    expect(detach?.reason).toBe("Detaching waits until this section has loaded on this device.");
  });

  it("UXD-11 (C6, N-05): what a change does is the details card's, not the pane's surface", () => {
    for (const st of doc.states) {
      const texts = paneTexts(paneModel(paneFactsOf(st.facts)));
      for (const t of [BODY_DELETE_TEXT, WHOLE_COPY_TEXT]) expect(texts, st.id).not.toContain(t);
    }
    // Details says what deleting text and removing the whole copy do, where this vault's edits go out.
    const s = state("healthy-can-invite").section;
    if (s === null) throw new Error("no section");
    const card = sectionCard({ title: "Launch", view: s.view, resource: "R", sectionId: "S" });
    expect(card.shared).toEqual(expect.arrayContaining([BODY_DELETE_TEXT, WHOLE_COPY_TEXT]));
    // A reader's deletions are held, not sent: no shared delete is promised.
    const reader = state("healthy-read-only").section;
    if (reader === null) throw new Error("no section");
    const readerCard = sectionCard({
      title: "L",
      view: reader.view,
      resource: "R",
      sectionId: "S",
    });
    expect(readerCard.shared).not.toContain(BODY_DELETE_TEXT);
    expect(readerCard.shared).toContain(WHOLE_COPY_TEXT);
    // Detaching says what it does in its own confirmation, before anything is changed.
    expect(DETACH_CONFIRMATION).toMatch(/stays in this note/);
    expect(DETACH_CONFIRMATION).toMatch(/collaborators and their access are not changed/);
  });

  it("D9: the section under the cursor, else the one chosen, else the one just joined", () => {
    expect(paneFocus({ underCursor: "a", chosen: "b", justJoined: "c" })).toBe("a");
    expect(paneFocus({ underCursor: null, chosen: "b", justJoined: "c" })).toBe("b");
    expect(paneFocus({ underCursor: null, chosen: null, justJoined: "c" })).toBe("c");
    expect(paneFocus({ underCursor: null, chosen: null, justJoined: null })).toBeNull();
  });
});
