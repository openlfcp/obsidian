// The pane's short tips and first-use help (LFCP-03-021; UX contract §5.3;
// OBSIDIAN-CONTEXTUAL-UX-03 §2 "Help"). Pure: which tip the pane shows for
// what it shows now, and which tips this vault has hidden.
//
// - A tip explains what an action does at the moment it is offered. It
//   never states a status, and never claims that anyone received or saw
//   anything (§10).
// - At most one tip at a time, and none while a problem or a flow holds the
//   pane: problems, held edits, the effects of a change (C6) and the
//   invitation's one-time-link sentence (I1) are not tips and cannot be hidden.
// - "Hide tip" hides one tip in this vault (its ID in the plugin's settings,
//   data.json); "Show tips again" brings every hidden one back. Nothing is
//   sent anywhere; no tour opens on its own.
// - A tip's ID names its meaning: a tip whose meaning changes gets a new ID,
//   so a vault that hid the old one sees the new one once.

import { ACTIONS, type ActionId } from "../actions/catalog";

export const HINT_IDS = [
  "share-preview",
  "insert-copies",
  "invite-link",
  "section-copy",
  "first-use",
] as const;

export type HintId = (typeof HINT_IDS)[number];

export function isHintId(value: unknown): value is HintId {
  return HINT_IDS.includes(value as HintId);
}

const label = (id: ActionId) => ACTIONS[id].label;

/** Each tip's words. */
export const HINTS: Readonly<Record<HintId, string>> = {
  "share-preview": `${label("share-section")} makes this part of the note a shared section. People you invite insert it into a note of their own; each note keeps a copy, and the copies are synced through the sync server shown here.`,
  "insert-copies": `${label("insert-into-note")} adds a copy of this section to the note you choose. The rest of that note stays private. You can insert the same section into more notes later.`,
  "invite-link": `${label("invite")} makes a one-time link for this section. Shared Tasks does not send it: pass it on yourself, for example in a chat.`,
  "section-copy":
    "Text inside this section is shared; text outside it stays in this note only. The ✓✓ mark means the section is shared, not that anyone has seen your edits.",
  "first-use": `To share part of a note, put the cursor on its heading and choose ${label("share-section")} The heading and every line under it are shared, also lines added there later; comments stay on this device by default. To use a section someone shared with you, choose ${label("join-with-link")} and paste their invitation link.`,
};

export const HIDE_HINT = "Hide tip";
export const SHOW_HINTS = "Show tips again";

/** What the pane shows now, as far as the choice of a tip needs it. */
export interface HintContext {
  /** A problem line, a problem row or a held edit is shown: no tip. */
  readonly problem: boolean;
  /** A running flow, or one whose result is unknown, owns the current area: no tip. */
  readonly flow: boolean;
  /** A share preview is shown. */
  readonly preview: boolean;
  /** The primary action, enabled; null: none or disabled. */
  readonly primary: ActionId | null;
  readonly cursor: "none" | "private-heading" | "private-text" | "inside-section";
  /** The section list is read and holds no section. */
  readonly empty: boolean;
}

/** The tips that apply now, the most specific first. */
function applicable(c: HintContext): HintId[] {
  if (c.problem || c.flow) return [];
  const out: HintId[] = [];
  if (c.preview && c.primary === "share-section") out.push("share-preview");
  if (c.primary === "insert-into-note") out.push("insert-copies");
  if (c.primary === "invite") out.push("invite-link");
  if (c.cursor === "inside-section") out.push("section-copy");
  if (c.empty) out.push("first-use");
  return out;
}

/** The one tip to show: the first that applies and is not hidden; null: none. */
export function paneHint(c: HintContext, hidden: readonly string[]): HintId | null {
  return applicable(c).find((id) => !hidden.includes(id)) ?? null;
}

/** How many of the known tips this vault has hidden (IDs of another version do not count). */
export function hiddenHints(hidden: readonly string[]): number {
  return HINT_IDS.filter((id) => hidden.includes(id)).length;
}

/** `hidden` with `id` added, once. */
export function hideHint(hidden: readonly string[], id: HintId): string[] {
  return hidden.includes(id) ? [...hidden] : [...hidden, id];
}
