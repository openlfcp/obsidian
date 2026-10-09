// Local diagnostics (LFCP-02-065): what a user may copy or save to show a
// failure, built on this device and never sent anywhere. Pure.
//
// By default the report holds versions, states, error codes, counts and a
// log of safe events, and nothing a note, a path, a collaboration's name, a
// Task, an identifier, a server address, a key or an invitation could put
// there: collaborations and sections are numbered, events keep only their
// kind and code-like fields. Identifiers and server addresses are added
// only when the user ticks them in the preview (`detailed`). A last pass
// (redact) removes anything shaped like an invitation secret, a ref, a key,
// a path or (by default) an identifier or an address, whatever field it
// came through.

/** One safe event: when, what kind, and code-like details only. */
export interface DiagnosticEvent {
  readonly at: number;
  readonly kind: string;
  readonly detail?: Readonly<Record<string, string>>;
}

export interface ResourceFacts {
  /** Hex Resource ID: shown only in a detailed report. */
  readonly id: string;
  readonly profile: string;
  readonly state: string;
  readonly phase: string;
  readonly hosting: string;
  readonly refusalCode: string | null;
  /** Endpoint URLs: shown only in a detailed report. */
  readonly routes: readonly string[];
  readonly controlSeq: string | null;
  readonly dataEpoch: string | null;
  readonly pendingOutbound: number;
  readonly conflicts: number;
  readonly blockedCollaborators: number;
}

export interface SectionFacts {
  /** "<resource>#<section>": shown only in a detailed report. */
  readonly key: string;
  readonly state: string;
  /** Condition kinds and codes (never node IDs or text). */
  readonly conditions: readonly string[];
  readonly pendingBatches: number;
}

export interface DiagnosticInput {
  readonly generatedAt: number;
  readonly plugin: string;
  readonly obsidian: string;
  readonly platform: string;
  readonly runtime: string;
  /** The runtime's local encryption summary line ("Local encryption: …"), or null. */
  readonly localEncryption: string | null;
  readonly resources: readonly ResourceFacts[];
  readonly sections: readonly SectionFacts[];
  /** Kept local candidates (text that could not be shared): reasons only. */
  readonly candidates: readonly { readonly reason: string; readonly characters: number }[];
  readonly events: readonly DiagnosticEvent[];
}

/**
 * The shapes a code has: an UPPER_SNAKE error code or state, a lowercase
 * kind or state (with an optional ":CODE"), a version, a profile ID. Free
 * text, mixed case or anything with a space, is not one.
 */
const CODE =
  /^(?:[A-Z][A-Z0-9_]{0,63}|[a-z][a-z0-9-]{0,47}(?::[A-Z][A-Z0-9_]{0,47})?|\d+(?:\.\d+){0,3}(?:-[a-z0-9.]+)?|[a-z0-9]+(?:\.[a-z0-9-]+)+\/\d+)$/;

/** A value as a code, or "(text)" when it is anything else: free text never passes. */
const code = (v: string | null | undefined): string =>
  v === null || v === undefined ? "none" : CODE.test(v) ? v : "(text)";

/** An event from an SDK or plugin event: its kind and its code-like fields only. */
export function safeEvent(
  at: number,
  kind: string,
  fields: Record<string, unknown>,
): DiagnosticEvent {
  const detail: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!["state", "code", "status", "kind", "reason", "diagnostic"].includes(k)) continue;
    if (typeof v === "string" && CODE.test(v)) detail[k] = v;
  }
  return Object.keys(detail).length > 0
    ? { at, kind: code(kind), detail }
    : { at, kind: code(kind) };
}

/** A bounded, in-memory log of safe events (oldest dropped). */
export class DiagnosticLog {
  readonly #events: DiagnosticEvent[] = [];
  constructor(private readonly limit = 200) {}

