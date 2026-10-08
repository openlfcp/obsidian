// Local records of shared-section projections (LFCP-02-038): the
// reconciliation journal, pending local candidates, and what a rebuild may
// recover. Interfaces and an in-memory store only; the install-database
// adapter comes later. Pure. The receipt is the SDK's (port.ts, contract
// §3.2); commit.ts drives an operation through these phases (LFCP-02-039).
//
// Everything here is local and private: source snapshots, candidates and
// paths never enter shared payloads, and diagnosticView() is the only shape
// default diagnostics may show (LFCP-02-065).

import type { SectionRef } from "./grammar";
import { parseSections } from "./parser";
import type { Receipt, SectionIntent } from "./port";

/**
 * A reconciliation's phases, in order (OBSIDIAN-SECTIONS-ARCHITECTURE-02 §5):
 * the source captured; node IDs allocated (and written to the journal before
 * anything that could be retried); the SDK commit made, with its durable
 * receipt; the projection patch (markers, metadata) applied; done.
 */
export const PHASES = ["captured", "ids-allocated", "committed", "projected", "done"] as const;
export type Phase = (typeof PHASES)[number] | "abandoned";

export interface JournalEntry {
  readonly operationId: string;
  readonly projectionId: string;
  /** The Resource (base64url) the operation commits to: a restart asks its receipt there. */
  readonly resource: string;
  readonly phase: Phase;
  /** SHA-256 of the section's source when captured, and after the projection patch. */
  readonly sourceHash: string;
  readonly patchedHash?: string;
  /** IDs allocated for new nodes, by their line at capture: reused on every retry. */
  readonly allocatedIds: Readonly<Record<number, string>>;
  /**
   * The batch, recorded with the IDs: a retry after a crash submits exactly
   * it again under the same operation ID (contract §3.3, §3.4).
   */
  readonly intents?: readonly SectionIntent[];
  /** The SDK's durable commit receipt (contract §3.2), once committed. */
  readonly receipt?: Receipt;
  /** Why the operation stopped, when abandoned. */
  readonly reason?: string;
}

/** Text that cannot be shared yet, kept locally with why (never discarded to meet a quota). */
export interface PendingCandidate {
  readonly candidateId: string;
  readonly projectionId: string;
  readonly reason:
    | "unsupported-syntax"
    | "binding-lost"
    | "base-unknown"
    | "read-only"
    | "access-revoked"
    | "rejected";
  /** The exact local source of the affected region (private). */
  readonly sourceText: string;
  /** The base's hash it was compared with, when there was one. */
  readonly baseHash?: string;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

const rank = (p: Phase) => (p === "abandoned" ? Number.POSITIVE_INFINITY : PHASES.indexOf(p));

/** The entry moved to `phase`: forward only, IDs and receipt never replaced. */
export function advance(
  entry: JournalEntry,
  phase: Phase,
  extra: {
    receipt?: Receipt;
    patchedHash?: string;
    reason?: string;
    allocatedIds?: Record<number, string>;
    intents?: readonly SectionIntent[];
  } = {},
): JournalEntry {
  if (entry.phase === "done" || entry.phase === "abandoned")
    throw new JournalError(`operation ${entry.operationId} is already ${entry.phase}`);
  if (rank(phase) <= rank(entry.phase))
    throw new JournalError(
      `operation ${entry.operationId} cannot go from ${entry.phase} back to ${phase}`,
    );
  if (phase === "committed" && extra.receipt === undefined && entry.receipt === undefined)
    throw new JournalError("a commit needs its durable receipt");
  if (
    entry.receipt !== undefined &&
    extra.receipt !== undefined &&
    JSON.stringify(extra.receipt) !== JSON.stringify(entry.receipt)
  )
    throw new JournalError("a receipt is never replaced");
  if (
    entry.intents !== undefined &&
    extra.intents !== undefined &&
    JSON.stringify(extra.intents) !== JSON.stringify(entry.intents)
  )
    throw new JournalError("a recorded batch is never replaced");
  const ids = extra.allocatedIds ?? {};
  for (const [line, id] of Object.entries(ids))
    if (entry.allocatedIds[Number(line)] !== undefined && entry.allocatedIds[Number(line)] !== id)
      throw new JournalError("an allocated ID is never replaced");
  return {
    ...entry,
    phase,
    allocatedIds: { ...entry.allocatedIds, ...ids },
    ...(extra.receipt === undefined ? {} : { receipt: extra.receipt }),
    ...(extra.intents === undefined ? {} : { intents: extra.intents }),
    ...(extra.patchedHash === undefined ? {} : { patchedHash: extra.patchedHash }),
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  };
}

/** What to do with an unfinished entry after a restart (ARCHITECTURE-02 §5, crash table). */
export type Recovery =
  /** Nothing durable yet: evaluate the source again, reusing the recorded IDs. */
  | { readonly kind: "re-evaluate"; readonly allocatedIds: Readonly<Record<number, string>> }
  /** IDs recorded, commit unknown: ask the SDK for the operation's receipt; never repeat blindly. */
  | { readonly kind: "query-receipt" }
  /** Committed, markers not written: project the existing IDs, never new ones. */
  | {
      readonly kind: "project";
      readonly receipt: Receipt;
      readonly allocatedIds: Readonly<Record<number, string>>;
    }
  /** Patched, not finished: finish when the source still has the patched hash; else compare. */
  | { readonly kind: "finish"; readonly patchedHash: string }
  | { readonly kind: "none" };

export function recovery(entry: JournalEntry): Recovery {
  switch (entry.phase) {
    case "captured":
      return { kind: "re-evaluate", allocatedIds: entry.allocatedIds };
    case "ids-allocated":
      return { kind: "query-receipt" };
    case "committed":
      return {
        kind: "project",
        receipt: entry.receipt as Receipt,
        allocatedIds: entry.allocatedIds,
      };
    case "projected":
      return { kind: "finish", patchedHash: entry.patchedHash ?? entry.sourceHash };
    default:
      return { kind: "none" };
  }
}

/** The local records of section projections (one install, never synced). */
export interface SectionJournalStore {
  put(entry: JournalEntry): Promise<void>;
  get(operationId: string): Promise<JournalEntry | undefined>;
  /** Entries not done or abandoned, oldest first: what a restart resumes. */
  unfinished(): Promise<JournalEntry[]>;
  putCandidate(candidate: PendingCandidate): Promise<void>;
  candidates(projectionId: string): Promise<PendingCandidate[]>;
  /** Only after an explicit resolution: candidates are never dropped to save space. */
  resolveCandidate(candidateId: string): Promise<void>;
}

export class MemorySectionJournalStore implements SectionJournalStore {
  readonly #entries = new Map<string, JournalEntry>();
  readonly #candidates = new Map<string, PendingCandidate>();

