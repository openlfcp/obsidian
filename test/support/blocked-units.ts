// Stored units of a collaborator that cannot be applied, written straight
// into storage (the statuses the applier would record), for the
// blocked-collaborator tests. Never protocol-valid bytes: only the
// status listing reads them.

import {
  actorSequence,
  controlRecordId,
  dataEpoch,
  dataUnitId,
  type PrincipalId,
  principalId,
  type ResourceId,
} from "@openlfcp/core";
import type { DataUnitStatus, LfcpStorage } from "@openlfcp/storage";

export const collaborator = (n: number): PrincipalId => principalId(new Uint8Array(32).fill(n));

export async function storeBlocked(
  storage: LfcpStorage,
  R: ResourceId,
  units: readonly {
    readonly n: number;
    readonly who: number;
    readonly seq: bigint;
    readonly status: DataUnitStatus;
    readonly detail?: string;
  }[],
): Promise<void> {
  const r = await storage.commit(
    units.map((u) => ({
      op: "put-data-unit" as const,
      unit: {
        unitId: dataUnitId(new Uint8Array(32).fill(u.n)),
        resourceId: R,
        dataEpoch: dataEpoch(0n),
        actor: collaborator(u.who),
        actorSeq: actorSequence(u.seq),
        prevDataUnitId: null,
        controlHead: controlRecordId(new Uint8Array(32).fill(9)),
        bytes: Uint8Array.of(u.n),
      },
      status: u.status,
      ...(u.detail === undefined ? {} : { detail: u.detail }),
    })),
  );
  if (!r.ok) throw new Error(r.reason);
}
