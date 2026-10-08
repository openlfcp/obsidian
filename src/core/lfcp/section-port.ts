// The section engine's port (core/sections/port.ts) on the real SDK
// (sdk-ts at sdk-ts.lock): the snapshot of a section's replica, commits
// through the sync client with durable receipts, and the receipts' store.
// SDK errors become the port's refusals; nothing is retried here.

import type { Receipt as SdkReceipt } from "@openlfcp/client";
import { OperationIdReusedError, receiptOf, releaseReceipt } from "@openlfcp/client";
import { fromBase64url, type ResourceId, resourceId, toHex } from "@openlfcp/core";
import {
  SectionIntentError,
  type SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  CommitRefused,
  type Receipt,
  type SectionIntent,
  type SectionPort,
  type SectionSnapshot,
  type WriteAccess,
} from "../sections/port";
import { fromSdkSnapshot } from "../sections/sdk-snapshot";

/** What the port needs from the runtime: open section Resources and their session. */
export interface SectionResources {
  /** The open Resource's sections profile, or undefined (not open, or another profile). */
  profile(resource: ResourceId): SharedSectionsDataProfile | undefined;
  /** SyncClient.commit on the Resource's session. */
  commit(
    resource: ResourceId,
    intents: readonly unknown[],
    options: { readonly operationId: string },
  ): Promise<SdkReceipt>;
  readonly storage: Pick<LfcpStorage, "localMarks" | "commit">;
  /** Write access from the validated Control state (contract §6). */
  canWrite(resource: ResourceId): WriteAccess;
}

const asResource = (b64: string): ResourceId => resourceId(fromBase64url(b64));

/** The SDK's receipt in the port's terms (unit IDs as hex). */
export const portReceipt = (r: SdkReceipt): Receipt => ({
  operationId: r.operationId,
  unitIds: r.unitIds.map((u) => toHex(u)),
  affectedNodeIds: [...r.affectedNodeIds],
  modelRevision: r.modelRevision,
  intentsHash: r.intentsHash,
  durable: true,
});

export class SdkSectionPort implements SectionPort {
  constructor(private readonly resources: SectionResources) {}

  snapshot(resource: string, sectionId: string): SectionSnapshot | undefined {
    const profile = this.resources.profile(asResource(resource));
    return profile === undefined
      ? undefined
      : fromSdkSnapshot(profile.replica.snapshot(), sectionId);
  }

  async commit(
    resource: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<Receipt> {
    try {
      return portReceipt(await this.resources.commit(asResource(resource), intents, options));
    } catch (e) {
      if (e instanceof SectionIntentError) throw new CommitRefused(e.code, e.nodeId, e.intentIndex);
      if (e instanceof OperationIdReusedError) throw new CommitRefused("OPERATION_ID_REUSED");
      throw e;
    }
  }

  async receiptOf(resource: string, operationId: string): Promise<Receipt | undefined> {
    const r = await receiptOf(this.resources.storage, asResource(resource), operationId);
    return r === undefined ? undefined : portReceipt(r);
  }

  releaseReceipt(resource: string, operationId: string): Promise<void> {
    return releaseReceipt(this.resources.storage, asResource(resource), operationId);
  }

  canWrite(resource: string): WriteAccess {
    return this.resources.canWrite(asResource(resource));
  }
}
