// LFCP-03-021 (U03-01, U03-02, U03-08; F-01, F-02): the pane's short tips
// and first-use state, on the frozen UX states run through the real
// reducer. One tip at a time, for what the pane offers now; none while a
// problem or a flow holds the pane; a hidden tip comes back with "Show tips
// again"; problems, held edits and the effects of a change are never tips.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIDE_HINT,
  HINT_IDS,
  HINTS,
  hiddenHints,
  hideHint,
  isHintId,
  SHOW_HINTS,
} from "../../../src/core/pane/hints";
import { type FixtureFacts, paneFactsOf } from "../../../src/core/pane/mock-facts";
import {
  EMPTY_SECTIONS,
  NO_PRIMARY,
  type PaneFacts,
  paneModel,
  paneTexts,
} from "../../../src/core/pane/model";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
) as {
  globalForbiddenClaims: string[];
  states: { id: string; facts: FixtureFacts; expected: { forbiddenClaims: string[] } }[];
};

const state = (id: string) => {
  const s = doc.states.find((x) => x.id === id);
  if (s === undefined) throw new Error(id);
  return s;
};

const facts = (id: string, hidden: readonly string[] = []): PaneFacts => ({
  ...paneFactsOf(state(id).facts),
  hints: { hidden },
});

const model = (f: PaneFacts) => paneModel(f, { time: () => "t" });

/** A first install: no note open, the list read and empty. */
const FIRST: PaneFacts = {
  context: { editor: "none", note: null, cursor: "none", selection: null, flow: null },
  registry: { status: "ready", placementIndex: "complete", sections: 0, unplaced: 0, rows: [] },
  section: null,
  hints: { hidden: [] },
};

describe("first use (U03-01, U03-02)", () => {
  it("leads to share and join, with the first-use tip, and no tour or dialog", () => {
    const m = model(FIRST);
    expect(m.sections.summary).toBe(EMPTY_SECTIONS);
    expect(m.sections.summary).toMatch(/Share one from a note, or join one with a link/);
    expect(m.primaryNone).toBe(NO_PRIMARY.noNote);
    expect(m.join.enabled).toBe(true);
    expect(m.hint).toEqual({ id: "first-use", text: HINTS["first-use"], hide: HIDE_HINT });
    expect(m.hint?.text).toContain("Share section…");
    expect(m.hint?.text).toContain("Join with a link…");
    expect(m.showHints).toBeNull();
  });

  it("says what is shared as the content policy does: lines added later, comments local by default", () => {
    const t = HINTS["first-use"];
    expect(t).toMatch(/every line under it are shared, also lines added there later/);
    expect(t).toMatch(/comments stay on this device by default/);
    // Copies (projections): one shared section, a copy in each note.
    expect(HINTS["insert-copies"]).toMatch(/adds a copy of this section/);
    expect(HINTS["share-preview"]).toMatch(/each note keeps a copy/);
  });

  it("is not shown while the list is being read, nor once a section exists", () => {
    const loading = model({
      ...FIRST,
      registry: { status: "loading", placementIndex: "unknown", sections: null, unplaced: null },
    });
    expect(loading.hint).toBeNull();
    expect(paneTexts(loading).join("\n")).not.toContain("No shared sections");
    const error = model({
      ...FIRST,
      registry: { status: "error", placementIndex: "unknown", sections: null, unplaced: null },
    });
    expect(error.hint).toBeNull();
    expect(model(facts("no-editor")).hint).toBeNull();
  });

  it("shows no tips where the facts do not ask for them (the developer prototype)", () => {
    const { hints: _, ...bare } = FIRST;
    const m = model(bare);
    expect(m.hint).toBeNull();
    expect(m.showHints).toBeNull();
  });
});

describe("the tip for what is offered now (U03-08)", () => {
  it.each([
    ["selection-exact", "share-preview"],
    ["content-comments-and-table", "share-preview"],
    ["unplaced", "insert-copies"],
    ["healthy-can-invite", "invite-link"],
    ["healthy-read-only", "section-copy"],
    ["selection-heading-only", "first-use"],
  ])("%s: %s", (id, hint) => {
    expect(model(facts(id)).hint?.id).toBe(hint);
  });

  it("the invitation tip says the user passes the link on; nothing is sent", () => {
    expect(HINTS["invite-link"]).toMatch(/does not send it: pass it on yourself/);
  });

  it("the ✓✓ tip says shared, not seen", () => {
    expect(HINTS["section-copy"]).toMatch(/means the section is shared, not that anyone has seen/);
  });

  it.each([
    "held-boundary-queue-empty",
    "held-count-unknown",
    "access-refused-held",
    "offline-conflict",
    "running-share",
    "unknown-result-join",
    "unknown-result-insert",
  ])("%s: no tip while a problem or a flow holds the pane", (id) => {
    expect(model(facts(id)).hint).toBeNull();
  });

  it("makes no forbidden claim in any state, hidden tips or not", () => {
    for (const s of doc.states)
      for (const hidden of [[], [...HINT_IDS]]) {
        const all = paneTexts(model(facts(s.id, hidden))).join("\n");
        for (const claim of [...s.expected.forbiddenClaims, ...doc.globalForbiddenClaims])
          expect(all, `${s.id}: ${claim}`).not.toContain(claim);
      }
    for (const t of Object.values(HINTS))
      expect(t).not.toMatch(/\bdeliver|\b(?:seen|read|received) by\b|\bsent to\b/i);
  });
});

describe("hiding a tip and bringing it back", () => {
  it("hides one tip; the next that applies shows; Show tips again offers them back", () => {
    const one = model(facts("healthy-can-invite", ["invite-link"]));
    expect(one.hint?.id).toBe("section-copy");
    expect(one.showHints).toBe(SHOW_HINTS);
    const all = model(facts("healthy-can-invite", ["invite-link", "section-copy"]));
    expect(all.hint).toBeNull();
    expect(paneTexts(all)).toContain(SHOW_HINTS);
    expect(model(facts("healthy-can-invite", [])).hint?.id).toBe("invite-link");
  });

  it("never hides a problem, a held edit, an effect of a change or the one-time-link sentence", () => {
    for (const s of doc.states) {
      const shown = model(facts(s.id));
      const hidden = model(facts(s.id, [...HINT_IDS]));
      expect(hidden.status, s.id).toEqual(shown.status);
      expect(hidden.problems, s.id).toEqual(shown.problems);
      expect(hidden.effects, s.id).toEqual(shown.effects);
      expect(hidden.flow, s.id).toEqual(shown.flow);
      expect(hidden.primary, s.id).toEqual(shown.primary);
      expect(hidden.preview, s.id).toEqual(shown.preview);
    }
  });

  it("counts only the tips this version knows, and hides each once", () => {
    expect(hiddenHints(["first-use", "a-tip-of-0-6", "first-use"])).toBe(1);
    expect(model({ ...FIRST, hints: { hidden: ["a-tip-of-0-6"] } }).showHints).toBeNull();
    expect(hideHint(["first-use"], "first-use")).toEqual(["first-use"]);
    expect(hideHint(["a-tip-of-0-6"], "invite-link")).toEqual(["a-tip-of-0-6", "invite-link"]);
    expect(isHintId("first-use")).toBe(true);
    expect(isHintId("First-use")).toBe(false);
  });
});
