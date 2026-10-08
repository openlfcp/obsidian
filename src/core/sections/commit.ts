// Local section edits into durable shared updates, exactly once per
// operation (LFCP-02-039, SDK-SECTIONS-INTEGRATION-01 §3, §7.4–§7.7).
// Pure orchestration over the SDK port and the journal; not wired in.
//
// An operation goes captured → ids-allocated → committed → projected → done
// (journal.ts). New node IDs and the batch are recorded before the commit,
// so every retry, after a crash or an error, submits the same batch under
// the same operation ID: the SDK returns the existing receipt instead of a
// second change, and a Task is never created twice. When the outcome is
// unknown, the receipt is asked for (§3.4); intents are never repeated
// under a new operation ID. An edit that may not be sent (read-only,
// revoked, refused) is kept as a labeled local candidate, never written.

import type { SectionPlan, UnboundNode } from "./base";
import {
  advance,
  type JournalEntry,
  type PendingCandidate,
  recovery,
  type SectionJournalStore,
} from "./journal";
import {
  CommitRefused,
  type NewSectionTask,
  type Receipt,
  type SectionIntent,
  type SectionPort,
} from "./port";

/** One reconciliation pass's decided edits of one projection. */
export interface LocalPass {
  readonly projectionId: string;
  readonly resource: string;
  /** SHA-256 of the section's source when captured. */
  readonly sourceHash: string;
  /** The section's private source, kept as a candidate when the edit cannot be sent. */
  readonly sourceText: string;
  /** The modelRevision of the projection's base: text.edit indices are against it (§7.5). */
  readonly baseRevision: string;
  readonly plan: SectionPlan;
  /** node.delete and node.restore, as rules.ts and undo.ts decided them. */
  readonly deletes?: readonly string[];
  readonly restores?: readonly string[];
  /**
   * Unbound nodes the editor transaction or the base shows were inserted
   * (§7.4); each gets an ID. Children of a new node bind on a later pass.
   */
  readonly creations?: readonly UnboundNode[];
  /** A new Task's fields from its line (as planShare builds them), with its new ID. */
  readonly newTask?: (candidate: UnboundNode, id: string) => NewSectionTask;
}

export interface CommitDeps {
  readonly port: SectionPort;
  readonly journal: SectionJournalStore;
  /** A new node ID (UUIDv7). */
  readonly newNodeId: () => string;
  readonly newOperationId: () => string;
}

/** The local status a pass leaves (OBSIDIAN-SYNC-INDICATORS-01 SI02, SI17). */
export type LocalStatus = "LOCAL_EDIT" | "LOCAL_SAVE_FAILED" | "SAVED_LOCAL";

export type PassOutcome =
  | { readonly kind: "nothing" }
  /** Durable: the receipt's modelRevision is the projection's new base; IDs by line go into markers. */
  | {
      readonly kind: "committed";
      readonly entry: JournalEntry;
      readonly receipt: Receipt;
      readonly ids: Readonly<Record<number, string>>;
    }
  /** Not sent: kept locally with why (read-only, revoked, refused). */
  | { readonly kind: "kept"; readonly candidate: PendingCandidate }
  /** STALE_BASE: plan again from a new snapshot (§7.5). */
  | { readonly kind: "stale" }
  /** The section is still importing (§4.3): nothing is created in it. */
  | { readonly kind: "importing" }
  /**
   * The commit failed and no receipt exists (SI17): the entry stays at
   * ids-allocated, and a retry resubmits the same batch.
   */
  | { readonly kind: "save-failed"; readonly entry: JournalEntry; readonly error: unknown };

/** The local status of an operation (SI02: an edit without a durable commit is not "saved"). */
export function localStatus(outcome: PassOutcome | JournalEntry): LocalStatus | null {
  if ("phase" in outcome)
    return outcome.phase === "captured" || outcome.phase === "ids-allocated"
      ? "LOCAL_EDIT"
      : outcome.phase === "abandoned"
        ? null
        : "SAVED_LOCAL";
  if (outcome.kind === "committed") return "SAVED_LOCAL";
  if (outcome.kind === "save-failed") return "LOCAL_SAVE_FAILED";
  return null;
}

