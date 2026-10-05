# Collaboration commands (LFCP-065)

The product UI of v0.1: seven commands and a conflict hook. Everything else
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
| Invite collaborator | Picks a preset, then shows a one-time link | `createInvitation` |
| Resource status | The non-secret state of a collaboration | stored Control state, Shared Objects state |
| Detach shared task | Removes the ref; the shared object is untouched | none |
| Resolve shared task conflict | Lists a field's competing values and keeps the chosen one | `task.resolve_field_conflict` |

## Presets

| Preset | Grant abilities | Claimant gets |
| --- | --- | --- |
| Read | data/read, invite/claim | data/read |
| Read + Write | data/read, data/write, invite/claim | data/read, data/write |

Writing Shared Objects needs only data/write. The plugin publishes no
Snapshots, so snapshot/publish is not granted. invite/claim is what makes the
grant an invitation (§18). It is not delegable, so the collaborator cannot
pass the link on. Every invitation has `claim_limit = 1` (G-CAP8).

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
