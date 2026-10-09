// Who has access to a shared section, as the card shows it (LFCP-02-060,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §6 "Access list", §7; SI14, SI15, SI18).
// Pure. Only the validated Control state speaks: identities are device
// Principals (a local alias is a label of this device, never a verified
// name), invitations and pending changes are not access, and an unknown or
// stale view says so instead of listing an authoritative membership.

export interface AccessParticipant {
  /** Public Principal ID, shortened: the identity detail shown with an alias. */
  readonly id: string;
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
      ? `Access as last verified ${input.time(mine.verifiedAt as number)}; it may have changed.`
      : `Access verified with the server ${input.time(mine.verifiedAt as number)}.`;
  const mayRevoke = mine?.abilities.includes("capability/revoke") === true;
  const rows: AccessRow[] = unknown
    ? []
    : input.participants
        .filter((p) => p.invitation === undefined)
        .map((p) => ({
          id: p.id,
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
  };
}
