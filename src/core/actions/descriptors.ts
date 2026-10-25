// The action descriptors of MVP 0.3 (LFCP-03-010, U03-07; UX contract
// docs/architecture/ux-contract-0.3.md §3): for each stable action ID its
// label, whether it is destructive, and its availability in a context:
// hidden (it does not apply, A5/D10), disabled with its reason (it applies
// but is blocked), or enabled. Availability is a pure predicate over facts,
// with no side effect: the pane, the card and the editor menu read it to
// draw their entries; the executor (sections/actions.ts) checks the same
// guards again, on the facts as they are when it runs, before any effect
// (a disabled button is never the only guard).
//
// The guards the executor shares with the descriptors are here too:
// another instance holding the vault, the runtime still starting, sections
// read-only on this device, no default server. Each is a reason code, said
// as a notice by the executor and as a disabled reason by the pane.
//
// Pure: no Obsidian, no DOM.

import { SECTIONS_READ_ONLY } from "../lfcp/runtime";
import { flowAction, stageOf } from "../pane/flows";
import type { PaneContext, PaneFlow, PaneRegistry, PaneSection } from "../pane/model";
import { selectionReasonText } from "../sections/target";
import type { HeldCause } from "../status/held";
import { ACTIONS, type ActionId } from "./catalog";

/** An action in a context: hidden (A5), disabled with its reason, or enabled. */
export type Availability =
  | { readonly kind: "hidden" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "enabled" };

const HIDDEN: Availability = { kind: "hidden" };
const ENABLED: Availability = { kind: "enabled" };
const disabled = (reason: string): Availability => ({ kind: "disabled", reason });

/** The host's running state, as every surface and the executor see it. */
export interface HostFacts {
  /** Why the plugin cannot run here (another instance holds the vault's data), or null. */
  readonly unavailable: string | null;
  /** The runtime has not started yet. */
  readonly starting: boolean;
  /** V3: sections are read-only on this device (no new section, no access change). */
  readonly readOnly: boolean;
  /** The default sync server is set (a new section is hosted there). */
  readonly server: boolean;
}

/** A running host: what a context without host facts assumes (the pane's fixtures). */
export const RUNNING: HostFacts = {
  unavailable: null,
  starting: false,
  readOnly: false,
  server: true,
};

/** Why the host refuses an action now. */
export type HostRefusal =
  | { readonly kind: "unavailable"; readonly text: string }
  | { readonly kind: "read-only" }
  | { readonly kind: "starting" }
  | { readonly kind: "no-server" };

/** What an action needs of the host, beyond running. */
export interface HostNeeds {
  /** It changes shared state from this device (a new section, an access change): not when read-only. */
  readonly writes?: boolean;
  /** It hosts a new section: a default server must be set. */
  readonly server?: boolean;
}

/**
 * The host guard (pure): null when the host may run the action, else why
 * not, in this order: unavailable, read-only, still starting, no server.
 */
export function hostRefusal(h: HostFacts, needs: HostNeeds = {}): HostRefusal | null {
  if (h.unavailable !== null) return { kind: "unavailable", text: h.unavailable };
  if (needs.writes === true && h.readOnly) return { kind: "read-only" };
  if (h.starting) return { kind: "starting" };
  if (needs.server === true && !h.server) return { kind: "no-server" };
  return null;
}

/** The executor's notice for a host refusal; `again` is what to try again ("Try again in a moment."). */
export function hostRefusalNotice(r: HostRefusal, again = "Try again in a moment."): string {
  switch (r.kind) {
    case "unavailable":
      return r.text;
    case "read-only":
      return `Shared Tasks: ${SECTIONS_READ_ONLY}.`;
    case "starting":
      return `Shared Tasks: still starting. ${again}`;
    case "no-server":
      return "Shared Tasks: set a default sync server in the settings to share a section.";
  }
}

/** A host refusal as a disabled action's reason (A3), without the plugin's name. */
export function hostRefusalReason(r: HostRefusal): string {
  switch (r.kind) {
    case "unavailable":
      return r.text.replace(/^Shared Tasks: /, "");
    case "read-only":
      return `${SECTIONS_READ_ONLY}.`;
    case "starting":
      return "Shared Tasks is still starting.";
    case "no-server":
      return "Set a default sync server in the settings to share a section.";
  }
}

/** What a descriptor's availability reads: the pane's facts, and the host's. */
export interface ActionFacts {
  readonly context: PaneContext;
  readonly registry: PaneRegistry;
  readonly section: PaneSection | null;
  /** Setup incomplete (no server, sections off), with the exact reason; null or absent: complete. */
  readonly setup?: { readonly reason: string } | null;
  /** Other unfinished flows, besides the context's (P2). */
  readonly unfinished?: readonly PaneFlow[];
  /** The host's running state; absent: running, not read-only, with a server. */
  readonly host?: HostFacts;
  /**
   * "Insert into a note…" goes into the note in view (the plugin today); absent: the
   * insert chooses its note itself (the prototype; task 016).
   */
  readonly insertIntoNoteInView?: boolean;
}

