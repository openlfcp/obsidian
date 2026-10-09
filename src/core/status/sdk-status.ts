// The SDK's status stream of a section Resource (LFCP-02-026,
// SDK-SECTIONS-INTEGRATION-01 §4–§5) in the reducer's terms. Pure.
//
// The SDK is the source of truth for local batches, server acceptance,
// access and the section's readiness: a snapshot replaces everything, an
// event with the next revision updates it, an event with a skipped revision
// asks for a new snapshot (and shows unknown meanwhile), an older one is
// ignored. A batch event replaces that batch: when the server loses units it
// had accepted, the SDK reports the batch with fewer accepted units and it
// is pending again (ADR 0008); `reoffered` takes those units off as well.

import type { BatchStatus, StatusEvent, StatusSnapshot } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { portAccess } from "../lfcp/section-port";
import type { WriteAccess } from "../sections/port";
import type { BatchFacts } from "./reducer";

export interface SdkStatus {
  readonly revision: number;
  readonly batches: readonly BatchFacts[];
  /** Batches whose ACK came without acceptance evidence (§4.1). */
  readonly unconfirmed: ReadonlySet<string>;
  readonly access: WriteAccess | null;
  readonly section: "ready" | "importing" | "unknown";
  /** A revision was skipped: ask statusSnapshot. */
  readonly needsSnapshot: boolean;
}

/** One SDK batch status as the reducer's batch: hex unit IDs; nodes from the receipt. */
export function batchFacts(b: BatchStatus): BatchFacts {
  return {
    id: b.operationId,
    nodeIds: b.affectedNodeIds,
    durable: true,
    unitIds: b.unitIds.map((u) => toHex(u)),
    acceptedUnitIds: b.acceptedUnitIds.map((u) => toHex(u)),
    ...(b.rejection === undefined
      ? {}
      : {
          rejection: {
            code: b.rejection.code,
            unitIds: b.rejection.unitIds.map((u) => toHex(u)),
          },
        }),
  };
}

const unconfirmedOf = (batches: readonly BatchStatus[]) =>
  new Set(batches.filter((b) => b.status === "evidence-unavailable").map((b) => b.operationId));

export function fromSnapshot(s: StatusSnapshot): SdkStatus {
  return {
    revision: s.revision,
    batches: s.batches.map(batchFacts),
    unconfirmed: unconfirmedOf(s.batches),
    access: portAccess(s.access),
    section: s.section,
    needsSnapshot: false,
  };
}

/** The state after one event of the Resource's stream. */
export function applySdkEvent(st: SdkStatus, e: StatusEvent): SdkStatus {
  if (e.revision <= st.revision) return st;
  if (e.revision !== st.revision + 1) return { ...st, revision: e.revision, needsSnapshot: true };
  const next = { ...st, revision: e.revision };
  switch (e.kind) {
    case "batch": {
      const b = batchFacts(e);
      const known = st.batches.some((x) => x.id === b.id);
      const unconfirmed = new Set(st.unconfirmed);
      if (e.status === "evidence-unavailable") unconfirmed.add(b.id);
      else unconfirmed.delete(b.id);
      return {
        ...next,
        batches: known ? st.batches.map((x) => (x.id === b.id ? b : x)) : [...st.batches, b],
        unconfirmed,
      };
    }
    case "reoffered": {
      const lost = new Set(e.unitIds.map((u) => toHex(u)));
      return {
        ...next,
        batches: st.batches.map((b) =>
          b.acceptedUnitIds.some((u) => lost.has(u))
            ? { ...b, acceptedUnitIds: b.acceptedUnitIds.filter((u) => !lost.has(u)) }
            : b,
        ),
      };
    }
    case "access":
      return { ...next, access: portAccess(e.access) };
    case "section-state":
      return { ...next, section: e.state };
    default:
      // received (others' units) and rehost: no fact of ours changes.
      return next;
  }
}
