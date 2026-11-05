# A person's devices (LFCP-04-413)

Normative: IDENTITY-PROFILE-01 §§5–8 and §10 at `mvp-0.4-baseline.1`;
decisions I2–I6 (root on the first device, any managing device adds
devices, simple revocation with the owner's rotation, no recovery kit,
presets Full / Edit / Read / Service). The flows, records, journals and
key packages are the SDK's (`@openlfcp/client` 0.3.0, identity flows); the
plugin calls them and says what each result means.

## Modules

| Module | What |
|---|---|
| `src/core/identity/service.ts` | `DeviceService`: the flows for this installation (keys, storage, the default server, the roster from the registry). Obsidian-free. |
| `src/core/identity/flows.ts` | The SDK flows as one port, so every result kind is tested without a server. |
| `src/core/identity/pairing-view.ts` | Every result kind as an outcome (done, finish, retry, reconfirm, stop) and its words. |
| `src/core/identity/device-list.ts` | The person's devices from the Identity Resource's validated Control state. |
| `src/core/identity/document.ts` | The document port over `IdentityReplica`. |
| `src/obsidian/ui/devices.ts` | The dialogs: Add my other device, Your devices, Remove device, Pair this device. |

## Managing side

"Add my other device…":

1. Before the first pairing, the warning of `compat.ts` (LFCP-04-411), with
   each section's server asked whether it supports devices (`READY`,
   `identity-01`).
2. The first time, the person's device list (the Identity Resource, §5.1)
   is created on the default server from this vault's shared sections. A
   server without device support stops here, nothing changed.
3. A pairing session and its link (§5.3 step 1). The link is a bearer
   secret: a `PairingLinkText`, revealed only by "Show link" or "Copy
   link". An open session is shown again rather than a second one made;
   "Cancel link" ends it.
4. The dialog asks for requests every 4 s. A request shows its name,
   platform, the new device's fingerprint to compare with the other
   screen, the presets whose future chain passes (the others with why),
   and for a service its sections, which may be narrowed and not widened.
   "Approve" waits for "The fingerprints match". Several requests on one
   link are listed by fingerprint with a warning (a leaked link).
5. The result, by kind:

| Kind | Shown |
|---|---|
| `approved` | done; sections not reached yet, on a server without device support, or refused are listed |
| `document-incomplete` | **not success**: "approved, but … not finished", with **Finish** (`resumeApproval`) |
| `limit` | remove a device, then Finish |
| `reconfirm` | the request again, to compare the fingerprint again |
| `infeasible`, `superseded`, `refused`, `conflict` | why; nothing more is signed here |
| `unavailable` | Finish when online (when an operation exists) |

Reject and Cancel link: `cancelled`; `document-incomplete` (the request
stays in the list) and `unavailable` offer the same call again;
`consumed` says it was already approved.

"Your devices…" lists the first device, this device and the others with
their access (Full, Edit, Read, Service), state (active, suspended,
removed) and fingerprint, by the labels the device list holds (kept for
offline, and used for the reader's own devices in the access list and
notices). When this device manages devices:

- **Remove device…**: the §8.1 preview first (devices the cascade
  suspends, offered for re-certification; sections whose key someone
  else changes; a device whose own access passes through it is blocked),
  then the reason (no longer used, lost, someone else may have it). A
  result whose display flag (`document`) was refused or unreachable
  offers **Try again** with its operation. Offline, removal is refused.
- **Re-certify** a suspended device: the same kind, access and scope
  (N8), signed through this device and registered where it may act.
- Unfinished approvals and removals, from the SDK's journal.

## New device's side

"Pair this device with a link…" makes this vault a device of the person
whose device shows the link. A vault that already shares sections under
its own identity is refused (its Principal is a person in those
sections). The link field is a password field. The dialog shows this
device's fingerprint and asks for the result every 4 s; the result comes
from the chain only (a timeout is never a decision). Each section of the
roster gets its §6 status (ready, waiting for keys, waiting to be added,
not granted, approval not provable here, unreachable, on a server without
device support); a ready one is stored and opened here
(`Collaboration.openFromRoster`) and can be inserted into a note as a
joined section is. Closing keeps the request; the command shows it again.

A section the server refuses to this device is shown in "Your devices…"
as "removed from your identity" when the SDK proves it (§8.6), else as
"no longer has access". The notes keep their copy; nothing is deleted.

## Mobile

Read-only on mobile (V3) stays: a phone approved with Edit holds
`data/write` and writes nothing until V3 is lifted. The approve dialog
says so for a phone.
