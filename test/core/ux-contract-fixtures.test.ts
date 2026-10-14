// The MVP 0.3 UX state fixtures (LFCP-03-006, docs/architecture/ux-contract-0.3.md
// §13): their shape, the coverage of the required states and their
// consistency with the action catalogue and the status facts. The reducer
// and the pane run the same fixtures later (LFCP-03-013, 023); this test
// does not bind them to code beyond the state and cause names.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_CAUSE } from "../../src/core/status/held";
import { STATE_LABEL } from "../../src/core/status/reducer";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const FILE = join(import.meta.dirname, "../fixtures/ux-0.3/states.json");
const doc = JSON.parse(readFileSync(FILE, "utf8")) as Obj;

const STATES = new Set(Object.keys(STATE_LABEL));
const CAUSES = new Set(Object.keys(HELD_CAUSE));
const ACCESS = new Set([
  "writer",
  "reader",
  "unavailable-key",
  "unknown",
  "revoked",
  "not-member",
  "refused",
]);
const CONNECTION = new Set(["offline", "connecting", "connected", "failed"]);
const QUALIFIER = new Set([
  "no-evidence",
  "not-syncing",
  "lost",
  "network-offline",
  "not-responding",
]);
const EDITOR = new Set(["none", "source", "live-preview", "reading"]);
const CURSOR = new Set(["none", "private-heading", "private-text", "inside-section"]);
const SELECTION_REASONS = new Set([
  "no-heading-start",
  "partial-line",
  "crossing",
  "nested-heading",
  "partial-block",
  "unclosed-fence",
  "already-bound",
  "legacy-tasks",
  "broken-ref",
]);

const obj = (v: Json | undefined, where: string): Obj => {
  expect(v, where).toBeTypeOf("object");
  expect(v, where).not.toBeNull();
  expect(Array.isArray(v), where).toBe(false);
  return v as Obj;
};
const arr = (v: Json | undefined, where: string): Json[] => {
  expect(Array.isArray(v), where).toBe(true);
  return v as Json[];
};
const str = (v: Json | undefined, where: string): string => {
  expect(v, where).toBeTypeOf("string");
  expect((v as string).trim(), where).not.toBe("");
  return v as string;
};
const count = (v: Json | undefined, where: string): number | null => {
  if (v === null) return null;
  expect(Number.isInteger(v), where).toBe(true);
  expect(v as number, where).toBeGreaterThanOrEqual(0);
  return v as number;
};
const oneOf = (v: Json | undefined, set: ReadonlySet<string>, where: string): string => {
  expect(set.has(v as string), `${where}: ${String(v)}`).toBe(true);
  return v as string;
};
const lower = (s: string) => s.toLowerCase();

const actions = arr(doc.actions, "actions").map((a, i) => obj(a, `actions[${i}]`));
const catalogue = new Map(actions.map((a) => [a.id as string, a]));
const states = arr(doc.states, "states").map((s, i) => obj(s, `states[${i}]`));
const globalForbidden = arr(doc.globalForbiddenClaims, "globalForbiddenClaims").map((c, i) =>
  str(c, `globalForbiddenClaims[${i}]`),
);