/**
 * The facts of one section with no note around it: what a surface that is
 * about a section alone (the section card) reads, so that its buttons and
 * the pane's agree (LFCP-03-013, A7).
 */
export function sectionFacts(section: PaneSection, host: HostFacts): ActionFacts {
  return {
    context: { editor: "none", note: null, cursor: "none", selection: null, flow: null },
    registry: { status: "ready", placementIndex: "unknown", sections: null, unplaced: null },
    section,
    host,
  };
}

/** One action: its stable ID, label, and availability in a context. */
export interface ActionDescriptor {
  readonly id: ActionId;
  readonly label: string;
  /** A destructive action is never primary (A1). */
  readonly destructive: boolean;
  /** Pure: the same facts give the same answer, and nothing else happens. */
  availability(f: ActionFacts): Availability;
}

/** Held edits kept because this vault may not send them: reviewed, not repaired. */
export const ACCESS_HELD: ReadonlySet<HeldCause> = new Set([
  "read-only",
  "revoked",
  "refused",
  "rejected",
]);
export const REPAIR_HELD: ReadonlySet<HeldCause> = new Set(["boundary", "binding", "base-unknown"]);

/** This vault's access, as the server last said, does not let it change the section. */
const NOT_ACCEPTED: ReadonlySet<string> = new Set([
  "revoked",
  "not-member",
  "refused",
  "unavailable-key",
]);

const BUSY = "A flow is open; finish or cancel it first.";
/**
 * Why "Invite collaborator…" waits: this device has not checked its access
 * with the server (unknown, stale, or offline). The pane, the card and the
 * palette's executor say the same (I4, LFCP-03-041).
 */
export const INVITE_WAITS = "Inviting waits until this device has checked access with the server.";
const OPEN_TO_SHARE = "Open the note for editing to share from it.";

/** What every availability reads off the facts, once. */
interface Derived {
  readonly f: ActionFacts;
  readonly host: HostFacts;
  readonly flow: PaneFlow | null;
  readonly running: PaneFlow | null;
  /** The running flow's next step, when it waits for the user. */
  readonly next: ActionId | null;
  readonly noteOpen: boolean;
  readonly reading: boolean;
  readonly kinds: ReadonlySet<string>;
}

function derive(f: ActionFacts): Derived {
  const flow = f.context.flow;
  const running = flow?.outcome === "running" ? flow : null;
  return {
    f,
    host: f.host ?? RUNNING,
    flow,
    running,
    next:
      running !== null && stageOf(running.kind, running.stage).waits === "user"
        ? flowAction(running.kind, running.stage)
        : null,
    noteOpen: f.context.editor !== "none",
    reading: f.context.editor === "reading",
    kinds: new Set(f.section?.view.conditions.map((c) => c.kind) ?? []),
  };
}

type Rule = (d: Derived) => Availability;

/** The context offers a share with its preview: a private heading or an exact selection, no flow. */
const sharing = (d: Derived): boolean => {
  const ctx = d.f.context;
  if (d.flow !== null || !d.noteOpen || d.reading || ctx.cursor === "inside-section") return false;
  return ctx.selection === null
    ? ctx.cursor === "private-heading"
    : ctx.selection.eligibility === "exact";
};

/** The cursor of the note in view is in the section the pane is about (copy and detach act there). */
const inSection = (d: Derived): boolean =>
  d.noteOpen && d.f.context.cursor === "inside-section" && d.f.section !== null;

/** A section-scoped action: hidden without a section in the context. */
const ofSection =
  (rule: (d: Derived, s: PaneSection) => Availability): Rule =>
  (d) =>
    d.f.section === null ? HIDDEN : rule(d, d.f.section);

/** The host guard as a disabled reason, else `rest`. */
const guarded =
  (needs: HostNeeds, rest: Rule): Rule =>
  (d) => {
    const r = hostRefusal(d.host, needs);
    return r === null ? rest(d) : disabled(hostRefusalReason(r));
  };

const shareNeeds: HostNeeds = { writes: true, server: true };

