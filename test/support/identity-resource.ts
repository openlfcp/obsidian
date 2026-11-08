// Resource X of LFCP-IDENTITY-TEST-VECTORS-01 stored in a runtime's
// database, as a device that synced it would have it: its validated chain
// with devices of two people and its registry row. Test-only.

import { saveControlChain } from "@openlfcp/client";
import { fromHex, type ResourceId } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { validateControlChain } from "@openlfcp/wire";
import { expect } from "vitest";
import type { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { X } from "../core/identity/x-chain";

/** Stores X's first `records` records (all by default); returns X's Resource ID. */
export async function storeX(
  runtime: LfcpRuntime,
  records = X.records.length,
): Promise<ResourceId> {
  const storage = runtime.storage as LfcpStorage;
  const chain = validateControlChain(X.records.slice(0, records).map((r) => fromHex(r.cose_sign1)));
  if (chain.kind !== "linear") throw new Error(chain.kind);
  expect((await saveControlChain(storage, chain, null)).ok).toBe(true);
  const R = chain.state.resourceId;
  await storage.commit([
    {
      op: "put-resource",
      row: {
        resourceId: R,
        dataProfile: chain.state.dataProfile,
        localPrincipal: null,
        labels: {},
      },
    },
  ]);
  return R;
}