/** StatusView.sync (LFCP-03-003): the shape and the invariants of `current`. */
function checkSync(sync: Obj, state: string, heldCheck: string, where: string): void {
  const checked = heldCheck === "checked";
  const queue = obj(sync.queue, `${where}.queue`);
  const batches = count(queue.batches, `${where}.queue.batches`);
  expect(batches, `${where}.queue.batches`).not.toBeNull();
  expect(queue.counted, `${where}.queue.counted`).toBeTypeOf("boolean");
  expect(count(queue.units, `${where}.queue.units`)).not.toBeNull();

  const held = obj(sync.held, `${where}.held`);
  const projections = count(held.projections, `${where}.held.projections`);
  const edits = count(held.edits, `${where}.held.edits`);
  for (const c of arr(held.causes, `${where}.held.causes`))
    oneOf(c, CAUSES, `${where}.held.causes`);
  if (held.persistence !== null)
    oneOf(held.persistence, new Set(["saved", "unsaved", "unknown"]), `${where}.held.persistence`);
  // An unchecked note makes every held count unknown.
  if (projections === null) expect(edits, `${where}: edits unknown while unchecked`).toBeNull();
  // Held counts are unknown exactly while some note is not checked (heldCheck, LFCP-03-003).
  expect(
    projections === null,
    `${where}: held.projections null iff heldCheck is not "checked"`,
  ).toBe(!checked);
  if (!checked) expect(held.persistence, `${where}: persistence while unchecked`).toBe("unknown");
  if (projections === 0) {
    expect(edits, `${where}: nothing held`).toBe(0);
    expect(held.persistence, `${where}: nothing held`).toBeNull();
  }

  const local = oneOf(
    sync.localPersistence,
    new Set(["confirmed", "unconfirmed", "failed"]),
    `${where}.localPersistence`,
  );
  const model = oneOf(
    sync.sharedModel,
    new Set(["accepted", "catching-up", "unknown"]),
    `${where}.sharedModel`,
  );
  expect(sync.current, `${where}.current`).toBeTypeOf("boolean");
  // A note not checked may hold edits not known to be on disk (the reducer, LFCP-03-003).
  if (!checked) expect(local, `${where}: local saving while unchecked`).not.toBe("confirmed");

  let heldSum: number | null = 0;
  for (const [i, p] of arr(sync.projections, `${where}.projections`).entries()) {
    const at = `${where}.projections[${i}]`;
    const ps = obj(p, at);
    str(ps.id, `${at}.id`);
    oneOf(ps.state, STATES, `${at}.state`);
    expect(ps.checked, `${at}.checked follows heldCheck`).toBe(checked);
    expect(ps.current, `${at}.current`).toBeTypeOf("boolean");
    if (ps.held !== null) {
      const h = obj(ps.held, `${at}.held`);
      str(h.path, `${at}.held.path`);
      expect(h.projectionId, `${at}.held.projectionId`).toBe(ps.id);
      oneOf(h.cause, CAUSES, `${at}.held.cause`);
      const n = count(h.count, `${at}.held.count`);
      heldSum = heldSum === null || n === null ? null : heldSum + n;
      expect(ps.current, `${at}: a copy holding edits is never current`).toBe(false);
    }
  }
  if (projections !== null && edits !== null)
    expect(heldSum, `${where}: held.edits is the sum of the copies`).toBe(edits);

  // The reducer's predicate: current only when nothing is held, unchecked, queued or failing.
  if (sync.current === true) {
    expect(["CURRENT", "READ_ONLY_CURRENT"], `${where}: state`).toContain(state);
    expect(projections, `${where}: current with held or unchecked`).toBe(0);
    expect(batches, `${where}: current with a queue`).toBe(0);
    expect(local, `${where}: current with unconfirmed saving`).toBe("confirmed");
    expect(model, `${where}: current with the model not accepted`).toBe("accepted");
  }
}