/** The batch for a pass, with the IDs it allocates (reused by line from `ids`). */
export function intentsOf(
  pass: LocalPass,
  ids: Readonly<Record<number, string>>,
  newNodeId: () => string,
): { intents: SectionIntent[]; ids: Record<number, string> } {
  const intents: SectionIntent[] = [];
  const allocated: Record<number, string> = {};
  const { plan } = pass;
  if (plan.title !== undefined) intents.push({ intent: "section.set_title", title: plan.title });
  // Consecutive new nodes share their bound predecessor: each follows the one before it.
  const lastNew = new Map<string, string>();
  for (const c of pass.creations ?? []) {
    const id = ids[c.line] ?? newNodeId();
    allocated[c.line] = id;
    const key = `${c.parent ?? ""}\u0000${c.after ?? ""}`;
    const after = lastNew.get(key) ?? c.after;
    lastNew.set(key, id);
    if (c.kind === "task") {
      if (pass.newTask === undefined) throw new Error("a new Task needs its fields (newTask)");
      intents.push({
        intent: "task.create_in_section",
        task: pass.newTask(c, id),
        parent: c.parent,
        after,
      });
    } else
      intents.push({
        intent: `${c.kind}.create`,
        id,
        parent: c.parent,
        after,
        text: c.text ?? "",
      });
  }
  for (const id of pass.restores ?? []) intents.push({ intent: "node.restore", id });
  for (const { nodeId, edit } of plan.textEdits)
    intents.push({ intent: "text.edit", id: nodeId, edits: [edit], base: pass.baseRevision });
  for (const m of plan.moves)
    intents.push({ intent: "node.move", id: m.nodeId, parent: m.parent, after: m.after });
  for (const id of pass.deletes ?? []) intents.push({ intent: "node.delete", id });
  return { intents, ids: allocated };
}

const candidate = (
  pass: Pick<LocalPass, "projectionId" | "sourceText">,
  candidateId: string,
  reason: PendingCandidate["reason"],
): PendingCandidate => ({
  candidateId,
  projectionId: pass.projectionId,
  reason,
  sourceText: pass.sourceText,
});

/**
 * Commits one pass. `resume` is an unfinished entry of the same projection
 * found at "captured" after a restart: its operation ID and IDs are reused.
 */
export async function commitPass(
  deps: CommitDeps,
  pass: LocalPass,
  resume?: JournalEntry,
): Promise<PassOutcome> {
  const prior = resume === undefined ? {} : resume.allocatedIds;
  const { intents, ids } = intentsOf(pass, prior, deps.newNodeId);
  const operationId = resume?.operationId ?? deps.newOperationId();
  if (intents.length === 0) {
    if (resume !== undefined)
      await deps.journal.put(advance(resume, "abandoned", { reason: "nothing to send" }));
    return { kind: "nothing" };
  }

  const access = deps.port.canWrite(pass.resource);
  if (!access.allowed) {
    const kept = candidate(
      pass,
      operationId,
      access.reason === "revoked" ? "access-revoked" : "read-only",
    );
    await deps.journal.putCandidate(kept);
    if (resume !== undefined)
      await deps.journal.put(advance(resume, "abandoned", { reason: kept.reason }));
    return { kind: "kept", candidate: kept };
  }

  let entry: JournalEntry = resume ?? {
    operationId,
    projectionId: pass.projectionId,
    resource: pass.resource,
    phase: "captured",
    sourceHash: pass.sourceHash,
    allocatedIds: {},
  };
  if (resume === undefined) await deps.journal.put(entry);
  // IDs and the batch are durable before anything that could be retried.
  entry = advance(entry, "ids-allocated", { allocatedIds: ids, intents });
  await deps.journal.put(entry);
  return submit(deps, entry, pass);
}

