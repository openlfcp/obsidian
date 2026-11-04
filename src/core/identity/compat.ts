// The compatibility warning before a human's first pairing (LFCP-04-411;
// IDENTITY-PROFILE-01 §11, LFCP-WIRE-01 §100.1). Pairing binds the new
// device in every shared Resource of the human whose server supports
// devices (§5.3 step 10, §7.1): that record is the Resource's barrier, and
// a collaborator whose client predates identity-01 stops syncing it until
// they update (a herald release says so; an older one shows a chain
// error). An identity-aware collaborator sees the new device under its
// person, not as a new participant. A server without identity-01 is not
// changed now; the device reaches its Resources once it is updated, and the
// same then applies there.
//
// Nobody's client version is visible to this device, so the warning names
// every section shared with someone else; a section only its owner uses
// changes for no one. Pure: the facts are gathered by `pairingSections`.

import type { Participant } from "../collab/service";

/** A shared section (or 0.1 collaboration) of the human, as the warning reads it. */
export interface PairingSection {
  /** Its name on this device, or its shared title. */
  readonly name: string;
  /** People other than the reader's person with access (invitations are not people yet); null while not known. */
  readonly others: number | null;
  /** Whether its server advertises identity-01 (W §37); null while not known. */
  readonly identityServer: boolean | null;
}

/** The warning, in the shape of a confirmation (title, text, the action that goes ahead). */
export interface PairingWarning {
  readonly title: string;
  readonly message: string;
  readonly action: string;
  /** Sections whose collaborators on older versions stop syncing them until they update. */
  readonly affected: readonly string[];
  /** Sections whose server support is not known yet: affected if it has it. */
  readonly unknown: readonly string[];
  /** Sections on a server without device support: not changed now, reached once it is updated. */
  readonly later: readonly string[];
}

const label = (s: PairingSection) =>
  s.others === null
    ? `"${s.name}" (who uses it is not known yet)`
    : `"${s.name}" (${s.others} ${s.others === 1 ? "other person" : "other people"})`;

/**
 * The warning before the first pairing, or null when there is nothing to
 * warn about: not the first pairing (the human already has an identity,
 * §5.1), or no section is shared with anyone else.
 */
export function firstPairingWarning(input: {
  /** No Identity Resource exists for this human yet (IDENTITY-PROFILE-01 §5.1). */
  readonly firstPairing: boolean;
  readonly sections: readonly PairingSection[];
}): PairingWarning | null {
  if (!input.firstPairing) return null;
  // Not known is treated as shared: a warning too many, never one missing.
  const shared = input.sections.filter((s) => s.others === null || s.others > 0);
  if (shared.length === 0) return null;
  const affected = shared.filter((s) => s.identityServer === true).map(label);
  const unknown = shared.filter((s) => s.identityServer === null).map(label);
  const later = shared.filter((s) => s.identityServer === false).map(label);
  const parts = [
    "Adding a device changes your shared sections so that the new device can open them.",
    "Anyone who uses them with an older version of Shared Tasks stops syncing them until they update the plugin. Once updated, they see your new device under your name, not as a new participant.",
  ];
  if (affected.length > 0) parts.push(`Shared with others: ${affected.join(", ")}.`);
  if (unknown.length > 0)
    parts.push(
      `Not known yet whether their server supports devices (the same applies if it does): ${unknown.join(", ")}.`,
    );
  if (later.length > 0)
    parts.push(
      `Their server does not support devices yet, so they are not changed now; your new device reaches them once the server is updated, and the same applies then: ${later.join(", ")}.`,
    );
  parts.push("Consider telling your collaborators before you continue.");
  return {
    title: "Before you add your first other device",
    message: parts.join(" "),
    action: "Continue",
    affected,
    unknown,
    later,
  };
}

/** What `pairingSections` needs: the human's shared Resources and their status. */
export interface PairingSectionSource {
  /** The shared Resources of this device, with the name each is shown by. */
  readonly resources: () => Promise<
    readonly { readonly resourceId: string; readonly name: string }[]
  >;
  /** A Resource's participants and server (the collaboration status). */
  readonly status: (resourceId: string) => Promise<{
    readonly participants: readonly Participant[];
    readonly coordinator: string | null;
  }>;
  /** Whether a server advertises identity-01, when known (READY, W §37). */
  readonly identityServer: (url: string) => boolean | null;
}

/**
 * The facts of the warning: per Resource, the people other than the
 * reader's (by person, §10: the reader's own devices are not others) and
 * its server's support. A Resource whose status cannot be read is kept,
 * with both not known, never left out.
 */
export async function pairingSections(src: PairingSectionSource): Promise<PairingSection[]> {
  const out: PairingSection[] = [];
  for (const r of await src.resources()) {
    try {
      const s = await src.status(r.resourceId);
      out.push({
        name: r.name,
        others: s.participants.filter((p) => p.invitation === undefined && !p.you).length,
        identityServer: s.coordinator === null ? null : src.identityServer(s.coordinator),
      });
    } catch {
      out.push({ name: r.name, others: null, identityServer: null });
    }
  }
  return out;
}
