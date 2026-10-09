// Invitation presets (LFCP-065): what "Read" and "Read + write" mean in
// LFCP abilities (LFCP-WIRE-01 §17.1). The SDK's createInvitation turns
// them into a CAPABILITY_GRANT with an explicit claim_limit (§18, G-CAP8).
//
// - Read: data/read. The claimant opens the Resource and decrypts it.
// - Read + write: data/read and data/write. Writing Shared Objects needs
//   nothing more: Data Units need data/write (§26.3), and the plugin
//   publishes no Snapshots, so snapshot/publish is not granted.
//
// invite/claim is the invitation itself (§18): the grant must include it,
// and the claimant does not keep it (it is not delegable here), so a
// collaborator cannot pass the link on to others.

import { ABILITY } from "@openlfcp/wire";

export type InvitePreset = "read" | "read-write";

export interface PresetSpec {
  readonly label: string;
  readonly description: string;
  /** The same for a shared section (MVP 0.2): it holds a section, not tasks. */
  readonly sectionDescription: string;
  /** The grant's abilities, invite/claim included. */
  readonly abilities: readonly bigint[];
}

export const INVITE_PRESETS: Readonly<Record<InvitePreset, PresetSpec>> = {
  read: {
    label: "Read",
    description: "Can see and sync the shared tasks, but not change them.",
    sectionDescription: "Can see and sync the shared section, but not change it.",
    abilities: [ABILITY.DATA_READ, ABILITY.INVITE_CLAIM],
  },
  "read-write": {
    label: "Read + write",
    description: "Can see, sync and change the shared tasks.",
    sectionDescription: "Can see, sync and change the shared section and its tasks.",
    abilities: [ABILITY.DATA_READ, ABILITY.DATA_WRITE, ABILITY.INVITE_CLAIM],
  },
};

/** G-CAP8: every invitation is one-time unless the user asks for more. */
export const DEFAULT_CLAIM_LIMIT = 1n;
