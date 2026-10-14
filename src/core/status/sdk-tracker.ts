// The SDK's status of each watched section Resource (§5), as the sections
// host keeps it: a status snapshot, then the SDK's events in revision
// order, and a check in storage of each batch not final yet. A receipt
// release runs outside the SDK's queue, so an ACK landing meanwhile can be
// reported from a status read across it, as "pending" for a batch that is
// accepted and gone, and nothing reports that batch again (soak finding #1
// on 0.4.0-beta.17). A batch the SDK no longer holds is final: it is
// dropped, whatever its last report said.

import { batchStatus } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { toHex } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { applySdkEvent, forgetBatch, fromSnapshot, type SdkStatus } from "./sdk-status";

type StatusEvent = Parameters<typeof applySdkEvent>[1];

export interface SdkStatusSource {
  /** The SDK's status snapshot of a Resource (statusSnapshot); undefined when it cannot be read. */
  snapshot(resource: ResourceId): Promise<Parameters<typeof fromSnapshot>[0] | undefined>;
  /** Whether the SDK no longer holds the batch (batchStatus is undefined: released when final). */
  gone(resource: ResourceId, operationId: string): Promise<boolean>;
  /** Whether the Resource is watched (a status is kept for it). */
  watched(resource: ResourceId): boolean;
  /** The kept status changed. */
  changed(): void;
}

/** The source as the runtime gives it: its status snapshots, and its storage for the batch check. */
export function runtimeStatusSource(o: {
  readonly runtime: () => {
    sectionStatusSnapshot(R: ResourceId): Promise<Parameters<typeof fromSnapshot>[0]>;
    readonly storage: Pick<LfcpStorage, "localMarks"> | null | undefined;
  } | null;
  readonly watched: (R: ResourceId) => boolean;
  readonly changed: () => void;
}): SdkStatusSource {
  return {
    snapshot: async (R) => o.runtime()?.sectionStatusSnapshot(R),
    gone: async (R, operationId) => {
      const storage = o.runtime()?.storage;
      if (storage === undefined || storage === null) return false;
      return (await batchStatus(storage, R, operationId, null)) === undefined;
    },
    watched: o.watched,
    changed: o.changed,
  };
}

export class SdkStatusTracker {
  readonly #sdk = new Map<string, SdkStatus>();

  constructor(private readonly source: SdkStatusSource) {}

  /** The kept status of a Resource (hex key). */
  get(key: string): SdkStatus | undefined {
    return this.#sdk.get(key);
  }

  /** Takes the SDK's status snapshot of `R` as its status. */
  async snapshot(R: ResourceId): Promise<void> {
    const snapshot = await this.source.snapshot(R).catch(() => undefined);
    if (snapshot !== undefined) this.#sdk.set(toHex(R), fromSnapshot(snapshot));
    this.source.changed();
  }

  /** One SDK status event of `R`. */
  event(R: ResourceId, event: StatusEvent): void {
    const key = toHex(R);
    const known = this.#sdk.get(key);
    if (known === undefined) {
      if (this.source.watched(R)) void this.snapshot(R);
      return;
    }
    const next = applySdkEvent(known, event);
    this.#sdk.set(key, next);
    if (next.needsSnapshot) void this.snapshot(R);
    // Not final yet, or read across a release that forgot it: checked in storage.
    if (event.kind === "batch" && event.status !== "accepted" && event.status !== "rejected")
      void this.confirm(R, event.operationId);
  }

  /** After a receipt release, and after a non-final report: a batch the SDK holds no more is not pending. */
  async confirm(R: ResourceId, operationId: string): Promise<void> {
    if (!(await this.source.gone(R, operationId).catch(() => false))) return;
    const key = toHex(R);
    const known = this.#sdk.get(key);
    if (known === undefined) return;
    const next = forgetBatch(known, operationId);
    if (next === known) return;
    this.#sdk.set(key, next);
    this.source.changed();
  }
}
