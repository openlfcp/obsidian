// Who has access to a shared section, as the card shows it (LFCP-02-060,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §6 "Access list", §7; SI14, SI15, SI18).
// Pure. Only the validated Control state speaks: identities are device
// Principals (a local alias is a label of this device, never a verified
// name), invitations and pending changes are not access, and an unknown or
// stale view says so instead of listing an authoritative membership.

export interface AccessParticipant {
  /** Public Principal ID, shortened: the identity detail shown with an alias. */
  readonly id: string;
  /** The full Principal ID (hex): the identity an action applies to. */
  readonly principal: string;
  readonly you: boolean;
  readonly owner: boolean;
  readonly abilities: readonly string[];
  /** An Invitation Principal: not anyone's access until claimed. */
  readonly invitation?: { readonly used: string; readonly limit: string };
}

/** This vault's own access state (the SDK's AccessState, the parts shown). */
export interface MyAccess {
  readonly allowed: boolean;
  readonly reason?: string;
  /** False while the Control view is behind the server's; null when no server reported yet. */
  readonly current: boolean | null;
  /** Local time (ms) the access was last validated; null without a validated chain. */
  readonly verifiedAt: number | null;
  readonly abilities: readonly string[];
  readonly owner: boolean;
  /** Our Control Records sent, not committed: their types. */
  readonly pendingControl: readonly string[];
}

export interface AccessInput {
  readonly participants: readonly AccessParticipant[];
  readonly mine: MyAccess | null;
  /** Local aliases by Principal ID: labels of this device only. */
  readonly aliases: Readonly<Record<string, string>>;
  readonly connected: boolean;
  /** How a validation time reads ("at 14:02"). */
  readonly time: (ms: number) => string;
}

export interface AccessRow {
  readonly id: string;
  readonly principal: string;
  /** "You", the local alias, or "Member <id>". */
  readonly label: string;
  /** The identity detail always shown next to an alias. */
  readonly detail: string;
  readonly role: "owner" | "can edit" | "can read";
  readonly you: boolean;
  /** Removing this identity's access may be offered (by our abilities; not ourselves, not the owner). */
  readonly removable: boolean;
}

export interface AccessView {
  readonly heading: string;
  readonly freshness: string;
  /** No validated view: no list is shown as if it were the membership. */
  readonly unknown: boolean;
  readonly rows: readonly AccessRow[];
  readonly invitations: readonly string[];
  readonly pending: readonly string[];
  readonly canInvite: boolean;
  /** Why inviting is not offered, when it is not. */
  readonly inviteNote: string | null;
  /** Why removing access is not available right now, when it would be offered otherwise (UX §7). */
  readonly removeNote: string | null;
}

const PENDING: Readonly<Record<string, string>> = {
  CAPABILITY_REVOKE: "Removing access: waiting for the server. It is not done yet.",
  CAPABILITY_GRANT: "An invitation is being recorded on the server.",
  EPOCH_ROTATE: "A new key for the section is being recorded on the server.",
};

export function accessView(input: AccessInput): AccessView {
  const mine = input.mine;
  const unknown = mine === null || mine.verifiedAt === null;
  const freshness = unknown
    ? "Access is unknown until this device checks with the server."
    : mine.current === false || !input.connected
      ? `Access as last verified ${input.time(mine.verifiedAt)}; it may have changed.`
      : `Access verified with the server ${input.time(mine.verifiedAt)}.`;
  const mayRevoke = mine?.abilities.includes("capability/revoke") === true;
  const rows: AccessRow[] = unknown
    ? []
    : input.participants
        .filter((p) => p.invitation === undefined)
        .map((p) => ({
          id: p.id,
          principal: p.principal,
          label: p.you ? "You" : (input.aliases[p.id] ?? `Member ${p.id}`),
          detail: p.id,
          role: p.owner ? "owner" : p.abilities.includes("data/write") ? "can edit" : "can read",
          you: p.you,
          removable: mayRevoke && !p.you && !p.owner,
        }));
  const invitations = unknown
    ? []
    : input.participants
        .filter((p) => p.invitation !== undefined)
        .map(
          (p) =>
            `Invitation ${p.id}: ${p.abilities.includes("data/write") ? "can edit" : "can read"}, used ${p.invitation?.used} of ${p.invitation?.limit}. Not access until someone joins with it.`,
        );
  const pending = (mine?.pendingControl ?? []).map(
    (t) => PENDING[t] ?? "A change to who has access is waiting for the server.",
  );
  const removalWaits =
    rows.some((r) => r.removable) &&
    (mine?.current !== true || !input.connected || mine.pendingControl.length > 0);
  const mayInvite = mine?.abilities.includes("capability/grant") === true;
  const canInvite = !unknown && mayInvite && mine?.current !== false;
  return {
    heading: "Identities with access",
    freshness,
    unknown,
    rows,
    invitations,
    pending,
    canInvite,
    inviteNote: canInvite
      ? null
      : unknown || mine?.current === false
        ? "Inviting waits until this device has checked access with the server."
        : "You can't invite others to this section.",
    removeNote: !removalWaits
      ? null
      : !input.connected
        ? "Removing access needs a connection to the section's server."
        : (mine?.pendingControl.length ?? 0) > 0
          ? "Removing access waits until this device's earlier access change is recorded by the server."
          : "Removing access waits until this device has checked access with the server.",
  };
}

/** The confirmation before removing access (UX §7). */
export const REMOVE_CONFIRMATION =
  "Remove future access to this shared section? Copies already received cannot be erased.";

/** A revocation's outcome as the SDK reports it (RevokeAccessResult, the parts shown). */
export type RevokeOutcome =
  | {
      readonly kind: "queued";
      readonly rotated: boolean;
      readonly remainingPaths: readonly {
        readonly issuer: string;
        readonly abilities: readonly string[];
      }[];
    }
  | { readonly kind: "refused"; readonly reason: string };

const REFUSED: Readonly<Record<string, string>> = {
  offline: "Removing access needs a connection to the section's server. Nothing was changed.",
  stale:
    "This device's view of who has access is behind the server's. Nothing was changed; try again once it has caught up.",
  "control-pending":
    "An earlier access change from this device is still waiting for the server. Nothing was changed; try again when it is recorded.",
  "would-remove-owner": "The owner's access can't be removed. Nothing was changed.",
  "not-member": "This identity has no access to remove. Nothing was changed.",
  "not-authorized": "You can't remove this identity's access. Nothing was changed.",
};

/**
 * What the user is told after "Remove access…": queued is not done (it waits
 * for the server, SI14); access kept through grants this vault cannot revoke
 * is said, not hidden; a refusal changed nothing.
 */
export function revokeMessage(outcome: RevokeOutcome, label: (issuer: string) => string): string {
  if (outcome.kind === "refused")
    return REFUSED[outcome.reason] ?? "Access could not be removed. Nothing was changed.";
  const parts = ["Removing access: waiting for the server. It is not done yet."];
  if (outcome.remainingPaths.length > 0) {
    const issuers = [...new Set(outcome.remainingPaths.map((p) => label(p.issuer)))];
    parts.push(
      `This identity keeps access through a grant you can't remove (from ${issuers.join(", ")}).`,
    );
  } else if (outcome.rotated)
    parts.push("Once recorded, new changes use a new key this identity does not get.");
  return parts.join(" ");
}
