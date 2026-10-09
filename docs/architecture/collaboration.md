# Collaboration commands (LFCP-065)

The product UI: nine commands and a conflict hook (seven in v0.1, two for
many Tasks at once in POST-018). Everything else
stays ordinary Markdown. The commands are thin. Dialogs live in
`src/obsidian/ui/prompter.ts`, the handlers in `src/core/collab/commands.ts`,
and the flows in `src/core/collab/service.ts`. Every protocol step is an SDK
flow, so none of these layers holds protocol logic. A test enforces it
(`test/core/collab/no-protocol.test.ts`).

| Command | What happens | SDK flow |
| --- | --- | --- |
| Create collaboration | Asks a local name and a server, then creates the Resource locally and hosts it | `runtime.createResource`, `SyncClient.host` (RESOURCE_HOST) |
| Join collaboration | Asks the invitation link in a masked field and a local name, then claims | `acceptInvitation` (LFCP-053) |
| Share task under cursor | `task.create` from what the line represents, then adds the ref | `runtime.writeIntent` |
| Insert shared object | Picks a Resource and a Task, then writes its projection at the cursor | `renderNewTaskLine` (LFCP-062) |
| Share selected tasks | Every Task line of the selection, or else of the heading section at the cursor (down to the next heading of the same or a higher level; ATX headings outside fences and front matter): one Resource pick, one `task.create` each (`created_at` now + its index in ms, keeping note order), all refs in one `vault.process`. Bound lines are skipped, blocked or title-less ones refused; one summary notice | `runtime.writeIntent` (`Collaboration.shareAll`) |
| Insert all tasks from collaboration | Every live Task the note does not project yet, at the cursor, ordered by `created_at` then Object ID | `renderNewTaskLine` |
| Invite collaborator | Picks a preset, then shows a one-time link | `createInvitation` |
| Resource status | The non-secret state of a collaboration | stored Control state, Shared Objects state |
| Detach shared task | Removes the ref; the shared object is untouched | none |
| Resolve shared task conflict | Lists a field's competing values and keeps the chosen one | `task.resolve_field_conflict` |

Batches (POST-018) hold at most 200 Tasks (`MAX_BATCH`): a larger one is
refused before anything is written. The pick dialog says that everyone
invited sees every Task of the collaboration. The range logic is pure, in
`src/core/collab/batch.ts`. A section or list is not a shared object: its
order, its heading and Tasks added to it later stay local; shared sections
need the protocol (NEXT-001). Headings inside HTML or `%%` comments still
count as headings.

## Inside shared sections (0.4, task 100)

The commands above act on shared Tasks outside shared sections. Inside a
section, everything is shared with the section, so they refuse, with one
notice and before any dialog or write: "Share task under cursor", "Share
selected tasks" (also a selection that crosses a section's boundary),
"Insert shared object", "Insert all tasks from collaboration" and "Detach
shared task". A damaged section boundary counts as inside. With the cursor
under a heading, "Share selected tasks" never takes the Tasks of a section
under it. Outside sections they behave exactly as in 0.3. Analysis:
`workbook: mvp-0.2/notes/legacy-commands-in-sections.md`.

## Presets

| Preset | Grant abilities | Claimant gets |
| --- | --- | --- |
| Read | data/read, invite/claim | data/read |
| Read + write | data/read, data/write, invite/claim | data/read, data/write |

Writing Shared Objects needs only data/write. Invitations do not grant
snapshot/publish: only the owner publishes Snapshots (see below). invite/claim is what makes the
grant an invitation (§18). It is not delegable, so the collaborator cannot
pass the link on. Every invitation has `claim_limit = 1` (G-CAP8).

## Snapshots (POST-007, LFCP-02-097)

The plugin publishes a Snapshot of a collaboration or a shared section so a
new member catches up from it and the units after its frontier, instead of
every unit since the start.

- Trigger: a LIVE Resource gets a new Snapshot once 200 units were merged
  since the last one, counting this vault's own units and those received
  from others (`snapshotEvery` in the runtime environment; the SDK asks on
  every sync tick through `snapshotPolicy`).
- Capability: only a member whose validated Control state grants
  `snapshot/publish` publishes; the plugin checks it with `accessState` each
  time the Resource goes LIVE. Owners hold it; the invitation presets do not
  grant it.
- The SDK builds, signs and queues it (`publishSnapshot`), within the
  profile's Snapshot limits (SHARED-OBJECTS-PROFILE-01 §13.1); a joiner's
  client loads an offered Snapshot through the profile's admission and
  fetches only the tail. Shared sections open with the profile's
  `snapshotBinding`, 0.1 collaborations with their Snapshot codec.
- Evidence: the two-vault live tests in `test/core/collab/live.test.ts` and
  `live-sections.test.ts` publish with a threshold of 3 and check that the
  joiner's client reports `snapshot-loaded` for that Snapshot.

## Secrets

- An invitation link is a bearer key. The flows return it as the SDK's
  `InvitationLink`, which prints and serializes as `[redacted]`.
- The invitation dialog shows the link only on "Show link" and copies it on
  "Copy link". Nothing puts it in a notice, a log, settings (`data.json`) or
  an error.
- The join field is a password input. Join progress shows stages only:
  connecting, checking the invitation, claiming access, receiving the key,
  synchronizing.
- The status view shows public values only (IDs, heads, epochs, URLs, ability
  names). A test checks that no stored secret appears in its rendered text.

## Markdown edits

- Every write goes through `guard.expect` and `vault.process`. The projection
  engine therefore treats it as its own echo, reindexes the note and records
  its base (LFCP-062).
- Share attaches the ref to the same Task line even if lines moved meanwhile.
  It uses the configured placement: child line by default, inline when set.
  The parser accepts both whatever the setting says.
- A Task that already has a valid ref creates no new object. A blocked ref
  (malformed or duplicated) is refused.
- Insert renders the shared Task's current state. The same object may appear
  in many notes, or several times in one; that is valid, and nothing warns.
- Detach removes exactly the ref's bytes:
  - inline: the comment and its single separator;
  - child line: the whole line with its line ending.

  Line endings (LF, CRLF, CR) are kept. Fixtures:
  `test/fixtures/collab/detach.json`. Nothing remote is deleted or
  tombstoned, and the ref is never recreated.

## Offline and blocked states

- Create works offline. Hosting stays pending, and "Resource status" offers
  "Host on the server now".
- Shares and edits are queued as Data Units and sent later; the status view
  shows the count.
- An invitation created offline is queued and returned unconfirmed. It works
  once the coordinator has its grant and Key Package.
- Joining needs the coordinator and says so plainly.
- A forked Control Chain (`control_conflict`) blocks sharing and invitations.
  The status view says so in a banner and never reports the collaboration as
  in sync.
- A collaboration of another Data Profile than Shared Objects (a newer
  plugin's shared sections, say) is `unsupported` (0.3.2). It is never
  opened, merged or written; every command except "Resource status" says
  it needs a newer version of Shared Tasks, and its stored data stays
  untouched.

## Server, Principal, owner

These are three different things, and the UI keeps them apart:
- the server only relays ("not your identity, not the owner");
- this vault's identity is a key pair on this device;
- the owner is whoever created the collaboration.

## Tests

- **Offline, on a real runtime:** `test/core/collab/*.test.ts`.
- **Live, against the reference server:** `test/core/collab/live.test.ts`.
  It covers create, host, share, both presets, join, sync both ways and the
  one-time link. It uses `test/support/live-server.ts`; set
  `LFCP_REQUIRE_LIVE=1` to forbid skipping.
- **Through the plugin and its dialogs:** `test/obsidian/collab-ui.test.ts`.
