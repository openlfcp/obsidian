// What the diagnostics report is built from (LFCP-02-065): the runtime's
// registry and status, each collaboration's status counts, the shared
// sections' states and kept candidates, the safe event log. Codes and
// counts only; the report decides what of the identifiers it shows.

import { toHex } from "@openlfcp/core";
import type { Collaboration } from "./collab/service";
import type { DiagnosticEvent, DiagnosticInput, ResourceFacts, SectionFacts } from "./diagnostics";
import type { LfcpRuntime } from "./lfcp/runtime";

export interface DiagnosticSources {
  readonly runtime: LfcpRuntime | null;
  readonly collab: Pick<Collaboration, "status"> | null;
  readonly sections: {
    diagnostics(): Promise<{
      readonly sections: readonly SectionFacts[];
      readonly candidates: readonly { readonly reason: string; readonly characters: number }[];
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
  for (const e of (await runtime?.registry()) ?? []) {
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
    events: src.events,
  };
}
