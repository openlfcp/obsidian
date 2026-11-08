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
4. The dialog asks for requests with a backoff (4 s, 8 s, 15 s, then
   every 30 s; from the start on "Check now", copying or showing the
   link). A request shows its name,
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

## Pace (decision I18)

Each call of an SDK identity flow opens its own connection, and a sync
server allows about 20 new connections a minute from one network (the
reference server's default). `src/core/identity/pacing.ts`: every
connection the device flows of one installation open takes a token from
one `ConnectionPacer` (a burst of 8, then 9 a minute), shared by all
dialogs (one `DeviceService` per runtime); a call waits for its turn
instead of being refused. The dialogs ask again with `POLL_BACKOFF_MS`.
Sections' sessions are not paced (one per server, long-lived).

## Upkeep

`DeviceService.upkeep` (§7.1, §8.4; decision I6) runs in the background
after start and whenever a section comes live (coalesced), and when "Your
devices…" opens:

- a device that manages the device list runs the SDK's `reconcileDevices`
  with the rotation policy: revocations and registrations carried into
  every roster section (a device an approval could not add, its server
  down or without `identity-01`, is added now), keys sent, and the key of
  each section with an exposing revocation changed where this device is
  the rotator (another device retired itself, or was removed by a device
  that may not change keys);
- any other section it holds where such a key change is due, typically as
  its owner, is rotated with `rotateIfExposed`, under an operation the
  upkeep journals and resumes.

It runs only when the stored chains show work, unless forced. "Your
devices…" lists what it still owes (a device not added yet, a key not
changed yet) with **Finish now**. A removal result names every section
whose key change was refused, unreachable or not passed on, and offers
**Try again**; re-certify says "re-certified" only once the device list
accepted the new certificate.

## Sections from a device that is not the first one (LFCP-04-413e)

- **Joining (§7.2).** On a device whose device list's root is another
  installation (`DeviceService.origin`), `Collaboration.join` accepts with
  the SDK's `acceptInvitationAsDevice`: the claim names the root; the
  device registers itself, seals the keys to the root (and registers and
  keys the root's other devices when it may) and lists the section in the
  roster. A Read device cannot list it and refuses without using the
  invitation; an acceptance not reached is finished by the same link.
- **Creating (§7.3).** The section creation's host asks
  `Collaboration.createSectionResource`, which on such a device uses
  `createResourceAsDevice`: Genesis owned by the root with the device's
  chain (field 5), hosted now, the key sealed to the root, the roster
  entry. Its operation is derived from the creation's requested Resource
  ID, so a resume finds the same section; the creation follows the ID the
  SDK chose (`requested` keeps the first one). An Edit device is refused.
- **Reaching the other devices.** The upkeep reads the roster and opens
  every section there this device does not hold and may use (§6 "ready").
- **The first device's new sections.** Whoever creates or accepts a
  Resource after the device list exists adds it to the roster (SDK 0.3.1;
  reconciliation adds none). A section the first device creates or joins
  is queued and listed with the SDK's `addToRoster` (behind
  `RosterWriter`, `src/core/identity/roster.ts`), then and at every
  upkeep; until it is listed, it is shown as "Not on your other devices
  yet" instead of "up to date".

## New device's side

"Pair this device with a link…" makes this vault a device of the person
whose device shows the link. A vault that already shares sections under
its own identity is refused (its Principal is a person in those
sections). The link field is a password field. The dialog shows this
device's fingerprint and asks for the result with the same backoff
("Check now" asks at once); the result comes
from the chain only (a timeout is never a decision). Each section of the
roster gets its §6 status (ready, waiting for keys, waiting to be added,
not granted, approval not provable here, unreachable, on a server without
device support); a ready one is stored and opened here
(`Collaboration.openFromRoster`) and can be inserted into a note as a
joined section is. One that fails to open here is shown as such and tried
again; the request stays resumable until every section is open. The
device list itself is its own line, never a section. Closing keeps the
request; the command shows it again.

A section the server refuses to this device is shown in "Your devices…"
as "removed from your identity" when the SDK proves it (§8.6), else as
"no longer has access". The notes keep their copy; nothing is deleted.

## Mobile

Read-only on mobile (V3) stays: a phone approved with Edit holds
`data/write` and writes nothing until V3 is lifted. The approve dialog
says so for a phone.
