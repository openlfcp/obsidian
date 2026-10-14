// The clickable pane prototype (LFCP-03-007): the four layouts of
// OBSIDIAN-CONTEXTUAL-UX-03 §3, the UX state fixtures, and three flows on
// mock facts: share → invite, join → insert, and a problem (held edits →
// repair). Each click moves to the next mock state. Nothing here calls an
// operation, the network, the vault or the clipboard: a prototype is not
// sync and not evidence. Pure: no Obsidian; the developer view
// (src/obsidian/ui/pane-prototype-view.ts) renders `model()`.

import type { ActionId } from "./actions";
import { ACTIONS } from "./actions";
import { FLOW_STAGES, type FlowKind, flowAction, stageOf } from "./flows";
import { type FixtureFacts, type FixtureSection, paneFactsOf } from "./mock-facts";
import {
  type PaneContext,
  type PaneFacts,
  type PaneFlow,
  type PaneModel,
  type PaneOptions,
  type PaneRow,
  paneModel,
} from "./model";

/** A fixture state of states.json, as the prototype lists it. */
export interface PrototypeFixture {
  readonly id: string;
  readonly description: string;
  readonly facts: FixtureFacts;
}

export interface PrototypeScenario {
  readonly id: string;
  readonly label: string;
  /** "layout": UX §3; "flow": a clickable flow's start; "fixture": a frozen state. */
  readonly group: "layout" | "flow" | "fixture";
}

/** A prototype-only control: it moves the mock, it is not a pane action. */
export interface PrototypeControl {
  readonly id:
    | "finish-step"
    | "result-unknown"
    | "cancel"
    | "later"
    | "copy-link"
    | "switch-note"
    | "server-accepts";
  readonly label: string;
}

/** A fixed verification time, so the prototype's texts do not change between runs. */
const VERIFIED = Date.UTC(2026, 9, 13, 9, 0);

interface Mock {
  readonly context: PaneContext;
  readonly registry: PaneFacts["registry"];
  readonly section: FixtureSection | null;
  readonly preview?: FixtureFacts["preview"];
  readonly notice: string | null;
  /** The note the flows' "switch note" moves away from and back to. */
  readonly home: string | null;
}

const healthy = (title: string, placements: number): FixtureSection => ({
  key: `S-${title.toLowerCase()}`,
  sharedTitle: title,
  localAlias: title,
  state: "CURRENT",
  heldCheck: "checked",
  placements,
  access: { access: "writer", verifiedAt: VERIFIED, current: true, checking: false },
  accessView: { canInvite: true },
  connection: "connected",
  connectionQualifier: null,
  refusal: null,
  problems: [],
  sync: {
    queue: { batches: 0, counted: true, units: 0 },
    held: { projections: 0, edits: 0, causes: [], persistence: null },
    localPersistence: "confirmed",
    projections: Array.from({ length: placements }, (_, i) => ({
      id: `p${i + 1}`,
      state: "CURRENT" as const,
      held: null,
      checked: true,
      current: true,
    })),
    sharedModel: "accepted",
    current: true,
  },
});

const queued = (s: FixtureSection, batches: number): FixtureSection => ({
  ...s,
  sync: { ...s.sync, queue: { batches, counted: true, units: batches }, current: false },
});

const held = (s: FixtureSection, note: string): FixtureSection => ({
  ...s,
  state: "ATTENTION",
  sync: {
    ...s.sync,
    held: { projections: 1, edits: 3, causes: ["boundary"], persistence: "saved" },
    projections: [
      {
        id: "p1",
        state: "ATTENTION",
        held: {
          path: note,
          projectionId: "p1",
          cause: "boundary",
          count: 3,
          line: 14,
          code: "SECTION_BOUNDARY_MISSING",
          nodeIds: ["n1", "n2", "n3"],
          persistence: "saved",
        },
        checked: true,
        current: false,
      },
    ],
    current: false,
  },
});

const row = (s: FixtureSection, notes: readonly string[]): PaneRow => ({
  key: s.key,
  sharedTitle: s.sharedTitle,
  localAlias: s.localAlias,
  notes,
  placed: notes.length > 0 ? "placed" : "unplaced",
  state: notes.length > 0 ? s.state : null,
});

const registry = (rows: readonly PaneRow[]): PaneFacts["registry"] => ({
  status: "ready",
  placementIndex: "complete",
  sections: rows.length,
  unplaced: rows.filter((r) => r.placed === "unplaced").length,
  rows,
});

