// The state card's words (UXD-11, UX-08; mock pane-states.html): for the
// section the pane is about, one status word with its icon and ONE line of
// fact. Everything else (caveats, times, the server, identifiers, what a
// change does) is the details card's (`open-details`). Pure: a StatusView
// in, words out.
//
// The words are the details card's own (status/card.ts), cut to a line; no
// new claim is made here. "Synced" is said only when the section is current
// as last checked (`sync.current`, contract §6) and nothing is held, queued
// or unchecked; the caveat that this does not mean others have seen it is
// the details card's sentence.

import { offlineText, sectionProblems } from "../status/card";
import { type HeldEdits, heldCauseText } from "../status/held";
import {
  type Condition,
  NOT_CHECKED_LABEL,
  type StatusState,
  type StatusView,
} from "../status/reducer";
import { STATUS_ICONS } from "./icons";

/** How a card or a row reads at a glance: a problem, work under way, quiet, or fine. */
export type FaceTone = "ok" | "problem" | "busy" | "muted" | "info";

/** A status word with its icon. */
export interface StatusWord {
  readonly word: string;
  /** A Lucide name (icons.ts STATUS_ICONS). */
  readonly icon: string;
  readonly tone: FaceTone;
}

/** What the card says about a section. */
export interface SectionFace extends StatusWord {
  /** The one line; null: nothing to add to the word. */
  readonly fact: string | null;
  /** A problem owns the card (it is drawn as one). */
  readonly problem: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const word = (w: string, tone: FaceTone, icon: string): StatusWord => ({ word: w, icon, tone });

/** The first sentence of a text (the rest is for the details card). */
const lead = (text: string): string => /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;

/** The conditions that are problems, as the details card lists them (status/card.ts problemText). */
const PROBLEM_KINDS: ReadonlySet<Condition["kind"]> = new Set([
  "save-failed",
  "access",
  "server-refused",
  "invalid-profile",
  "stale-work",
  "rejected",
  "source",
  "held-unknown",
  "structural-conflict",
  "scalar-conflict",
]);

/** Whether the section has a problem to show (the card's problems and held edits, as the details card). */
export function hasProblem(v: StatusView): boolean {
  return v.held.length > 0 || sectionProblems(v).length > 0;
}

/** One copy's held edits as a line: "3 edits not sent: the section's start or end marker is damaged." */
function heldLine(held: readonly HeldEdits[]): string {
  const h = [...held].sort((a, b) => (b.count ?? 1) - (a.count ?? 1))[0];
  if (h === undefined) return "";
  return `${h.count === null ? "Edits" : plural(h.count, "edit")} not sent: ${heldCauseText(h)}.`;
}

/** Said after a removal or non-membership that this device has not seen confirmed now (§6). */
const AS_VERIFIED = " As last verified; it may have changed.";

/** Conditions whose word the held edits' own line says better (F-04): the edits are what the user stands to lose. */
const HELD_SPEAKS: ReadonlySet<Condition["kind"] | undefined> = new Set([
  "access",
  "server-refused",
  "source",
  "rejected",
  undefined,
]);

function problemFace(v: StatusView, c: Condition | undefined): SectionFace {
  const held = v.held.length > 0 && HELD_SPEAKS.has(c?.kind);
  // Edits held in a note are never hidden behind a server's answer: counted, with their cause.
  const face = (w: StatusWord, fact: string): SectionFace => ({
    ...w,
    fact: held ? heldLine(v.held) : fact,
    problem: true,
  });
  const warn = (w: string) => word(w, "problem", STATUS_ICONS.problem);
  const first = lead(sectionProblems(v)[0] ?? "");
  switch (c?.kind) {
    case "save-failed":
      return face(
        warn("Not saved"),
        "Some local changes are not safely saved. Keep the note open.",
      );
    case "access":
      if (c.access === "revoked")
        return face(
          warn("No access"),
          `Your access to this section was removed.${v.access.current === true ? "" : AS_VERIFIED}`,
        );
      if (c.access === "not-member")
        return face(
          warn("No access"),
          `This vault is not a member of this section.${v.access.current === true ? "" : AS_VERIFIED}`,
        );
      if (c.access === "refused") return face(warn("Not accepted"), first);
      return face(word("Waiting for key", "busy", STATUS_ICONS.busy), first);
    case "server-refused":
      return c.code === "RESOURCE_NOT_HOSTED"
        ? face(
            warn("Not on server"),
            "This section is not on its server, so nobody else gets its changes.",
          )
        : face(warn("Not accepted"), first);
    case "invalid-profile":
      return face(warn("Not valid"), first);
    case "rejected":
      return face(warn("Not accepted"), first);
    case "stale-work":
      return c.review > 0
        ? face(
            warn("Needs review"),
            `${plural(c.review, "offline edit")} could not be sent after an access change.`,
          )
        : face(
            word("Sending again", "busy", STATUS_ICONS.busy),
            `${plural(c.pending, "offline edit")} from before an access change ${c.pending === 1 ? "is" : "are"} being sent again.`,
          );
    case "source":
      return face(warn("Not syncing"), first);
    case "held-unknown":
      return face(warn("Not current"), first);
    case "structural-conflict":
    case "scalar-conflict":
      return face(warn("Conflict"), first);
    default:
      // Edits held for a reason no condition carries (typing in a read-only section).
      return face(warn("Not syncing"), heldLine(v.held));
  }
}

/** The pending local updates, as a line. */
function waiting(v: StatusView): string {
  return v.pendingCounted
    ? `${plural(v.pendingBatches, "local update")} waiting to be sent.`
    : "Local updates waiting to be sent.";
}

function progressFace(v: StatusView, c: Condition): SectionFace {
  const busy = (w: string, fact: string): SectionFace => ({
    ...word(w, "busy", STATUS_ICONS.busy),
    fact,
    problem: false,
  });
  const quiet = (w: StatusWord, fact: string): SectionFace => ({ ...w, fact, problem: false });
  switch (c.kind) {
    case "loading":
      return busy("Loading", "Loading this section on this device.");
    case "access-checking":
      return busy("Checking access", "Access is being checked with the server.");
    case "held-unchecked":
      return busy("Checking", "Checking your notes for edits not sent.");
    case "connecting":
      return busy("Connecting", "Connecting to the server; not checked with it yet.");
    case "catching-up":
      return busy("Receiving", "Receiving changes from the server.");
    case "local-edit":
      return busy("Saving", "Local changes are being saved.");
    case "offline":
      // Not checked is not offline (§6 F4): without a transition nothing says "Offline".
      if (v.connection === "failed")
        return quiet(word("Not connected", "muted", STATUS_ICONS.offline), offlineText(v));
      if (v.connectionQualifier === "no-evidence")
        return quiet(word("Not checked", "muted", STATUS_ICONS.idle), offlineText(v));
      return quiet(
        word("Offline", "muted", STATUS_ICONS.offline),
        v.pendingBatches > 0 ? waiting(v) : offlineText(v),
      );
    case "pending":
      return busy("Sending", waiting(v));
    case "control-pending":
      return busy("Pending", "A change to who has access is waiting for the server.");
    case "evidence-unavailable":
      return quiet(
        word("Unconfirmed", "info", STATUS_ICONS.problem),
        "The server did not confirm it stored some updates.",
      );
    default:
      return quiet(word("Not current", "muted", STATUS_ICONS.idle), v.label);
  }
}

export interface SectionFaceInput {
  /** What this device's share of it came to, as a line (model.ts sharedLine); null: not shared from here this session. */
  readonly shared: string | null;
  /** On this device only: not on its sync server yet (hosting). */
  readonly local: boolean;
  /** Loaded, and inserted in no note (after the placement index is complete). */
  readonly unplaced: boolean;
}

/** The card's status word and one line of fact for a section: a problem first, else progress, else quiet. */
export function sectionFace(v: StatusView, o: SectionFaceInput): SectionFace {
  if (hasProblem(v)) {
    const c = v.conditions.find((x) => PROBLEM_KINDS.has(x.kind));
    return problemFace(v, c);
  }
  const first = v.conditions[0];
  if (first !== undefined) return progressFace(v, first);
  if (o.local)
    return {
      ...word("On this device only", "info", STATUS_ICONS.offline),
      fact: o.shared ?? "Not on its sync server yet: nobody can join until it is hosted.",
      problem: false,
    };
  if (!v.sync.current)
    return {
      ...word("Not current", "muted", STATUS_ICONS.idle),
      fact: v.label,
      problem: false,
    };
  if (o.unplaced)
    return {
      ...word("Not in a note", "muted", STATUS_ICONS.idle),
      fact: "Not inserted yet.",
      problem: false,
    };
  if (v.readOnly)
    return {
      ...word("Read-only", "info", STATUS_ICONS["read-only"]),
      fact: "You can read this section, not edit it.",
      problem: false,
    };
  return {
    ...word("Synced", "ok", STATUS_ICONS.synced),
    fact: o.shared ?? "Current as last checked with the server.",
    problem: false,
  };
}

/** A section list row's status word: the state as the row's label says it (RegistryRow, StatusView.label). */
export function rowWord(state: StatusState | null, label: string | null | undefined): StatusWord {
  if (state === null) return word("status unknown", "muted", STATUS_ICONS.unknown);
  // The label says more than the state where nothing is current yet (no evidence, checking, connecting).
  if (label === NOT_CHECKED_LABEL) return word("not checked", "muted", STATUS_ICONS.idle);
  if (label === "Checking notes for edits not sent")
    return word("checking", "busy", STATUS_ICONS.busy);
  if (label === "Connecting to the server") return word("connecting", "busy", STATUS_ICONS.busy);
  if (label === "Access being checked with the server")
    return word("checking access", "busy", STATUS_ICONS.busy);
  if (label?.startsWith("Could not connect") === true)
    return word("not connected", "muted", STATUS_ICONS.offline);
  switch (state) {
    case "CURRENT":
      return word("synced", "ok", STATUS_ICONS.synced);
    case "READ_ONLY_CURRENT":
      return word("read-only", "info", STATUS_ICONS["read-only"]);
    case "LOADING":
      return word("loading", "busy", STATUS_ICONS.busy);
    case "LOCAL_EDIT":
      return word("saving", "busy", STATUS_ICONS.busy);
    case "LOCAL_DURABLE":
      return word("pending", "busy", STATUS_ICONS.busy);
    case "SENDING":
      return word("sending", "busy", STATUS_ICONS.busy);
    case "ACCEPTED_CATCHING_UP":
      return word("receiving", "busy", STATUS_ICONS.busy);
    case "OFFLINE":
      return word("offline", "muted", STATUS_ICONS.offline);
    case "EVIDENCE_UNKNOWN":
      return word("unconfirmed", "info", STATUS_ICONS.unknown);
    case "ATTENTION":
      return word("needs attention", "problem", STATUS_ICONS.problem);
    case "LOCAL_SAVE_FAILED":
      return word("not saved", "problem", STATUS_ICONS.problem);
  }
}