/** Submits an entry's recorded batch; ids-allocated in, an outcome out. */
async function submit(
  deps: CommitDeps,
  entry: JournalEntry,
  pass: Pick<LocalPass, "projectionId" | "sourceText">,
): Promise<PassOutcome> {
  const intents = entry.intents ?? [];
  let receipt: Receipt | undefined;
  try {
    receipt = await deps.port.commit(entry.resource, intents, {
      operationId: entry.operationId,
    });
  } catch (error) {
    if (error instanceof CommitRefused) return refused(deps, entry, pass, error);
    // Unknown outcome: the receipt decides, never a repeat under a new ID.
    receipt = await deps.port.receiptOf(entry.resource, entry.operationId);
    if (receipt === undefined) return { kind: "save-failed", entry, error };
  }
  const committed = advance(entry, "committed", { receipt });
  await deps.journal.put(committed);
  return { kind: "committed", entry: committed, receipt, ids: committed.allocatedIds };
}

async function refused(
  deps: CommitDeps,
  entry: JournalEntry,
  pass: Pick<LocalPass, "projectionId" | "sourceText">,
  error: CommitRefused,
): Promise<PassOutcome> {
  await deps.journal.put(advance(entry, "abandoned", { reason: error.code }));
  if (error.code === "STALE_BASE") return { kind: "stale" };
  if (error.code === "SECTION_IMPORTING") return { kind: "importing" };
  const kept = candidate(
    pass,
    entry.operationId,
    error.code === "NOT_WRITABLE" ? "read-only" : "rejected",
  );
  await deps.journal.putCandidate(kept);
  return { kind: "kept", candidate: kept };
}

/** What a restart does with one unfinished entry (journal.recovery, contract §7.7). */
export type Resumed =
  /** Nothing durable: plan the projection again and call commitPass with this entry. */
  | { readonly kind: "re-evaluate"; readonly entry: JournalEntry }
  /** Committed: write the markers of these IDs (never new ones), then markProjected. */
  | {
      readonly kind: "project";
      readonly entry: JournalEntry;
      readonly receipt: Receipt;
      readonly ids: Readonly<Record<number, string>>;
    }
  /** Patched: finish when the source still has this hash, else compare it first. */
  | { readonly kind: "finish"; readonly entry: JournalEntry; readonly patchedHash: string }
  | { readonly kind: "save-failed"; readonly entry: JournalEntry; readonly error: unknown }
  | { readonly kind: "settled"; readonly outcome: PassOutcome };

export async function resumeOperation(
  deps: CommitDeps,
  entry: JournalEntry,
  sourceText = "",
): Promise<Resumed> {
  const r = recovery(entry);
  switch (r.kind) {
    case "re-evaluate":
      return { kind: "re-evaluate", entry };
    case "query-receipt": {
      const receipt = await deps.port.receiptOf(entry.resource, entry.operationId);
      if (receipt !== undefined) {
        const committed = advance(entry, "committed", { receipt });
        await deps.journal.put(committed);
        return { kind: "project", entry: committed, receipt, ids: committed.allocatedIds };
      }
      // None: no part was committed; the same batch goes again under the same ID.
      if (entry.intents === undefined) return { kind: "re-evaluate", entry };
      const outcome = await submit(deps, entry, { projectionId: entry.projectionId, sourceText });
      if (outcome.kind === "committed")
        return {
          kind: "project",
          entry: outcome.entry,
          receipt: outcome.receipt,
          ids: outcome.ids,
        };
      if (outcome.kind === "save-failed") return { ...outcome };
      return { kind: "settled", outcome };
    }
    case "project":
      return { kind: "project", entry, receipt: r.receipt, ids: r.allocatedIds };
    case "finish":
      return { kind: "finish", entry, patchedHash: r.patchedHash };
    default:
      return { kind: "settled", outcome: { kind: "nothing" } };
  }
}

/** The markers and metadata for the committed IDs are written; the source now has `patchedHash`. */
export async function markProjected(
  deps: CommitDeps,
  entry: JournalEntry,
  patchedHash: string,
): Promise<JournalEntry> {
  const next = advance(entry, "projected", { patchedHash });
  await deps.journal.put(next);
  return next;
}

/** The operation is finished: its receipt is released (contract §3.5). */
export async function finish(deps: CommitDeps, entry: JournalEntry): Promise<JournalEntry> {
  const done = advance(entry, "done");
  await deps.journal.put(done);
  await deps.port.releaseReceipt(entry.resource, entry.operationId);
  return done;
}