function checkSection(section: Obj, where: string): void {
  str(section.key, `${where}.key`);
  if (section.sharedTitle !== null) str(section.sharedTitle, `${where}.sharedTitle`);
  str(section.localAlias, `${where}.localAlias`);
  const state = oneOf(section.state, STATES, `${where}.state`);
  const heldCheck = oneOf(
    section.heldCheck,
    new Set(["checked", "pending", "failed"]),
    `${where}.heldCheck`,
  );
  // pending → LOADING (held-unchecked, last); failed → ATTENTION (held-unknown).
  if (heldCheck === "failed") expect(state, `${where}: a failed check`).toBe("ATTENTION");
  if (heldCheck === "pending")
    expect(["CURRENT", "READ_ONLY_CURRENT"], `${where}: a pending check`).not.toContain(state);
  count(section.placements, `${where}.placements`);
  const access = obj(section.access, `${where}.access`);
  oneOf(access.access, ACCESS, `${where}.access.access`);
  // StatusView.access (LFCP-03-005): verifiedAt in local milliseconds, as AccessFacts.
  expect(Object.keys(access).sort(), `${where}.access keys`).toEqual([
    "access",
    "checking",
    "current",
    "verifiedAt",
  ]);
  count(access.verifiedAt, `${where}.access.verifiedAt`);
  if (access.current !== null)
    expect(access.current, `${where}.access.current`).toBeTypeOf("boolean");
  expect(access.checking, `${where}.access.checking`).toBeTypeOf("boolean");
  // Inviting comes from the access list (AccessView), not from the status facts.
  const view = obj(section.accessView, `${where}.accessView`);
  if (view.canInvite !== null)
    expect(view.canInvite, `${where}.accessView.canInvite`).toBeTypeOf("boolean");
  if (section.connection !== null) {
    const connection = oneOf(section.connection, CONNECTION, `${where}.connection`);
    // StatusView.connectionQualifier: null while connected or connecting (a failed attempt may have none).
    if (connection === "connected" || connection === "connecting")
      expect(section.connectionQualifier, `${where}.connectionQualifier`).toBeNull();
    else if (connection === "offline" || section.connectionQualifier !== null)
      oneOf(section.connectionQualifier, QUALIFIER, `${where}.connectionQualifier`);
  }
  if (section.refusal !== null) str(section.refusal, `${where}.refusal`);
  for (const [i, p] of arr(section.problems, `${where}.problems`).entries()) {
    const pr = obj(p, `${where}.problems[${i}]`);
    oneOf(pr.kind, new Set(["structural", "scalar"]), `${where}.problems[${i}].kind`);
    str(pr.code, `${where}.problems[${i}].code`);
    arr(pr.nodeIds, `${where}.problems[${i}].nodeIds`);
  }
  checkSync(obj(section.sync, `${where}.sync`), state, heldCheck, `${where}.sync`);
}

function checkContext(context: Obj, where: string): void {
  oneOf(context.editor, EDITOR, `${where}.editor`);
  if (context.editor === "none") expect(context.note, `${where}.note`).toBeNull();
  else str(context.note, `${where}.note`);
  oneOf(context.cursor, CURSOR, `${where}.cursor`);
  if (context.selection !== null) {
    const s = obj(context.selection, `${where}.selection`);
    const from = count(s.fromLine, `${where}.selection.fromLine`) ?? -1;
    const to = count(s.toLine, `${where}.selection.toLine`) ?? -1;
    expect(to, `${where}.selection`).toBeGreaterThanOrEqual(from);
    const kind = oneOf(s.eligibility, new Set(["exact", "ineligible"]), `${where}.selection`);
    if (kind === "exact") {
      expect(s.reason, `${where}: an exact selection has no reason`).toBeNull();
      expect(s.fallback, `${where}: an exact selection has no fallback`).toBeNull();
    } else {
      oneOf(s.reason, SELECTION_REASONS, `${where}.selection.reason`);
      if (s.fallback !== null) expect(s.fallback).toBe("share-whole-section");
    }
  }
  if (context.flow !== null) {
    const f = obj(context.flow, `${where}.flow`);
    oneOf(f.kind, new Set(["share", "invite", "join", "insert", "repair"]), `${where}.flow.kind`);
    str(f.stage, `${where}.flow.stage`);
    if (f.target !== undefined) str(f.target, `${where}.flow.target`);
    oneOf(f.outcome, new Set(["running", "unknown", "unfinished"]), `${where}.flow.outcome`);
  }
}