const context = (
  note: string | null,
  cursor: PaneContext["cursor"],
  flow: PaneFlow | null = null,
): PaneContext => ({
  editor: note === null ? "none" : "live-preview",
  note,
  cursor: note === null ? "none" : cursor,
  selection: null,
  flow,
});

const LAUNCH = healthy("Launch", 2);
const SPRINT: FixtureSection = {
  ...healthy("Sprint", 0),
  localAlias: "Sprint",
  accessView: { canInvite: false },
};

/** The four layouts of UX §3, which are also where the flows start. */
const LAYOUTS: Readonly<Record<string, Mock>> = {
  "first-use": {
    context: context("Plan.md", "private-heading"),
    registry: registry([]),
    section: null,
    notice: null,
    home: "Plan.md",
  },
  "just-joined": {
    context: context("Notes.md", "private-text"),
    registry: registry([row(SPRINT, [])]),
    section: SPRINT,
    notice: null,
    home: "Notes.md",
  },
  healthy: {
    context: context("Plan.md", "inside-section"),
    registry: registry([row(LAUNCH, ["Plan.md", "Weekly.md"])]),
    section: LAUNCH,
    notice: null,
    home: "Plan.md",
  },
  "held-edits": {
    context: context("Plan.md", "inside-section"),
    registry: registry([row(held(LAUNCH, "Plan.md"), ["Plan.md", "Weekly.md"])]),
    section: held(LAUNCH, "Plan.md"),
    notice: null,
    home: "Plan.md",
  },
  "no-note": {
    context: context(null, "none"),
    registry: registry([row(LAUNCH, ["Plan.md", "Weekly.md"])]),
    section: null,
    notice: null,
    home: null,
  },
};

const SCENARIOS: readonly PrototypeScenario[] = [
  { id: "first-use", label: "First use (start of share → invite)", group: "layout" },
  { id: "just-joined", label: "Just joined (Sprint, not inserted yet)", group: "layout" },
  { id: "healthy", label: "Healthy section", group: "layout" },
  { id: "held-edits", label: "Held edits (start of the problem flow)", group: "layout" },
  { id: "no-note", label: "No note open (start of join → insert)", group: "flow" },
];

const SHARE_PREVIEW: FixtureFacts["preview"] = {
  counts: { tasks: 3, paragraphs: 1, items: 0, raw: 1 },
  warnings: ["future-additions", "local-comments"],
  problems: [],
};

const INVITATION = /^lfcp:\/\/join\/\S+$/;

export class PanePrototype {
  readonly #fixtures: ReadonlyMap<string, PrototypeFixture>;
  #scenario: string;
  #mock: Mock;
  /** The mock before the current flow started, for "Cancel". */
  #before: Mock | null = null;

  constructor(fixtures: readonly PrototypeFixture[], first = "first-use") {
    this.#fixtures = new Map(fixtures.map((f) => [f.id, f]));
    this.#scenario = first;
    this.#mock = this.#start(first);
  }

  scenarios(): PrototypeScenario[] {
    return [
      ...SCENARIOS,
      ...[...this.#fixtures.values()].map(
        (f): PrototypeScenario => ({
          id: `fixture:${f.id}`,
          label: `${f.id}: ${f.description}`,
          group: "fixture",
        }),
      ),
    ];
  }

  get scenario(): string {
    return this.#scenario;
  }

  select(id: string): void {
    this.#scenario = id;
    this.#before = null;
    this.#mock = this.#start(id);
  }

  facts(): PaneFacts {
    const m = this.#mock;
    return {
      ...paneFactsOf({
        context: m.context,
        registry: m.registry,
        section: m.section,
        ...(m.preview === undefined ? {} : { preview: m.preview }),
      }),
      notice: m.notice,
    };
  }

  model(o: PaneOptions = {}): PaneModel {
    return paneModel(this.facts(), o);
  }