  add(event: DiagnosticEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.limit) this.#events.splice(0, this.#events.length - this.limit);
  }

  get events(): readonly DiagnosticEvent[] {
    return [...this.#events];
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

const PATTERNS: readonly [RegExp, string][] = [
  // An invitation link's secret, wherever it is.
  [/#secret=[^\s"'<>]*/gi, "#secret=[removed]"],
  [/\b(?:secret|key|token|password)=[^\s"'<>&]*/gi, "[removed]"],
  // Refs and markers carry Resource and object IDs.
  [/lfcp1:[A-Za-z0-9_-]+(?:#[A-Za-z]+:[0-9a-f-]+)?/g, "lfcp1:[removed]"],
  // Paths of notes and files.
  [/(?:[^\s"'<>]*\/)?[^\s"'<>/]+\.(?:md|canvas|json|txt)\b/gi, "[path]"],
];
const IDENTIFIERS: readonly [RegExp, string][] = [
  [/\b(?:wss?|https?):\/\/[^\s"'<>]+/gi, "[address]"],
  [/\b[0-9a-f]{32,}\b/gi, "[id]"],
  [/\b[A-Za-z0-9_-]{43}\b/g, "[id]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
];

/** The last pass over the report: secrets always; identifiers and addresses unless detailed. */
export function redact(text: string, detailed: boolean): string {
  let out = text;
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  if (!detailed) for (const [re, by] of IDENTIFIERS) out = out.replace(re, by);
  return out;
}

/** The report as plain text (LFCP-02-065): safe by default, identifiers only when `detailed`. */
export function diagnosticReport(input: DiagnosticInput, detailed: boolean): string {
  const lines: string[] = [
    "Shared Tasks diagnostics",
    `Generated: ${iso(input.generatedAt)}`,
    `Plugin: ${code(input.plugin)} · Obsidian: ${code(input.obsidian)} · Platform: ${code(input.platform)}`,
    `Runtime: ${code(input.runtime)}`,
    input.localEncryption ?? "Local encryption: unknown",
    detailed
      ? "Includes identifiers and server addresses (chosen in the preview)."
      : "Identifiers, server addresses, names, notes and paths are left out.",
    "",
    `Collaborations: ${input.resources.length}`,
  ];
  input.resources.forEach((r, i) => {
    lines.push(
      `  ${i + 1}. ${code(r.profile)} · state ${code(r.state)} · phase ${code(r.phase)} · hosting ${code(r.hosting)} · refusal ${code(r.refusalCode)}`,
      `     control seq ${code(r.controlSeq)} · data epoch ${code(r.dataEpoch)} · pending outbound ${r.pendingOutbound} · conflicts ${r.conflicts} · blocked collaborators ${r.blockedCollaborators}`,
    );
    if (detailed) {
      lines.push(`     id ${r.id}`);
      for (const route of r.routes) lines.push(`     route ${route}`);
    }
  });
  lines.push("", `Shared sections: ${input.sections.length}`);
  input.sections.forEach((s, i) => {
    lines.push(
      `  ${i + 1}. state ${code(s.state)} · pending batches ${s.pendingBatches} · conditions ${s.conditions.map(code).join(", ") || "none"}`,
    );
    if (detailed) lines.push(`     key ${s.key}`);
  });
  const reasons = new Map<string, number>();
  for (const c of input.candidates)
    reasons.set(code(c.reason), (reasons.get(code(c.reason)) ?? 0) + 1);
  lines.push(
    "",
    `Text kept on this device, not shared: ${input.candidates.length}${
      reasons.size === 0 ? "" : ` (${[...reasons].map(([r, n]) => `${r} ${n}`).join(", ")})`
    }`,
    "",
    `Recent events: ${input.events.length}`,
  );
  for (const e of input.events) {
    const detail = Object.entries(e.detail ?? {})
      .map(([k, v]) => `${k}=${code(v)}`)
      .join(" ");
    lines.push(`  ${iso(e.at)} ${code(e.kind)}${detail === "" ? "" : ` ${detail}`}`);
  }
  return `${redact(lines.join("\n"), detailed)}\n`;
}
