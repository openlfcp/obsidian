// A fake of the SDK's section port with the contract's semantics
// (SDK-SECTIONS-INTEGRATION-01 §3): durable receipts that survive a
// "restart" (the same instance), idempotent commits per operation ID,
// OPERATION_ID_REUSED for a different batch, and injected faults. Mock
// evidence only: the real SDK binding replaces it (LFCP-02-012..016).

import type { SectionState } from "../../../src/core/sections/base";
import { applyBatch } from "../../../src/core/sections/commit";
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

/** A section held by the fake: its visible state, deleted nodes and revision. */
export interface FakeSection {
  readonly resource: string;
  readonly sectionId: string;
  state: SectionState;
  deleted: Map<string, NonNullable<SectionState["nodes"][string]>>;
  revision: number;
  ready: boolean;
  problems: SectionSnapshot["problems"];
}

export class FakeSectionPort implements SectionPort {
  /** Sections with a model: commits apply to them, snapshots read them. */
  readonly sections = new Map<string, FakeSection>();
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

  /** Gives `resource` one section with this state (the model of a shared section). */
  host(resource: string, sectionId: string, state: SectionState): FakeSection {
    const section: FakeSection = {
      resource,
      sectionId,
      state,
      deleted: new Map(),
      revision: 1,
      ready: true,
      problems: [],
    };
    this.sections.set(resource, section);
    return section;
  }

  /** A remote change: `change` edits the section's state; the revision moves on. */
  remote(resource: string, change: (s: FakeSection) => void): void {
    const s = this.sections.get(resource);
    if (s === undefined) throw new Error("no section");
    change(s);
    s.revision++;
  }

  snapshot(resource: string, sectionId: string): SectionSnapshot | undefined {
    const fixed = this.snapshots.get(sectionId);
    if (fixed !== undefined) return fixed;
    const s = this.sections.get(resource);
    if (s === undefined || s.sectionId !== sectionId) return undefined;
    const nodes: Record<string, SectionSnapshot["nodes"][string]> = {};
    for (const [id, n] of Object.entries(s.state.nodes))
      nodes[id] = {
        kind: n.kind,
        parent: n.parent,
        lifecycle: "active",
        ...(n.text === undefined ? {} : { text: n.text }),
      };
    for (const [id, n] of s.deleted)
      if (n !== undefined)
        nodes[id] = {
          kind: n.kind,
          parent: n.parent,
          lifecycle: "deleted",
          ...(n.text === undefined ? {} : { text: n.text }),
        };
    return {
      revision: `heads-${s.revision}`,
      title: s.state.title,
      ready: s.ready,
      nodes,
      order: s.state.order,
      problems: s.problems,
    };
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
    const model = this.sections.get(resource);
    if (model !== undefined) {
      for (const i of intents)
        if (i.intent === "node.delete") {
          const n = model.state.nodes[i.id];
          if (n !== undefined) model.deleted.set(i.id, n);
        }
      model.state = applyBatch(model.state, intents, model.sectionId);
      for (const i of intents)
        if (i.intent === "node.restore") {
          const n = model.deleted.get(i.id);
          model.deleted.delete(i.id);
          if (n !== undefined)
            model.state = {
              ...model.state,
              nodes: { ...model.state.nodes, [i.id]: n },
              order: {
                ...model.state.order,
                [n.parent ?? ""]: [...(model.state.order[n.parent ?? ""] ?? []), i.id],
              },
            };
        }
      model.revision++;
    }
    const receipt: Receipt = {
      operationId,
      unitIds: [`unit-${this.changes.length}`],
      affectedNodeIds: intents.flatMap((i) =>
        "id" in i ? [i.id] : i.intent === "task.create_in_section" ? [i.task.id] : [],
      ),
      modelRevision:
        model === undefined ? `heads-${this.changes.length}` : `heads-${model.revision}`,
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
