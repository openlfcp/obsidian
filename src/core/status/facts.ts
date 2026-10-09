// Status facts of a section from what the plugin can observe today
// (LFCP-02-058), until the SDK reports them (026, 027): provisional and
// claiming nothing it cannot show. Pure.
//
// - Acceptance: the SDK removes a unit from its outbound queue on the
//   server's ACK, but the indicator spec (§4) does not take queue deletion
//   as acceptance evidence, so no batch is ever "accepted" here and the
//   evidence is "unavailable". A batch counts as pending while one of its
//   units is still queued; after that it is no longer listed: nothing local
//   waits, and no second check is drawn for it.
// - Catch-up: a session that reached LIVE in this run is current as last
//   checked; offline after that keeps that checkpoint (SI09).

import type { SectionProblem, WriteAccess } from "../sections/port";
import type { BatchFacts, ModelProblemFacts, ProjectionFacts, StatusFacts } from "./reducer";

export interface ObservedSection {
  readonly session: string;
  readonly revision: number;
  /** The section Resource opened: ready (§12.1) and none of its changes held. */
  readonly load: { readonly ready: boolean; readonly loaded: boolean } | undefined;
  /** The session phase ("LIVE", "CONNECTING", "CLOSED", …). */
  readonly phase: string;
  /** The session was LIVE at some point in this run. */
  readonly wasLive: boolean;
  /** Write access from the validated Control state (contract §6). */
  readonly access: WriteAccess;
  readonly problems: readonly SectionProblem[];
  /** Local operations with their units and nodes (journal receipts). */
  readonly operations: readonly {
    readonly id: string;
    readonly unitIds: readonly string[];
    readonly nodeIds: readonly string[];
  }[];
  /** Data Units still in the outbound queue (hex); those of no operation are pending, uncounted. */
  readonly queued: ReadonlySet<string>;
  readonly projections: readonly ProjectionFacts[];
  /** A local commit failed and was not retried yet (LOCAL_SAVE_FAILED). */
  readonly failedOperations?: readonly string[];
}

const SCALAR = /SCALAR|TITLE_CONFLICT|FIELD_CONFLICT/;

export function observedFacts(o: ObservedSection): StatusFacts {
  const batches: BatchFacts[] = o.operations
    .filter((op) => op.unitIds.some((u) => o.queued.has(u)))
    .map((op) => ({
      id: op.id,
      nodeIds: op.nodeIds,
      durable: true,
      unitIds: op.unitIds,
      acceptedUnitIds: [],
    }));
  const known = new Set(o.operations.flatMap((op) => op.unitIds));
  const loose = [...o.queued].filter((u) => !known.has(u));
  if (loose.length > 0)
    batches.push({
      id: "unattributed",
      nodeIds: [],
      durable: true,
      unitIds: loose,
      acceptedUnitIds: [],
      stable: false,
    });
  for (const id of o.failedOperations ?? [])
    batches.push({
      id,
      nodeIds: [],
      durable: false,
      failed: true,
      unitIds: [],
      acceptedUnitIds: [],
    });
  const problems: ModelProblemFacts[] = o.problems.map((p) => ({
    kind: SCALAR.test(p.code) ? "scalar" : "structural",
    code: p.code,
    nodeIds: p.nodeIds,
  }));
  const live = o.phase === "LIVE";
  // OPENING, CONTROL_SYNC, KEY_SYNC, DATA_SYNC: the session is up and catching up.
  const syncing = ["OPENING", "CONTROL_SYNC", "KEY_SYNC", "DATA_SYNC"].includes(o.phase);
  return {
    session: o.session,
    revision: o.revision,
    replica: o.load === undefined ? "not-loaded" : o.load.ready ? "loaded" : "importing",
    // A forked Control Chain leaves access unknown until it is resolved (027 reports more).
    access:
      o.phase === "KEY_BLOCKED"
        ? "unavailable-key"
        : o.phase === "CONTROL_CONFLICT"
          ? "unknown"
          : accessFact(o.access),
    pendingControl: [],
    connection: live || syncing ? "connected" : "offline",
    catchUp:
      syncing || (o.load !== undefined && !o.load.loaded)
        ? "receiving"
        : live || o.wasLive
          ? "current-at-checkpoint"
          : "not-started",
    problems,
    batches,
    acceptanceEvidence: "unavailable",
    projections: o.projections,
  };
}

/** §6's answer as a status fact: who may write, read, or nothing (attention). */
function accessFact(a: WriteAccess): StatusFacts["access"] {
  if (a.allowed) return "writer";
  switch (a.reason) {
    case "read-only":
      return "reader";
    case "key-unavailable":
      return "unavailable-key";
    case "revoked":
    case "not-member":
      return "revoked";
    default:
      return "unknown";
  }
}