const RULES: Readonly<Record<ActionId, Rule>> = {
  // A2: join stays in the header; a join already under way is revealed, never started twice (A4).
  "join-with-link": (d) => {
    if (d.next === "join-with-link") return ENABLED;
    // Joined, waiting only for a place: another link may be joined; the section stays listed.
    const placing = d.running?.kind === "join" && d.running.stage === "choose-place";
    if (d.flow?.kind === "join" && d.flow.outcome !== "unfinished" && !placing)
      return disabled("A join is in progress. Finish it first.");
    if (d.flow?.kind === "join" && !placing) return disabled("A join is unfinished: continue it.");
    return guarded({}, () => ENABLED)(d);
  },
  "share-section": (d) => {
    const ctx = d.f.context;
    const sel = ctx.selection;
    if (d.next === "share-section") return ENABLED;
    if (d.flow?.kind === "share" && d.flow.outcome !== "unfinished")
      return disabled("A share is in progress. Finish it first.");
    if (d.running !== null) return disabled(BUSY);
    if (!d.noteOpen) return disabled("Open a note to share a section from it.");
    // 0.1 shared Tasks: "Share section…" opens the existing explicit import (new identities).
    if (sel?.eligibility === "ineligible" && sel.reason !== "legacy-tasks")
      return disabled(
        sel.reason === null ? "" : selectionReasonText(sel.reason, (sel.line ?? sel.fromLine) - 1),
      );
    if (ctx.cursor === "inside-section") return disabled("The cursor is inside a shared section.");
    if (d.f.setup) return disabled(d.f.setup.reason);
    if (d.reading) return disabled(OPEN_TO_SHARE);
    return guarded(shareNeeds, () => ENABLED)(d);
  },
  "share-whole-section": (d) => {
    const sel = d.f.context.selection;
    if (sel?.eligibility !== "ineligible") return HIDDEN;
    if (sel.fallback === null)
      return disabled("No single heading's section contains the selection.");
    if (d.running !== null) return disabled(BUSY);
    if (d.reading) return disabled(OPEN_TO_SHARE);
    return guarded(shareNeeds, () => ENABLED)(d);
  },
  "insert-into-note": (d) => {
    // A joined section's next step goes into the note in view (LFCP-03-015): there must be one.
    if (d.next === "insert-into-note")
      return d.running?.kind === "join" && !d.noteOpen && d.f.insertIntoNoteInView === true
        ? disabled("Open a note to insert the section into.")
        : ENABLED;
    if (d.flow?.kind === "insert" && d.flow.outcome === "unknown")
      return disabled("This note already has a section being inserted. Finish that first.");
    if (d.flow?.kind === "insert" && d.flow.outcome === "unfinished")
      return disabled("An insert into this note is unfinished: continue it.");
    if (d.running !== null) return disabled(BUSY);
    if (d.f.section === null && (d.f.registry.sections ?? 0) === 0) return HIDDEN;
    return guarded({}, () => ENABLED)(d);
  },
  "check-result": (d) => (d.flow?.outcome === "unknown" ? ENABLED : HIDDEN),
  "continue-flow": (d) =>
    d.flow?.outcome === "unfinished" || (d.f.unfinished?.length ?? 0) > 0 ? ENABLED : HIDDEN,
  "open-for-editing": (d) => (d.reading ? ENABLED : HIDDEN),
  // Setup incomplete; or the share preview's sync server, changed only in the settings (LFCP-03-014).
  "open-settings": (d) => (d.f.setup || sharing(d) ? ENABLED : HIDDEN),
  // D10: an action that does not apply here is hidden, not disabled.
  "copy-readable": (d) => (inSection(d) ? ENABLED : HIDDEN),
  // The section at the cursor of the captured note, every binding kept: pasted, another copy of it.
  "copy-shared-section": (d) => (inSection(d) ? ENABLED : HIDDEN),
  // I4: ready means hosted, with access current; inviting comes from the access list.
  invite: (d) => {
    // A4: the invitation under way (its dialog) is the one; a second one is not started from here.
    if (d.flow?.kind === "invite" && d.flow.outcome === "running" && d.flow.dialog === true)
      return disabled("An invitation is open. Finish it in its dialog.");
    if (d.next === "invite") return ENABLED;
    const s = d.f.section;
    if (s === null) return HIDDEN;
    const v = s.view;
    if (d.running !== null) return disabled(BUSY);
    if (s.canInvite === false) return disabled("You can't invite others to this section.");
    // The chain this device holds may still grant what the server no longer accepts.
    if (NOT_ACCEPTED.has(v.access.access))
      return disabled("Inviting needs the server to accept this vault's access to this section.");
    if (s.hosting === "pending")
      return disabled("Not on its server yet: nobody can join until it is hosted.");
    if (s.canInvite === null || v.access.current !== true || v.access.checking)
      return disabled(INVITE_WAITS);
    return guarded({ writes: true }, () => ENABLED)(d);
  },
  "open-details": ofSection(() => ENABLED),
  "sync-details": ofSection((d, s) =>
    s.view.sync.queue.batches > 0 || d.kinds.has("offline") ? ENABLED : HIDDEN,
  ),
  "review-local-changes": ofSection((_d, s) =>
    s.view.held.some((h) => ACCESS_HELD.has(h.cause)) ? ENABLED : HIDDEN,
  ),
  "review-conflicts": ofSection((d, s) =>
    d.kinds.has("structural-conflict") ||
    d.kinds.has("scalar-conflict") ||
    s.view.conditions.some((c) => c.kind === "stale-work" && c.review > 0)
      ? ENABLED
      : HIDDEN,
  ),
  "repair-sections": ofSection((d, s) => {
    const v = s.view;
    const repair =
      v.held.some((h) => REPAIR_HELD.has(h.cause)) ||
      v.conditions.some(
        (c) =>
          c.kind === "source" &&
          (c.source === "binding-error" ||
            c.source === "base-unknown" ||
            (c.source === "diverged" && !v.held.some((h) => h.projectionId === c.projectionId))),
      );
    if (!repair) return HIDDEN;
    if (d.next === "repair-sections" || (d.running === null && !d.reading)) return ENABLED;
    if (d.running !== null) return disabled(BUSY);
    return disabled("Open the note for editing to repair it.");
  }),
  // A problem row's own button and the pane's primary when a marker is restorable: never a menu entry.
  "restore-marker": () => HIDDEN,
  "go-to-problem": ofSection((_d, s) =>
    s.view.held.some((h) => h.cause === "unsupported" || REPAIR_HELD.has(h.cause)) ||
    s.view.conditions.some((c) => c.kind === "source" && c.source === "unsupported")
      ? ENABLED
      : HIDDEN,
  ),
  // Destructive: secondary, each with its existing confirmation (A1).
  // By the access list's guards, the card's (LFCP-03-019): applicable unless this vault surely
  // may remove nobody's access; enabled only when it surely may, now. The card asks whom.
  "remove-access": ofSection((d, s) => {
    if (s.canRemove === false) return HIDDEN;
    if (NOT_ACCEPTED.has(s.view.access.access))
      return disabled(
        "Removing access needs the server to accept this vault's access to this section.",
      );
    if (s.view.connection !== "connected")
      return disabled("Removing access needs a connection to the section's server.");
    if (s.removeNote !== undefined && s.removeNote !== null) return disabled(s.removeNote);
    if (s.canRemove !== true || s.view.access.current !== true || s.view.access.checking)
      return disabled(
        "Removing access waits until this device has checked access with the server.",
      );
    return guarded({ writes: true }, () => ENABLED)(d);
  }),
  "discard-local-copy": ofSection((_d, s) =>
    s.view.held.some((h) => ACCESS_HELD.has(h.cause)) ? ENABLED : HIDDEN,
  ),
  // Technical details (§2): the card's button and the palette's command, never a pane entry.
  "resource-status": () => HIDDEN,
  "detach-section": ofSection((d) => {
    if (d.f.context.cursor !== "inside-section") return HIDDEN;
    if (d.reading) return disabled("Open the note for editing to detach it.");
    if (d.kinds.has("loading"))
      return disabled("Detaching waits until this section has loaded on this device.");
    return ENABLED;
  }),
};

