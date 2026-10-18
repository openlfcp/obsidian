// What the diagnostics report is built from (LFCP-02-065): the runtime's
// registry and status, each collaboration's status counts, the shared
// sections' states and kept candidates, the safe event log. Codes and
// counts only; the report decides what of the identifiers it shows.

import { toHex } from "@openlfcp/core";
import type { Collaboration } from "./collab/service";
import type {
  DiagnosticEvent,
  DiagnosticInput,
  KeptCandidate,
  ResourceFacts,
  SectionFacts,
} from "./diagnostics";
import type { LfcpRuntime } from "./lfcp/runtime";
import type { JournalEntry, PendingCandidate } from "./sections/journal";

export interface DiagnosticSources {
  readonly runtime: LfcpRuntime | null;
  /** Its list states a shared section as its session sees it (the registry calls it "unsupported"). */
  readonly collab: Pick<Collaboration, "status" | "list"> | null;
  readonly sections: {
    diagnostics(): Promise<{
      readonly sections: readonly SectionFacts[];
      readonly candidates: readonly KeptCandidate[];
      readonly missingNotes?: { readonly notes: number; readonly oldestDays: number };
    }>;
  } | null;
  readonly events: readonly DiagnosticEvent[];
  readonly plugin: string;
  readonly obsidian: string;
  readonly platform: string;
  readonly needsRestart: boolean;
  readonly now?: () => number;
}

export async function collectDiagnostics(src: DiagnosticSources): Promise<DiagnosticInput> {
  const runtime = src.runtime;
  const resources: ResourceFacts[] = [];
  const entries =
    (await src.collab?.list().catch(() => undefined)) ?? (await runtime?.registry()) ?? [];
  for (const e of entries) {
    const s = await src.collab?.status(e.resourceId).catch(() => undefined);
    resources.push({
      id: toHex(e.resourceId),
      profile: e.profile,
      state: e.state,
      phase: runtime?.phase(e.resourceId) ?? "CLOSED",
      hosting: s?.hosting ?? "unknown",
      refusalCode: e.refusal?.code ?? null,
      routes: e.routes,
      controlSeq: s?.controlSeq ?? null,
      dataEpoch: s?.dataEpoch ?? null,
      pendingOutbound: s?.pendingOutbound ?? 0,
      conflicts: s?.conflicts.length ?? 0,
      blockedCollaborators: s?.blockedCollaborators?.length ?? 0,
    });
  }
  const sections = (await src.sections?.diagnostics()) ?? { sections: [], candidates: [] };
  const local = await runtime?.localStateDiagnostics().catch(() => null);
  const kept = await runtime?.keptDiscarded().catch(() => undefined);
  return {
    generatedAt: (src.now ?? Date.now)(),
    plugin: src.plugin,
    obsidian: src.obsidian,
    platform: src.platform,
    runtime: src.needsRestart ? "needs-restart" : (runtime?.status.kind ?? "not-started"),
    localEncryption:
      runtime === null || runtime === undefined || local === undefined
        ? null
        : runtime.localStateSummary(local),
    resources,
    sections: sections.sections,
    candidates: sections.candidates,
    ...(sections.missingNotes === undefined ? {} : { missingNotes: sections.missingNotes }),
    ...(kept === undefined
      ? {}
      : {
          keptShares: {
            sent: kept.filter((k) => k.sent).length,
            deleting: kept.filter((k) => !k.sent).length,
          },
        }),
    events: src.events,
  };
}

/** What the sections' diagnostics read of the journal: kept candidates and operations. */
export interface DiagnosticJournal {
  allCandidates(): Promise<PendingCandidate[]>;
  get(operationId: string): Promise<JournalEntry | undefined>;
}

/** A refusal code an abandoned operation recorded; a local reason ("flush-failed") is none. */
const refusalOf = (entry: JournalEntry | undefined): string | undefined =>
  entry?.phase === "abandoned" &&
  entry.reason !== undefined &&
  /^[A-Z][A-Z0-9_]*$/.test(entry.reason)
    ? entry.reason
    : undefined;

/**
 * The kept candidates as diagnostics show them: reason and size, and for a
 * refused edit the server's code, from its abandoned operation (the
 * candidate has the operation's ID). Never their text.
 */
export async function keptCandidates(journal: DiagnosticJournal): Promise<KeptCandidate[]> {
  const out: KeptCandidate[] = [];
  for (const c of await journal.allCandidates()) {
    const code = c.reason === "rejected" ? refusalOf(await journal.get(c.candidateId)) : undefined;
    const kept = {
      reason: c.reason,
      characters: c.sourceText.length,
      ...(c.sectionKey === undefined ? { unkeyed: true as const } : {}),
    };
    out.push(code === undefined ? kept : { ...kept, code });
  }
  return out;
}

/**
 * A LOCAL_SAVE_FAILED condition as diagnostics name it: "save-failed:<CODE>"
 * for each refusal code its failed operations recorded, "save-failed" when
 * none did.
 */
export async function saveFailedConditions(
  journal: DiagnosticJournal,
  operationIds: readonly string[],
): Promise<string[]> {
  const codes = new Set<string>();
  for (const id of operationIds) {
    const c = refusalOf(await journal.get(id));
    if (c !== undefined) codes.add(c);
  }
  return codes.size === 0 ? ["save-failed"] : [...codes].sort().map((c) => `save-failed:${c}`);
}