  async put(entry: JournalEntry): Promise<void> {
    const old = this.#entries.get(entry.operationId);
    // A put is the same check as advance(): forward only.
    if (old !== undefined && old !== entry && rank(entry.phase) <= rank(old.phase))
      throw new JournalError(`operation ${entry.operationId} cannot go back to ${entry.phase}`);
    this.#entries.set(entry.operationId, entry);
  }

  async get(operationId: string): Promise<JournalEntry | undefined> {
    return this.#entries.get(operationId);
  }

  async unfinished(): Promise<JournalEntry[]> {
    return [...this.#entries.values()].filter((e) => e.phase !== "done" && e.phase !== "abandoned");
  }

  async putCandidate(candidate: PendingCandidate): Promise<void> {
    this.#candidates.set(candidate.candidateId, candidate);
  }

  async candidates(projectionId: string): Promise<PendingCandidate[]> {
    return [...this.#candidates.values()].filter((c) => c.projectionId === projectionId);
  }

  async resolveCandidate(candidateId: string): Promise<void> {
    this.#candidates.delete(candidateId);
  }
}

/** What default diagnostics may show of a candidate: no text, no path (LFCP-02-065). */
export function diagnosticView(candidate: PendingCandidate): {
  readonly projectionId: string;
  readonly reason: PendingCandidate["reason"];
  readonly characters: number;
} {
  return {
    projectionId: candidate.projectionId,
    reason: candidate.reason,
    characters: candidate.sourceText.length,
  };
}

/** What a rebuild recovers from a note alone: identities and ranges, never a causal base. */
export interface RebuiltProjection {
  readonly section: SectionRef;
  readonly lines: { readonly from: number; readonly to: number };
  /** Bound IDs found in the note. */
  readonly ids: readonly string[];
  /**
   * Always true: markers prove identity, not whether a difference is an
   * unsent edit or a stale rendering (MARKDOWN-SECTIONS-01 §11). The
   * adapter compares with the shared state before publishing or writing.
   */
  readonly baseUnknown: true;
}

export function rebuildFromNote(markdown: string): RebuiltProjection[] {
  return parseSections(markdown).sections.map((s) => {
    const ids: string[] = [];
    const walk = (ns: typeof s.nodes) => {
      for (const n of ns) {
        if (n.id !== null) ids.push(n.id);
        walk(n.children);
      }
    };
    walk(s.nodes);
    return {
      section: s.ref,
      lines: { from: s.heading.line, to: s.endLine },
      ids,
      baseUnknown: true as const,
    };
  });
}
