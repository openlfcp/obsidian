// A stored Resource of another Data Profile than Shared Objects, as a
// newer plugin (shared sections) would leave it in the same install
// database: its Genesis and its registry row, nothing else.

import { saveControlChain } from "@openlfcp/client";
import { dataEpoch, generateResourceId, type ResourceId } from "@openlfcp/core";
import {
  dekCommitment,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
} from "@openlfcp/crypto";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  principalDescriptorFromKeys,
  type Signer,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { expect } from "vitest";
import type { LfcpRuntime } from "../../src/core/lfcp/runtime";

export const SECTIONS = "org.openlfcp.shared-sections.v1";
const URL = "wss://offline.example.invalid/v1/ws";

/** Someone's Resource of `profile`, stored as a newer plugin would store it. */
export async function storeForeign(
  runtime: LfcpRuntime,
  profile = SECTIONS,
  name = "Launch",
  R: ResourceId = generateResourceId(),
): Promise<ResourceId> {
  const storage = runtime.storage as LfcpStorage;
  const key = generateSigningKeyPair();
  const owner: Signer = {
    key,
    descriptor: principalDescriptorFromKeys(key, generateAgreementKeyPair()),
  };
  const genesis = signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: profile,
      owner: owner.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), generateResourceDEK()),
      endpoints: [{ url: URL, priority: 0n }],
      coordinatorUrl: URL,
    },
    owner,
  );
  const chain = validateControlChain([genesis.bytes]);
  if (chain.kind !== "linear") throw new Error(chain.kind);
  expect((await saveControlChain(storage, chain, null)).ok).toBe(true);
  await storage.commit([
    {
      op: "put-resource",
      row: {
        resourceId: R,
        dataProfile: profile,
        localPrincipal: null,
        labels: { name },
      },
    },
  ]);
  return R;
}
