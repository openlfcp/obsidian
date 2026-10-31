// The action descriptors (LFCP-03-010, U03-07): availability as a pure
// predicate (hidden, disabled with its reason, enabled), the one source
// the pane reads, and the host guard the executor checks again.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "../../../src/core/actions/catalog";
import {
  availabilities,
  DESCRIPTOR_ORDER,
  DESCRIPTORS,
  hostRefusal,
  hostRefusalNotice,
  hostRefusalReason,
  RUNNING,
} from "../../../src/core/actions/descriptors";
import { SECTIONS_READ_ONLY } from "../../../src/core/lfcp/runtime";
import { type FixtureFacts, paneFactsOf } from "../../../src/core/pane/mock-facts";
import { type PaneFacts, paneModel } from "../../../src/core/pane/model";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/ux-0.3/states.json"), "utf8"),
) as { states: { id: string; facts: FixtureFacts }[] };
const state = (id: string): PaneFacts => {
  const s = doc.states.find((x) => x.id === id);
  if (s === undefined) throw new Error(id);
  return paneFactsOf(s.facts);
};

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};

describe("action descriptors", () => {
  it("cover the catalogue: every action ID, its label and destructive flag", () => {
    expect([...DESCRIPTOR_ORDER].sort()).toEqual([...ACTION_IDS].sort());
    for (const id of ACTION_IDS) expect(DESCRIPTORS[id].id).toBe(id);
  });

  it("availability is pure: frozen facts, the same answer twice", () => {
    for (const s of doc.states) {
      const facts = deepFreeze(paneFactsOf(s.facts));
      const once = availabilities(facts);
      expect(availabilities(facts), s.id).toEqual(once);
      for (const id of ACTION_IDS) {
        const a = DESCRIPTORS[id].availability(facts);
        expect(a.kind === "hidden" ? undefined : a, `${s.id} ${id}`).toEqual(once.get(id));
      }
    }
  });

  it("the pane shows exactly the descriptors' availability, no copy of its own", () => {
    for (const s of doc.states) {
      const facts = paneFactsOf(s.facts);
      const m = paneModel(facts);
      const expected = availabilities(facts);
      // The header draws Share, Insert and Join always (A8); an entry the descriptors hide is drawn blocked, not an offer.
      const shown = new Map(
        [
          m.join,
          ...(m.primary === null ? [] : [m.primary]),
          ...(m.card.secondary === null ? [] : [m.card.secondary]),
          ...m.menu,
          ...m.header.filter((a) => expected.has(a.id)),
        ].map((a) => [
          a.id,
          a.enabled ? { kind: "enabled" } : { kind: "disabled", reason: a.reason },
        ]),
      );
      // "Open for editing" may stand in for a source-changing primary (T4); otherwise the same entries.
      for (const [id, a] of shown) expect(a, `${s.id} ${id}`).toEqual(expected.get(id));
      for (const [id] of expected) expect(shown.has(id), `${s.id} ${id} shown`).toBe(true);
    }
  });

  it("A5/D10: what does not apply is hidden; what applies but is blocked says why", () => {
    expect(DESCRIPTORS["copy-readable"].availability(state("no-editor"))).toEqual({
      kind: "hidden",
    });
    expect(DESCRIPTORS["detach-section"].availability(state("loading"))).toEqual({
      kind: "disabled",
      reason: "Detaching waits until this section has loaded on this device.",
    });
  });

  it("LFCP-03-019: access, copy and detach from the pane, by placement, rights and refusal", () => {
    const healthy = state("healthy-can-invite");
    expect(DESCRIPTORS["copy-shared-section"].availability(healthy)).toEqual({ kind: "enabled" });
    expect(DESCRIPTORS["remove-access"].availability(healthy)).toEqual({ kind: "enabled" });
    // A selection outside a section, or no note: no copy of a section, no detach.
    for (const id of ["selection-exact", "no-editor"])
      for (const a of ["copy-shared-section", "copy-readable", "detach-section"] as const)
        expect(DESCRIPTORS[a].availability(state(id)), `${id} ${a}`).toEqual({ kind: "hidden" });
    // A reader removes nobody: not offered; it may still copy and detach its own copy.
    const reader = state("healthy-read-only");
    expect(DESCRIPTORS["remove-access"].availability(reader)).toEqual({ kind: "hidden" });
    expect(DESCRIPTORS["detach-section"].availability(reader)).toEqual({ kind: "enabled" });
    // Refused by the server: the chain may still grant removing; the server's answer wins.
    const refused = state("access-refused-held");
    const section = refused.section;
    if (section === null) throw new Error("no section");
    expect(
      DESCRIPTORS["remove-access"].availability({
        ...refused,
        section: { ...section, canRemove: true },
      }),
    ).toEqual({
      kind: "disabled",
      reason: "Removing access needs the server to accept this vault's access to this section.",
    });
    expect(DESCRIPTORS["detach-section"].availability(refused)).toEqual({ kind: "enabled" });
  });

  it("the host guard: read-only, starting and unavailable disable the actions that need the host", () => {
    const healthy = state("healthy-can-invite");
    const host = (h: Partial<typeof RUNNING>) => ({ ...healthy, host: { ...RUNNING, ...h } });
    const readOnly = availabilities(host({ readOnly: true }));
    expect(readOnly.get("invite")).toEqual({ kind: "disabled", reason: `${SECTIONS_READ_ONLY}.` });
    expect(readOnly.get("remove-access")).toEqual({
      kind: "disabled",
      reason: `${SECTIONS_READ_ONLY}.`,
    });
    // Reading a section is not writing: its details stay open.
    expect(readOnly.get("open-details")).toEqual({ kind: "enabled" });
    const starting = availabilities(host({ starting: true }));
    expect(starting.get("join-with-link")).toEqual({
      kind: "disabled",
      reason: "Shared Tasks is still starting.",
    });
    const unavailable = availabilities(
      host({ unavailable: "Shared Tasks: another window holds this vault." }),
    );
    expect(unavailable.get("join-with-link")).toEqual({
      kind: "disabled",
      reason: "another window holds this vault.",
    });
    const share = state("selection-exact");
    expect(
      DESCRIPTORS["share-section"].availability({ ...share, host: { ...RUNNING, readOnly: true } }),
    ).toEqual({ kind: "disabled", reason: `${SECTIONS_READ_ONLY}.` });
    expect(
      DESCRIPTORS["share-section"].availability({ ...share, host: { ...RUNNING, server: false } }),
    ).toEqual({
      kind: "disabled",
      reason: "Set a default sync server in the settings to share a section.",
    });
  });

  it("the executor says the same refusal as a notice, in the guard's order", () => {
    const all = {
      unavailable: "Shared Tasks: held elsewhere.",
      starting: true,
      readOnly: true,
      server: false,
    };
    expect(hostRefusal(all, { writes: true, server: true })).toEqual({
      kind: "unavailable",
      text: "Shared Tasks: held elsewhere.",
    });
    const r = hostRefusal({ ...all, unavailable: null }, { writes: true, server: true });
    expect(r).toEqual({ kind: "read-only" });
    expect(hostRefusalNotice({ kind: "read-only" })).toBe(`Shared Tasks: ${SECTIONS_READ_ONLY}.`);
    expect(hostRefusal({ ...all, unavailable: null, readOnly: false }, { writes: true })).toEqual({
      kind: "starting",
    });
    expect(hostRefusalNotice({ kind: "starting" })).toBe(
      "Shared Tasks: still starting. Try again in a moment.",
    );
    expect(hostRefusal({ ...RUNNING, server: false }, { server: true })).toEqual({
      kind: "no-server",
    });
    expect(hostRefusal({ ...RUNNING, readOnly: true }, {})).toBeNull();
    expect(hostRefusalReason({ kind: "no-server" })).toBe(
      "Set a default sync server in the settings to share a section.",
    );
  });
});
