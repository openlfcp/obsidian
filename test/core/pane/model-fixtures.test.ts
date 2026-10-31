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
  paneFocus,
  paneModel,
  paneTexts,
} from "../../../src/core/pane/model";
import {
  BODY_DELETE_TEXT,
  DETACH_TEXT,
  sectionCard,
  WHOLE_COPY_TEXT,
} from "../../../src/core/status/card";
import { statusView } from "../../../src/core/status/reducer";

interface Expected {
  primaryCta: string | null;
  primaryCtaNone?: string;
  enabled: { action: string; reason: string }[];
  disabled: { action: string; reason: string }[];
  requiredClaims: string[];
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

const time = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

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
      const model = paneModel(facts, { time });
      const actions: PaneAction[] = [
        model.join,
        ...(model.primary === null ? [] : [model.primary]),
        ...model.secondary,
        ...model.menu,
      ];
      const byId = new Map(actions.map((a) => [a.id as string, a]));
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

      it("keeps destructive actions out of the primary place and every action unique", () => {
        expect(model.secondary.every((a) => !a.destructive)).toBe(true);
        expect(model.menu.every((a) => a.destructive)).toBe(true);
        expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
      });

      it("says each problem in the card's words", () => {
        const section = facts.section;
        if (section === null) return;
        const card = sectionCard({
          title: section.sharedTitle ?? "",
          view: section.view,
          resource: "R",
          sectionId: "S",
        });
        const problems = model.status.filter((l) => l.tone === "problem").map((l) => l.text);
        expect(problems.slice(0, card.problems.length)).toEqual(card.problems);
        // The held facts after them are the card's facts too.
        for (const p of problems.slice(card.problems.length)) expect(card.facts).toContain(p);
      });

      it("makes the required claims", () => {
        const all = texts.join("\n");
        for (const claim of s.expected.requiredClaims) expect(all, claim).toContain(claim);
      });

      it("makes none of the forbidden claims", () => {
        for (const claim of [...s.expected.forbiddenClaims, ...doc.globalForbiddenClaims])
          for (const t of texts)
            expect(t.toLowerCase(), `"${t}" says "${claim}"`).not.toContain(claim.toLowerCase());
      });
    });
  }
});

describe("pane view model rules beyond the fixtures", () => {
  const state = (id: string) => {
    const s = doc.states.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return paneFactsOf(s.facts);
  };
  const find = (f: PaneFacts, id: string) => {
    const m = paneModel(f, { time });
    return [m.join, ...(m.primary === null ? [] : [m.primary]), ...m.secondary, ...m.menu].find(
      (a) => a.id === id,
    );
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
    const m = paneModel(state("selection-exact"), { time });
    expect([m.primary, ...m.secondary, ...m.menu].some((a) => a?.id === "insert-into-note")).toBe(
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

  it("LFCP-03-019 (C6, N-05): deleting, removing the copy and detaching are told apart before acting", () => {
    const m = (id: string) => paneModel(state(id), { time });
    expect(m("healthy-can-invite").effects).toEqual([
      BODY_DELETE_TEXT,
      WHOLE_COPY_TEXT,
      DETACH_TEXT,
    ]);
    // A reader's deletions are held, not sent: no shared delete is promised.
    expect(m("healthy-read-only").effects).toEqual([WHOLE_COPY_TEXT, DETACH_TEXT]);
    expect(m("access-refused-held").effects).not.toContain(BODY_DELETE_TEXT);
    // Not in a section: nothing to say.
    expect(m("no-editor").effects).toEqual([]);
    expect(m("selection-exact").effects).toEqual([]);
    // The card says the same, in the same words.
    const s = state("healthy-can-invite").section;
    if (s === null) throw new Error("no section");
    const card = sectionCard({ title: "Launch", view: s.view, resource: "R", sectionId: "S" });
    expect(card.shared).toEqual(expect.arrayContaining([BODY_DELETE_TEXT, WHOLE_COPY_TEXT]));
    expect(paneTexts(m("healthy-can-invite"))).toContain(DETACH_TEXT);
  });

  it("D9: the section under the cursor, else the one chosen, else the one just joined", () => {
    expect(paneFocus({ underCursor: "a", chosen: "b", justJoined: "c" })).toBe("a");
    expect(paneFocus({ underCursor: null, chosen: "b", justJoined: "c" })).toBe("b");
    expect(paneFocus({ underCursor: null, chosen: null, justJoined: "c" })).toBe("c");
    expect(paneFocus({ underCursor: null, chosen: null, justJoined: null })).toBeNull();
  });
});
