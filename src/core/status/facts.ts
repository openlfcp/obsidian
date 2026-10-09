// Status facts of a section (LFCP-02-058, LFCP-02-026): the SDK's status
// stream for its batches, their server acceptance, write access and the
// section's readiness (sdk-status.ts), with what the plugin observes itself
// for the rest: the session phase, the load, the model's problems and the
// note's projections. Pure.
//
// - Acceptance only from the SDK's evidence (a correlated durable ACK); a
//   batch acknowledged without it is "evidence unavailable", never accepted.
// - Catch-up: a session that reached LIVE in this run is current as last
//   checked; offline after that keeps that checkpoint (SI09).

import type { SectionProblem, WriteAccess } from "../sections/port";
import type { ModelProblemFacts, ProjectionFacts, StatusFacts } from "./reducer";
import type { SdkStatus } from "./sdk-status";

export interface ObservedSection {
  readonly session: string;
  /** The section Resource opened: none of its received changes held. */
  readonly load: { readonly ready: boolean; readonly loaded: boolean } | undefined;
  /** The session phase ("LIVE", "OPENING", "CLOSED", …). */
  readonly phase: string;
  /** The session was LIVE at some point in this run. */
  readonly wasLive: boolean;
  readonly problems: readonly SectionProblem[];
  readonly projections: readonly ProjectionFacts[];
  /** The SDK's status of the Resource; undefined before its first snapshot. */
  readonly sdk: SdkStatus | undefined;
  /** A local commit failed and was not retried yet (LOCAL_SAVE_FAILED). */
  readonly failedOperations?: readonly string[];
}

const SCALAR = /SCALAR|TITLE_CONFLICT|FIELD_CONFLICT/;

export function observedFacts(o: ObservedSection): StatusFacts {
  const sdk = o.sdk;
  const batches = [...(sdk?.batches ?? [])];
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
  const unconfirmed = batches.some(
    (b) =>
      sdk?.unconfirmed.has(b.id) === true && !b.unitIds.every((u) => b.acceptedUnitIds.includes(u)),
  );
  return {
    session: o.session,
    revision: sdk?.revision ?? 0,
    replica:
      o.load === undefined || sdk === undefined
        ? "not-loaded"
        : sdk.section === "importing" || !o.load.ready
          ? "importing"
          : "loaded",
    access:
      o.phase === "KEY_BLOCKED"
        ? "unavailable-key"
        : sdk?.access === null || sdk?.access === undefined
          ? "unknown"
          : accessFact(sdk.access),
    pendingControl: sdk?.pendingControl ?? [],
    accessChecking: sdk?.accessCurrent === false,
    connection: live || syncing ? "connected" : "offline",
    // The SDK's catch-up fact (028); a skipped revision or a held change keeps receiving.
    catchUp:
      sdk?.needsSnapshot === true || (o.load !== undefined && !o.load.loaded)
        ? "receiving"
        : (sdk?.catchUp ??
          (syncing ? "receiving" : live || o.wasLive ? "current-at-checkpoint" : "not-started")),
    problems,
    batches,
    acceptanceEvidence: unconfirmed ? "unavailable" : "available",
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
