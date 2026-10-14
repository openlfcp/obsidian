// Mock facts for the pane prototype and its tests (LFCP-03-007): the UX
// state fixtures (test/fixtures/ux-0.3/states.json) turned into the pane's
// input through the real status reducer. A fixture states its section at
// the level of StatusView (sync, access, connection); this module writes
// the StatusFacts that produce it and runs `statusView`, so the pane reads
// a real StatusView with its conditions, never a second status path. A test
// checks that the reducer gives back the fixture's own view.
//
// Nothing here is evidence of sync: these are synthetic facts. Pure.

import type { ShareWarning } from "../sections/share";
import type { HeldCause, HeldEdits, HeldPersistence } from "../status/held";
import type { HeldCheck } from "../status/held-checks";
import {
  type BatchFacts,
  type ConnectionQualifier,
  type ModelProblemFacts,
  type ProjectionFacts,
  type SourceFacts,
  type StatusFacts,
  type StatusState,
  type StatusView,
  statusView,
} from "../status/reducer";
import type { PaneContext, PaneFacts, PaneSection } from "./model";

/** A fixture's held edits, as StatusView.sync shows them. */
export interface FixtureHeld {
  readonly path: string;
  readonly projectionId: string;
  readonly cause: HeldCause;
  readonly count: number | null;
  readonly line: number;
  readonly code?: string;
  readonly nodeIds: readonly string[];
  readonly persistence?: HeldPersistence;
}

/** A fixture's section (states.json `facts.section`). */
export interface FixtureSection {
  readonly key: string;
  readonly sharedTitle: string | null;
  readonly localAlias: string;
  readonly state: StatusState;
  readonly heldCheck: HeldCheck;
  readonly placements: number | null;
  readonly access: StatusView["access"];
  readonly accessView: { readonly canInvite: boolean | null };
  readonly connection: StatusFacts["connection"];
  readonly connectionQualifier: ConnectionQualifier | null;
  readonly refusal: string | null;
  readonly problems: readonly ModelProblemFacts[];
  readonly sync: {
    readonly queue: { readonly batches: number; readonly counted: boolean; readonly units: number };
    readonly held: StatusView["sync"]["held"];
    readonly localPersistence: StatusView["sync"]["localPersistence"];
    readonly projections: readonly {
      readonly id: string;
      readonly state: StatusState;
      readonly held: FixtureHeld | null;
      readonly checked: boolean;
      readonly current: boolean;
    }[];
    readonly sharedModel: StatusView["sync"]["sharedModel"];
    readonly current: boolean;
  };
  /** Prototype only: on its server or not yet (I4). */
  readonly hosting?: PaneSection["hosting"];
}

/** A fixture state's facts (states.json `facts`). */
export interface FixtureFacts {
  readonly context: PaneContext;
  readonly registry: PaneFacts["registry"];
  readonly section: FixtureSection | null;
  readonly preview?: {
    readonly counts: { tasks: number; paragraphs: number; items: number; raw: number };
    readonly warnings: readonly ShareWarning[];
    readonly problems: readonly string[];
  };
}

const SOURCE_OF: Readonly<Partial<Record<HeldCause, SourceFacts>>> = {
  boundary: "binding-error",
  binding: "binding-error",
  "base-unknown": "base-unknown",
  unsupported: "unsupported",
};

function heldEdits(h: FixtureHeld): HeldEdits {
  return {
    path: h.path,
    projectionId: h.projectionId,
    cause: h.cause,
    count: h.count,
    line: h.line,
    nodeIds: h.nodeIds,
    ...(h.code === undefined ? {} : { code: h.code }),
    ...(h.persistence === undefined ? {} : { persistence: h.persistence }),
  };
}

/** The StatusFacts whose view is the fixture's section. */
export function statusFactsOf(s: FixtureSection): StatusFacts {
  const q = s.sync.queue;
  const batches: BatchFacts[] = [];
  for (let i = 0; i < q.batches; i++) {
    // One Data Unit each; the last takes the rest.
    const units = i === q.batches - 1 ? Math.max(1, q.units - (q.batches - 1)) : 1;
    batches.push({
      id: `b${i + 1}`,
      nodeIds: [],
      durable: true,
      unitIds: Array.from({ length: units }, (_, u) => `b${i + 1}.u${u + 1}`),
      acceptedUnitIds: [],
      ...(q.counted ? {} : { stable: false }),
    });
  }
  if (s.sync.localPersistence === "failed")
    batches.push({
      id: "f1",
      nodeIds: [],
      durable: false,
      failed: true,
      unitIds: [],
      acceptedUnitIds: [],
    });
  const heldUnknown = s.sync.held.persistence !== null && s.sync.held.persistence !== "saved";
  if (s.sync.localPersistence === "unconfirmed" && !heldUnknown && s.heldCheck === "checked")
    // A local commit in progress (local-edit).
    batches.push({ id: "e1", nodeIds: [], durable: false, unitIds: [], acceptedUnitIds: [] });
  const projections: ProjectionFacts[] = s.sync.projections.map((p) => ({
    id: p.id,
    source: p.held === null ? "clean" : (SOURCE_OF[p.held.cause] ?? "clean"),
    application: "current",
    ...(p.held === null ? {} : { held: heldEdits(p.held) }),
  }));
  const model = s.sync.sharedModel;
  return {
    session: "mock",
    revision: 0,
    replica: "loaded",
    access: s.access.access,
    accessVerifiedAt: s.access.verifiedAt,
    accessCurrent: s.access.current,
    accessChecking: s.access.checking,
    pendingControl: [],
    connection: s.connection,
    connectionQualifier: s.connectionQualifier,
    ...(s.refusal === null ? {} : { refusal: s.refusal }),
    catchUp:
      model === "accepted"
        ? "current-at-checkpoint"
        : model === "catching-up"
          ? "receiving"
          : s.connection === "connected"
            ? "unknown"
            : "not-started",
    problems: s.problems,
    batches,
    acceptanceEvidence: "available",
    projections,
    ...(s.heldCheck === "checked" ? {} : { heldCheck: s.heldCheck }),
  };
}

/** The pane's section: the fixture's facts through the real reducer. */
export function paneSectionOf(s: FixtureSection): PaneSection {
  return {
    key: s.key,
    sharedTitle: s.sharedTitle,
    localAlias: s.localAlias,
    placements: s.placements,
    view: statusView(statusFactsOf(s)),
    canInvite: s.accessView.canInvite,
    ...(s.hosting === undefined ? {} : { hosting: s.hosting }),
  };
}

/** The pane's facts for a fixture state. */
export function paneFactsOf(f: FixtureFacts): PaneFacts {
  return {
    context: f.context,
    registry: f.registry,
    section: f.section === null ? null : paneSectionOf(f.section),
    ...(f.preview === undefined ? {} : { preview: f.preview }),
  };
}
