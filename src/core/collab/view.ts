// What the Resource status view shows (LFCP-065), as label/value rows, for
// any editor adapter. Non-secret fields only: Resource and Principal IDs,
// heads, epochs and URLs are public; no key, DEK or invitation secret ever
// reaches a ResourceStatus.
//
// The server, the Principal and the owner are kept apart (decision 6): the
// server only relays, this device's identity is a key pair, and the owner
// is whoever created the collaboration (or received it by transfer).

import type { ResourceStatus } from "./service";

export interface StatusRow {
  readonly label: string;
  readonly value: string;
}

export interface StatusView {
  readonly title: string;
  /** A blocking state, shown above everything else (control_conflict). */
  readonly banner: string | null;
  readonly rows: readonly StatusRow[];
}

const SYNC: Readonly<Record<ResourceStatus["state"], string>> = {
  available: "In sync",
  offline: "Offline: changes are kept on this device and sent when the server is reachable",
  locked: "Writing is paused on this device",
  error: "Sync error: retrying",
  control_conflict: "Blocked",
};

export function statusView(s: ResourceStatus): StatusView {
  const you = s.participants.find((p) => p.you);
  const owner = s.participants.find((p) => p.owner);
  const people = s.participants
    .filter((p) => p.invitation === undefined)
    .map(
      (p) =>
        `${p.id}${p.you ? " (you)" : ""}: ${p.owner ? "owner" : p.abilities.join(", ") || "no access"}`,
    );
  const invitations = s.participants
    .filter((p) => p.invitation !== undefined)
    .map((p) => `${p.id}: ${p.invitation?.used} of ${p.invitation?.limit} used`);
  const rows: StatusRow[] = [
    { label: "Name on this device", value: s.localName ?? "(none)" },
    { label: "Resource ID", value: s.resourceId },
    { label: "Profile", value: s.profile },
    { label: "Sync", value: `${SYNC[s.state]} (${s.phase.toLowerCase().replace(/_/g, " ")})` },
    {
      label: "Hosting",
      value:
        s.hosting === "hosted"
          ? "Hosted on the server"
          : s.hosting === "pending"
            ? "Not hosted yet: only on this device"
            : "Unknown",
    },
    {
      label: "Server (relays only; not your identity, not the owner)",
      value: s.coordinator ?? s.endpoints[0] ?? "(none)",
    },
    {
      label: "Owner",
      value: owner === undefined ? "(unknown)" : `${owner.id}${owner.you ? " (you)" : ""}`,
    },
    {
      label: "Your access",
      value: you === undefined ? "none recorded" : you.owner ? "owner" : you.abilities.join(", "),
    },
    { label: "Participants", value: people.join("; ") || "(none)" },
    { label: "Open invitations", value: invitations.join("; ") || "(none)" },
    {
      label: "Control Head",
      value:
        s.controlHead === null
          ? "(none)"
          : `${s.controlHead.slice(0, 16)}… (#${s.controlSeq ?? "?"})`,
    },
    { label: "Data Epoch", value: s.dataEpoch ?? "(unknown)" },
    { label: "Waiting to send", value: String(s.pendingOutbound) },
    {
      label: "Conflicts",
      value:
        s.conflicts.length === 0
          ? "none"
          : s.conflicts.map((c) => `${c.title}: ${c.fields.join(", ")}`).join("; "),
    },
    ...(s.blockedCollaborators === undefined
      ? []
      : [
          {
            label: "Edits that cannot be applied here",
            value:
              s.blockedCollaborators.length === 0
                ? "none"
                : s.blockedCollaborators
                    .map(
                      (b) =>
                        `${b.id}: ${b.units} change${b.units === 1 ? "" : "s"} (${b.reasons.join(", ")})`,
                    )
                    .join("; "),
          },
        ]),
  ];
  return {
    title: s.localName ?? "Collaboration",
    banner: s.blocked
      ? "This collaboration's history has forked (control conflict). It is NOT in sync: sharing, invitations and other changes to who can access it are blocked until the owner resolves it."
      : null,
    rows,
  };
}
