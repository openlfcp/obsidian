// A fake of the SDK's section port with the contract's semantics
// (SDK-SECTIONS-INTEGRATION-01 §3): durable receipts that survive a
// "restart" (the same instance), idempotent commits per operation ID,
// OPERATION_ID_REUSED for a different batch, and injected faults. Mock
// evidence only: the real SDK binding replaces it (LFCP-02-012..016).

import {
  CommitRefused,
  type Receipt,
  type SectionIntent,
  type SectionPort,
  type SectionSnapshot,
  type WriteAccess,
} from "../../../src/core/sections/port";

export type Fault =
  /** The process stops before the commit's transaction: nothing written. */
  | { readonly kind: "crash-before" }
  /** The process stops after the durable commit, before the call returns. */
  | { readonly kind: "crash-after" }
  /** Storage fails: nothing written, an ordinary error. */
  | { readonly kind: "storage-error" }
  | { readonly kind: "refuse"; readonly code: string };

export class FakeSectionPort implements SectionPort {
  /** Every change the model received, as committed batches. */
  readonly changes: { operationId: string; intents: readonly SectionIntent[] }[] = [];
  readonly released: string[] = [];
  readonly #receipts = new Map<string, { receipt: Receipt; key: string }>();
  readonly #faults: Fault[] = [];
  access: WriteAccess = { allowed: true };
  snapshots = new Map<string, SectionSnapshot>();

  /** The next commits meet these faults, in order. */
  fail(...faults: Fault[]): void {
    this.#faults.push(...faults);
  }

  snapshot(_resource: string, sectionId: string): SectionSnapshot | undefined {
    return this.snapshots.get(sectionId);
  }

  async commit(
    resource: string,
    intents: readonly SectionIntent[],
    { operationId }: { operationId: string },
  ): Promise<Receipt> {
    const key = JSON.stringify(intents);
    const found = this.#receipts.get(`${resource}#${operationId}`);
    if (found !== undefined) {
      if (found.key !== key) throw new CommitRefused("OPERATION_ID_REUSED");
      return found.receipt;
    }
    const fault = this.#faults.shift();
    if (fault?.kind === "crash-before") throw new Error("crash before commit");
    if (fault?.kind === "storage-error") throw new Error("disk full");
    if (fault?.kind === "refuse") throw new CommitRefused(fault.code);
    if (!this.access.allowed) throw new CommitRefused("NOT_WRITABLE");
    this.changes.push({ operationId, intents });
    const receipt: Receipt = {
      operationId,
      unitIds: [`unit-${this.changes.length}`],
      affectedNodeIds: intents.flatMap((i) =>
        "id" in i ? [i.id] : i.intent === "task.create_in_section" ? [i.task.id] : [],
      ),
      modelRevision: `heads-${this.changes.length}`,
      intentsHash: key.length.toString(16),
      durable: true,
    };
    this.#receipts.set(`${resource}#${operationId}`, { receipt, key });
    if (fault?.kind === "crash-after") throw new Error("crash after commit");
    return receipt;
  }

  async receiptOf(resource: string, operationId: string): Promise<Receipt | undefined> {
    return this.#receipts.get(`${resource}#${operationId}`)?.receipt;
  }

  async releaseReceipt(resource: string, operationId: string): Promise<void> {
    this.#receipts.delete(`${resource}#${operationId}`);
    this.released.push(operationId);
  }

  canWrite(_resource: string): WriteAccess {
    return this.access;
  }
}