describe("UX 0.3 state fixtures", () => {
  it("names its schema and the contract", () => {
    expect(doc.schema).toBe("lfcp-ux-states/0.3");
    expect(doc.contract).toBe("docs/architecture/ux-contract-0.3.md");
  });

  it("has a catalogue of unique actions with labels", () => {
    expect(catalogue.size).toBe(actions.length);
    for (const a of actions) {
      str(a.id, "action id");
      const label = str(a.label, `${a.id}.label`);
      expect(a.destructive, `${a.id}.destructive`).toBeTypeOf("boolean");
      for (const claim of globalForbidden)
        expect(lower(label), `${a.id} label says "${claim}"`).not.toContain(lower(claim));
    }
  });

  it("covers every required state", () => {
    const required = arr(doc.requiredCategories, "requiredCategories").map((c) => c as string);
    expect(required).toEqual([
      "no-editor",
      "loading",
      "unplaced",
      "healthy",
      "held",
      "conflict-offline",
      "access-stale",
      "unknown-result",
    ]);
    const present = new Set(states.map((s) => s.category as string));
    for (const c of required) expect(present.has(c), `no fixture for ${c}`).toBe(true);
  });

  it("gives every state a unique id", () => {
    const ids = states.map((s) => str(s.id, "state id"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const s of states) {
    const id = s.id as string;
    describe(id, () => {
      it("has its cases, findings and facts", () => {
        str(s.category, `${id}.category`);
        str(s.description, `${id}.description`);
        for (const c of arr(s.cases, `${id}.cases`)) expect(c).toMatch(/^U03-\d{2}$/);
        expect(arr(s.cases, `${id}.cases`).length).toBeGreaterThan(0);
        for (const f of arr(s.findings, `${id}.findings`)) expect(f).toMatch(/^F-(C)?\d{2}$/);
        const facts = obj(s.facts, `${id}.facts`);
        checkContext(obj(facts.context, `${id}.facts.context`), `${id}.facts.context`);
        const registry = obj(facts.registry, `${id}.facts.registry`);
        oneOf(registry.status, new Set(["loading", "ready", "error"]), `${id}.registry.status`);
        oneOf(
          registry.placementIndex,
          new Set(["building", "complete", "unknown"]),
          `${id}.registry.placementIndex`,
        );
        count(registry.sections, `${id}.registry.sections`);
        const unplaced = count(registry.unplaced, `${id}.registry.unplaced`);
        // "Not inserted yet" needs a complete placement index (U03-02).
        if (registry.placementIndex !== "complete")
          expect(unplaced, `${id}: unplaced known before the index`).toBeNull();
        if (facts.section !== null)
          checkSection(obj(facts.section, `${id}.facts.section`), `${id}.facts.section`);
      });

      it("has one primary action, enabled, never destructive", () => {
        const e = obj(s.expected, `${id}.expected`);
        const enabled = arr(e.enabled, `${id}.enabled`).map((x) => obj(x, `${id}.enabled`));
        const disabled = arr(e.disabled, `${id}.disabled`).map((x) => obj(x, `${id}.disabled`));
        for (const x of [...enabled, ...disabled]) {
          expect(catalogue.has(x.action as string), `${id}: unknown action ${x.action}`).toBe(true);
          str(x.reason, `${id}: reason for ${x.action}`);
        }
        const on = new Set(enabled.map((x) => x.action as string));
        const off = new Set(disabled.map((x) => x.action as string));
        expect(on.size, `${id}: enabled repeats an action`).toBe(enabled.length);
        expect(off.size, `${id}: disabled repeats an action`).toBe(disabled.length);
        for (const a of on) expect(off.has(a), `${id}: ${a} both enabled and disabled`).toBe(false);
        if (e.primaryCta === null) str(e.primaryCtaNone, `${id}.primaryCtaNone`);
        else {
          const cta = str(e.primaryCta, `${id}.primaryCta`);
          expect(catalogue.get(cta)?.destructive, `${id}: primary ${cta}`).toBe(false);
          expect(on.has(cta), `${id}: primary ${cta} is not enabled`).toBe(true);
        }
      });

      it("lists the false claims it must not make, none of which it requires", () => {
        const e = obj(s.expected, `${id}.expected`);
        const forbidden = arr(e.forbiddenClaims, `${id}.forbiddenClaims`).map((c) =>
          str(c, `${id}.forbiddenClaims`),
        );
        expect(forbidden.length, `${id}: no forbidden claims`).toBeGreaterThan(0);
        const required = arr(e.requiredClaims, `${id}.requiredClaims`).map((c) =>
          str(c, `${id}.requiredClaims`),
        );
        const enabledLabels = arr(e.enabled, `${id}.enabled`).map(
          (x) => catalogue.get((x as Obj).action as string)?.label as string,
        );
        const said = [...required, ...enabledLabels].map(lower);
        for (const claim of [...forbidden, ...globalForbidden])
          for (const text of said)
            expect(text, `${id}: "${text}" makes the claim "${claim}"`).not.toContain(lower(claim));
      });
    });
  }
});