/**
 * The order the pane lists its secondary actions in: the context's own
 * actions first, then the section's, the destructive ones last.
 */
export const DESCRIPTOR_ORDER: readonly ActionId[] = [
  "join-with-link",
  "share-section",
  "share-whole-section",
  "insert-into-note",
  "check-result",
  "continue-flow",
  "open-for-editing",
  "open-settings",
  "copy-readable",
  "copy-shared-section",
  "invite",
  "open-details",
  "sync-details",
  "review-local-changes",
  "review-conflicts",
  "repair-sections",
  "restore-marker",
  "go-to-problem",
  "remove-access",
  "discard-local-copy",
  "detach-section",
  "resource-status",
];

export const DESCRIPTORS: Readonly<Record<ActionId, ActionDescriptor>> = Object.fromEntries(
  DESCRIPTOR_ORDER.map((id) => [
    id,
    {
      id,
      label: ACTIONS[id].label,
      destructive: ACTIONS[id].destructive,
      availability: (f: ActionFacts) => RULES[id](derive(f)),
    },
  ]),
) as Record<ActionId, ActionDescriptor>;

/** Every action that applies in a context, in DESCRIPTOR_ORDER, with its availability. */
export function availabilities(f: ActionFacts): Map<ActionId, Availability> {
  const d = derive(f);
  const out = new Map<ActionId, Availability>();
  for (const id of DESCRIPTOR_ORDER) {
    const a = RULES[id](d);
    if (a.kind !== "hidden") out.set(id, a);
  }
  return out;
}
