# People, not installations (LFCP-04-411)

Normative: IDENTITY-PROFILE-01 §10 (display) and §11 (compatibility),
LFCP-WIRE-01 §7.2, §80.1 and §100.1, at `mvp-0.4-baseline.1`; decision I6
(assignees as references to the root).

A human's installations are distinct Principals: the first one is the
**root**, every other one a **device** tied to it by a Device Certificate in
each Resource's own Control Chain. The plugin shows the root.

## The model

`src/core/identity/people.ts`, pure. `peopleOf(state, me)` reads one
Resource's validated Control state through the SDK (`rootOf`,
`activeDevice`, `revocationOf`, `deviceFingerprint` from `@openlfcp/wire`);
it never reads the Identity Resource, another Resource or a server (N3).
Without a stored, linear chain every Principal is its own person.

| Question | Answer |
|---|---|
| Who wrote this? | `rootOf(actor)`, revoked and intermediate devices included, so history keeps its author; a Principal no chain binds is itself. The device is detail: "from <label>", "via <label>" for a service device. |
| Who is "You"? | `rootOf(this installation)`: the reader's root and every one of its devices. |
| A person's devices here | the registered bindings of the root, with status: active, suspended (an issuer was revoked), removed (revoked, N5), inactive (the person holds no access). |
| A device's label | the reader's own Identity Resource label for one of its own devices (`deviceLabels`, supplied by the device flows of LFCP-04-413); otherwise the §5.2 fingerprint. |
| A local alias | keyed by the root's short ID: a device shows, and names, its person. |
| Assignees | `p:<D>` and `p:<rootOf(D)>` are one human for display and filtering; the CRDT set is never rewritten. A writer that assigns uses the root (`assigneeRef`). |

Attribution is never authority: whether a device may act is the SDK's
`activeDevice`, shown, not decided, here.

## Where it is shown

| Surface | Change |
|---|---|
| Access list (section card) | one row per root (owners and grant subjects are roots, W §80.1), the person's installations inside, the root's own first, "This device" marked; "Remove access…" acts on the person (W §17.3). |
| Resource status | "Participants" lists each person's devices after it; "Edits that cannot be applied here" counts a person once, its devices as detail. |
| Blocked-edits notice | names the person, the device after it. |
| Remove access outcome | a remaining grant issued from a device is named by its person. |
| 0.1 import preview | assignees counted by person; the copy keeps every reference as written. |

`LfcpRuntime.people(R)` reads the people of a stored Resource.

## The warning before the first pairing

`src/core/identity/compat.ts`. Pairing binds the new device in every shared
Resource whose server advertises `identity-01`; that record is the
Resource's barrier (W §100.1), so a collaborator whose plugin predates it
stops syncing that Resource until they update, and an updated one sees the
new device under its person. No client can see another's version, so
`firstPairingWarning` names every section shared with someone else, split by
the server's support (supported; not yet: reached later; not known), and is
null after the first pairing (an Identity Resource exists) or when nothing
is shared. `pairingSections` gathers the facts; the server's support comes
from the identity channel's `READY` extensions, which the device flows open.
The "Add my other device…" command (LFCP-04-413) shows it as a confirmation.