  /** The prototype's own controls for the current mock state. */
  controls(): PrototypeControl[] {
    const flow = this.#mock.context.flow;
    const out: PrototypeControl[] = [];
    if (flow !== null && flow.outcome === "running") {
      const stage = stageOf(flow.kind, flow.stage);
      if (stage.waits === "effect") {
        out.push({ id: "finish-step", label: `Mock: finish “${stage.label}”` });
        out.push({ id: "result-unknown", label: "Mock: lose the answer (result unknown)" });
      }
      if (flow.kind === "invite" && flow.stage === "link")
        out.push({ id: "copy-link", label: "Mock: Copy link" });
      out.push(
        this.#effectStarted(flow)
          ? { id: "later", label: "Continue later" }
          : { id: "cancel", label: "Cancel" },
      );
    }
    if (this.#mock.home !== null)
      out.push({ id: "switch-note", label: "Mock: switch the active note" });
    if ((this.#mock.section?.sync.queue.batches ?? 0) > 0)
      out.push({ id: "server-accepts", label: "Mock: the server accepts the queued updates" });
    return out;
  }

  /** A pane action clicked: the next mock state, or a note of what would run. */
  act(id: ActionId): void {
    const m = this.#mock;
    const flow = m.context.flow;
    // A running flow's user step: the click stands for the user's answer in its preview or dialog.
    if (
      flow?.outcome === "running" &&
      stageOf(flow.kind, flow.stage).waits === "user" &&
      id === flowAction(flow.kind, flow.stage)
    ) {
      if (flow.kind === "join" && flow.stage === "link") {
        this.#set({ ...m, notice: "Paste the invitation link in the field above." });
        return;
      }
      if (flow.kind === "join" && flow.stage === "choose-place") {
        this.#startInsert();
        return;
      }
      if (flow.kind === "invite" && flow.stage === "link") {
        this.#set({
          ...m,
          notice: "The invitation dialog is open: Show link or Copy link there.",
        });
        return;
      }
      const stages = FLOW_STAGES[flow.kind];
      const after = stages[stages.findIndex((s) => s.id === flow.stage) + 1];
      if (after === undefined) {
        this.#end({});
        return;
      }
      this.#set({
        ...m,
        notice: null,
        context: { ...m.context, flow: { ...flow, stage: after.id } },
      });
      return;
    }
    switch (id) {
      case "share-section":
      case "share-whole-section": {
        this.#begin("share", "preview", m.context.note ?? undefined, {
          preview: SHARE_PREVIEW,
        });
        return;
      }
      case "invite": {
        this.#begin("invite", "role");
        return;
      }
      case "join-with-link": {
        this.#begin("join", "link");
        return;
      }
      case "insert-into-note": {
        this.#startInsert();
        return;
      }
      case "repair-sections": {
        this.#begin("repair", "compare", m.context.note ?? undefined);
        return;
      }
      case "check-result":
        // Resumes the same operation at the same stage: never a new one.
        if (flow !== null) {
          this.#set({
            ...m,
            context: { ...m.context, flow: { ...flow, outcome: "running" } },
            notice: "Checking the result of the same operation…",
          });
          return;
        }
        return;
      case "continue-flow":
        if (flow !== null) {
          this.#set({
            ...m,
            context: { ...m.context, flow: { ...flow, outcome: "running" } },
            notice: null,
          });
          return;
        }
        return;
      default: {
        this.#set({
          ...m,
          notice: `Prototype: “${ACTIONS[id].label}” would open the existing ${ACTIONS[id].destructive ? "confirmation" : "dialog or card"}. Nothing runs here.`,
        });
        return;
      }
    }
  }

  /** The join field: a pasted link (I5: typed or pasted by the user, never read from the clipboard). */
  join(link: string): void {
    const m = this.#mock;
    if (!INVITATION.test(link.trim())) {
      this.#set({
        ...m,
        notice: "This is not an invitation link. Paste the whole lfcp://join/… link.",
      });
      return;
    }
    const flow = m.context.flow;
    if (flow?.kind === "join")
      this.#set({
        ...m,
        notice: null,
        context: { ...m.context, flow: { ...flow, stage: "claiming capability" } },
      });
  }

  control(id: PrototypeControl["id"]): void {
    const m = this.#mock;
    const flow = m.context.flow;
    switch (id) {
      case "finish-step": {
        if (flow === null) return;
        const stages = FLOW_STAGES[flow.kind];
        const after = stages[stages.findIndex((s) => s.id === flow.stage) + 1];
        if (flow.kind === "join" && after?.id === "choose-place") {
          // Loaded: the section is in the list now, not inserted anywhere yet.
          const rows = [
            ...(m.registry.rows ?? []).filter((r) => r.key !== SPRINT.key),
            row(SPRINT, []),
          ];
          this.#set({
            ...m,
            section: SPRINT,
            registry: registry(rows),
            notice: "Joined. Choose a note to insert the section into, now or later.",
            context: { ...m.context, flow: { ...flow, stage: after.id } },
          });
          return;
        }
        if (after !== undefined) {
          this.#set({ ...m, context: { ...m.context, flow: { ...flow, stage: after.id } } });
          return;
        }
        if (flow.kind === "share") {
          this.#finishShare();
          return;
        }
        if (flow.kind === "insert") {
          this.#finishInsert();
          return;
        }
        if (flow.kind === "repair") {
          this.#finishRepair();
          return;
        }
        this.#end({});
        return;
      }
      case "result-unknown":
        if (flow !== null)
          this.#set({ ...m, context: { ...m.context, flow: { ...flow, outcome: "unknown" } } });
        return;
      case "cancel":
        // Before any effect: back to where the flow started.
        if (this.#before !== null)
          this.#set({ ...this.#before, notice: "Cancelled. Nothing was changed." });
        this.#before = null;
        return;
      case "later":
        if (flow?.kind === "join" && flow.stage === "choose-place") {
          // Joined: the section stays in the list, "Not inserted yet"; no flow is left open.
          this.#end({ notice: null });
          return;
        }
        if (flow !== null)
          this.#set({ ...m, context: { ...m.context, flow: { ...flow, outcome: "unfinished" } } });
        return;
      case "copy-link": {
        this.#set({ ...m, notice: "Link copied" });
        return;
      }
      case "switch-note": {
        const home = m.home;
        const other = m.context.note === home ? "Other.md" : home;
        this.#set({
          ...m,
          context: { ...m.context, note: other, editor: "live-preview", cursor: "private-text" },
          section: m.context.note === home && flow === null ? null : m.section,
        });
        return;
      }
      case "server-accepts": {
        const s = m.section;
        if (s === null) return;
        const done: FixtureSection = {
          ...s,
          sync: { ...s.sync, queue: { batches: 0, counted: true, units: 0 } },
        };
        this.#set({ ...m, section: done, notice: null });
        return;
      }
    }
  }

  #start(id: string): Mock {
    const layout = LAYOUTS[id];
    if (layout !== undefined) return layout;
    const f = this.#fixtures.get(id.slice("fixture:".length));
    if (f === undefined) return LAYOUTS["first-use"] as Mock;
    return {
      context: f.facts.context,
      registry: f.facts.registry,
      section: f.facts.section,
      ...(f.facts.preview === undefined ? {} : { preview: f.facts.preview }),
      notice: null,
      home: f.facts.context.note,
    };
  }

  #set(m: Mock): void {
    this.#mock = m;
  }

  #effectStarted(flow: PaneFlow): boolean {
    const stages = FLOW_STAGES[flow.kind];
    const at = stages.findIndex((s) => s.id === flow.stage);
    return stages.slice(0, Math.max(0, at)).some((s) => s.waits === "effect");
  }

  #begin(kind: FlowKind, stage: string, target?: string, change: Partial<Mock> = {}): void {
    const m = this.#mock;
    this.#before = m;
    const flow: PaneFlow = {
      kind,
      stage,
      outcome: "running",
      ...(target === undefined ? {} : { target }),
    };
    this.#set({ ...m, ...change, notice: null, context: { ...m.context, flow } });
  }

  #end(change: Partial<Mock>): void {
    const m = this.#mock;
    const { preview: _drop, ...rest } = m;
    this.#before = null;
    this.#set({ ...rest, notice: null, ...change, context: { ...m.context, flow: null } });
  }

  #finishShare(): void {
    const note = this.#mock.home ?? "Plan.md";
    const section = healthy("Launch", 1);
    this.#end({
      section,
      registry: registry([row(section, [note])]),
      context: context(note, "inside-section"),
      notice: "Shared. The section is on its sync server.",
    });
  }

  #startInsert(): void {
    const m = this.#mock;
    const target = "Sprint notes.md";
    const sprint = m.section ?? SPRINT;
    this.#before = m;
    this.#set({
      ...m,
      section: sprint,
      notice: null,
      context: {
        ...m.context,
        flow: { kind: "insert", stage: "captured", outcome: "running", target },
      },
    });
  }

  #finishInsert(): void {
    const m = this.#mock;
    const note = m.context.flow?.target ?? "Sprint notes.md";
    const sprint: FixtureSection = {
      ...(m.section ?? SPRINT),
      placements: 1,
      sync: {
        ...(m.section ?? SPRINT).sync,
        projections: [{ id: "p1", state: "CURRENT", held: null, checked: true, current: true }],
      },
    };
    this.#end({
      section: sprint,
      registry: registry([row(sprint, [note])]),
      context: context(note, "inside-section"),
      notice: `Inserted into ${note}.`,
    });
  }

  #finishRepair(): void {
    const m = this.#mock;
    // F2: the result after the repair, as it is: the held edits are now queued, not yet accepted.
    const repaired = queued(LAUNCH, 3);
    this.#end({
      section: repaired,
      registry: registry([row(repaired, ["Plan.md", "Weekly.md"])]),
      notice: "Repaired. What happened to the edits is shown below.",
      context: { ...m.context, flow: null },
    });
  }
}
