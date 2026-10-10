// The details card of a shared section (LFCP-02-059,
// OBSIDIAN-SYNC-INDICATORS-01 §1, §4–§6, §8; OBSIDIAN-SHARED-SECTIONS-UX-01).
// Pure: what the card says, in the user's words first and the technical
// facts after. Every string is plain text: the card sets it as text, never
// as markup, so a title or a name cannot inject anything.

import type { AccessView } from "./access";
import type { Condition, StatusView } from "./reducer";

export interface CardInput {
  /** The section's title as the note shows it (local, never sent from here). */
  readonly title: string;
  readonly view: StatusView;
  /** The Resource (base64url) and section ID: shown shortened in the technical part. */
  readonly resource: string;
  readonly sectionId: string;
  /** Who has access, from the validated Control state (060). */
  readonly access?: AccessView;
  /** What the model holds now (visible nodes by kind). */
  readonly counts?: { readonly tasks: number; readonly paragraphs: number; readonly items: number };
  readonly hosting?: "hosted" | "pending" | "unknown";
  /** LFCP-02-117: the history's size (§13.1, inserted characters), when measured. */
  readonly history?: number;
}

export interface SectionCard {
  readonly heading: string;
  /** The primary state's sentence (§6). */
  readonly status: string;
  /** Qualified facts: local saving, sending, receiving, access. */
  readonly facts: readonly string[];
  /** What needs attention, most important first. */
  readonly problems: readonly string[];
  /** What is shared, and what is not. */
  readonly shared: readonly string[];
  /** Who has access (060); absent when not known yet. */
  readonly access?: AccessView;
  /** Secondary: identifiers and raw state names. */
  readonly technical: readonly string[];
}

/** LFCP-02-117: from here the card suggests a new section for new material (§13.1 floor: 262,144). */
export const HISTORY_ADVICE_AT = 200_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function problemText(c: Condition): string | null {
  switch (c.kind) {
    case "save-failed":
      return "Some local changes are not safely saved for sync. Keep the note open and try again; nothing was sent for them.";
    case "access":
      return c.access === "revoked"
        ? "Your access to this section was removed. Your local copy stays; new edits are kept on this device only."
        : c.access === "refused"
          ? "The sync server no longer accepts changes from this vault for this section. Your local copy stays; new edits are kept on this device only. Ask the section's owner to check your access."
          : "This device does not hold the section's key yet. Edits wait until it arrives.";
    case "invalid-profile":
      return "This section's data is not valid for this version of Shared Tasks.";
    case "rejected":
      return `The server refused ${plural(c.batchIds.length, "update", "updates")} (${c.code}). The text stays in your note.`;
    case "source":
      return c.source === "base-unknown"
        ? "One copy of this section in your notes has to be compared with the shared version before it syncs again."
        : c.source === "unsupported"
          ? "One copy of this section has text that cannot be shared as it is."
          : c.source === "diverged"
            ? "One copy of this section differs from the shared version."
            : "One copy of this section has a damaged boundary or binding line.";
    case "structural-conflict":
      return `A structure conflict touches ${plural(c.nodeIds.length, "item", "items")}: their place is not updated in your note until it is resolved.`;
    case "scalar-conflict":
      return `Conflicting edits on ${plural(c.nodeIds.length, "item", "items")}: both values are kept until you choose.`;
    default:
      return null;
  }
}

/** The card's content. */
export function sectionCard(input: CardInput): SectionCard {
  const v = input.view;
  const kinds = new Set(v.conditions.map((c) => c.kind));
  const facts: string[] = [];
  if (kinds.has("save-failed")) facts.push("Not all local changes are saved for sync.");
  else if (kinds.has("local-edit")) facts.push("Local changes are being processed.");
  if (v.pendingBatches > 0)
    facts.push(
      v.pendingCounted
        ? `${plural(v.pendingBatches, "local update", "local updates")} saved on this device, waiting to be sent.`
        : "Pending local changes are saved on this device, waiting to be sent.",
    );
  else if (!kinds.has("save-failed") && !kinds.has("local-edit"))
    facts.push("No local changes waiting.");
  if (kinds.has("evidence-unavailable"))
    facts.push(
      "The server acknowledged some updates without confirming it stored them: they are not shown as accepted.",
    );
  if (v.acceptedBatches > 0)
    facts.push(
      `${plural(v.acceptedBatches, "update was", "updates were")} accepted by the server.`,
    );
  if (kinds.has("offline")) facts.push("Offline: local updates wait on this device.");
  else if (kinds.has("loading")) facts.push("Not checked with the server yet.");
  else if (kinds.has("catching-up")) facts.push("Receiving changes from the server.");
  else
    facts.push("Current as last checked with the server. This does not mean others have seen it.");
  if (v.conditions.some((c) => c.kind === "access" && c.access === "refused"))
    facts.push("The sync server does not accept your edits to this section now.");
  else
    facts.push(
      v.readOnly ? "You can read this section, not edit it." : "You can edit this section.",
    );
  if (kinds.has("access-checking"))
    facts.push(
      "Access is being checked with the server: it may have changed since this device last saw it.",
    );
  if (kinds.has("control-pending"))
    facts.push("A change to who has access is waiting for the server: it is not done yet.");
  if (input.hosting === "pending")
    facts.push("Not on its server yet: nobody can join until it is hosted.");

  const problems = v.conditions.map(problemText).filter((p): p is string => p !== null);

  const shared = [
    "Everything between this section's start and end markers is shared, including future additions.",
    "Text after the end marker, and anywhere else in the note, stays on this device.",
  ];
  // LFCP-02-117: the history only grows; past about 200,000 a new section is suggested (no action taken).
  if (input.history !== undefined) {
    shared.push(
      `History: about ${input.history.toLocaleString("en-US")} characters inserted since the section was shared (deleted text counts too).`,
    );
    if (input.history >= HISTORY_ADVICE_AT)
      shared.push(
        "This section's history is large. For new material, consider starting a new section; this one keeps working as it is.",
      );
  }
  if (input.counts !== undefined)
    shared.push(
      `Now: ${plural(input.counts.tasks, "task", "tasks")}, ${plural(input.counts.paragraphs, "paragraph", "paragraphs")}, ${plural(input.counts.items, "list item", "list items")}.`,
    );

  return {
    heading: `Shared section "${input.title}"`,
    status: v.label,
    facts,
    problems,
    shared,
    ...(input.access === undefined ? {} : { access: input.access }),
    technical: [
      `State: ${v.state}`,
      `Resource: ${input.resource.slice(0, 12)}…`,
      `Section: ${input.sectionId}`,
      `Conditions: ${v.conditions.map((c) => c.kind).join(", ") || "none"}`,
    ],
  };
}
