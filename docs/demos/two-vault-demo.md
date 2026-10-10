# The two-vault demo (LFCP-072)

The canonical OpenLFCP product demo, run by a person in real Obsidian. Two
vaults stand for two people:
- Alice is Vault A, Bob is Vault B;
- each vault has its own identity, a key pair kept on the device, not an
  account;
- they share one Task through the OpenLFCP reference server. The server
  relays encrypted, signed data and can read none of it.

Each step says what you do and what you should see. The same storyline runs
automatically in the two-vault E2E (`test/e2e/two-vaults.test.ts`). To print
it as a narrated reference transcript:

```sh
LFCP_REQUIRE_LIVE=1 LFCP_E2E_NARRATE=1 pnpm vitest run test/e2e/two-vaults.test.ts --reporter=verbose
```

## 0. Prepare

From a built checkout of this repository (see the README), with
`../server` checked out:

```sh
node scripts/demo-vaults.mjs          # or: --dir <somewhere> --port <n>
```

For shared sections (MVP 0.2), add `--sections`: it adds `Launch plan.md`
to Vault A, with a `## Launch` section to share and private text around
it. Shared sections are on in every 0.4 build; nothing else to set.

It prepares `../openlfcp-demo/`, outside every repository:
- `vault-a/` and `vault-b/`, with the plugin built in and enabled, and the
  demo server set as the default server;
- Vault A uses child-line refs and Vault B inline refs, so the demo shows
  both placements;
- one sample note per vault: `Private A.md` (two tasks and private text) and
  `Private B.md` (private text only);
- `server/server.toml`.

The script prints the exact commands. Start the server in its own terminal:

```sh
cargo run --manifest-path ../server/Cargo.toml -- --config ../openlfcp-demo/server/server.toml
```

**Expect:** the server logs that it listens on `127.0.0.1:8787`, and
`curl http://127.0.0.1:8787/health` answers `{"status":"ok"}`.

Open both folders in Obsidian with "Open folder as vault", in two windows.
In each, turn off Restricted mode once (Settings → Community plugins).

**Expect:** Shared Tasks is enabled. In Settings → Shared Tasks, "Identity on this
device" says Ready. The two vaults have different identities; they are never
shown, and there is no account.

## 1. Alice creates a collaboration

In Vault A, run "Shared Tasks: Create collaboration" from the command palette.
Name it `Project Alpha` and accept the default server.

**Expect:** the notice *"Project Alpha" created and hosted. You own it.*

## 2. Alice shares a task

In `Private A.md`, put the cursor on `- [ ] Prepare API contract 📅 2026-10-20`
and run "Share task under cursor". Pick `Project Alpha`.

**Expect:** the notice *task shared*. The task line is unchanged, and a child
line `  <!-- lfcp-ref: lfcp1:…#task:… -->` appears under it. Nothing else in
the note changes.

## 3. Alice invites Bob

Run "Invite collaborator", pick `Project Alpha`, then `Read + write`.

**Expect:** a dialog shows a one-time `lfcp://join/…#secret=…` link with a
copy button. **The link is a secret**: anyone holding it can join until it
is used. Copy it to Bob privately.

## 4. Bob joins

In Vault B, run "Join collaboration", paste the link, and name the
collaboration `Alpha` (a local name only Bob sees).

**Expect:** progress (connecting, validating invitation, claiming capability,
retrieving key, synchronizing), then *joined "Alpha" (read and write)*. Using
the same link again from another device is refused.

## 5. Bob puts the same task in his own note

In `Private B.md`, put the cursor on the blank line under "Some unrelated
notes." and run "Insert shared object". Pick `Alpha`, then
`Prepare API contract`.

**Expect:** `- [ ] Prepare API contract 📅 2026-10-20 <!-- lfcp-ref: … -->` is
inserted inline, Vault B's placement. It has the same Resource and object ID
as Alice's, in a different file with different surrounding text.

## 6. Bob completes it; Alice sees it

In Vault B, tick the task (`- [x]`).

**Expect:** within a second, Alice's line in `Private A.md` becomes
`- [x] Prepare API contract 📅 2026-10-20 ✅ <today>`.
- Her ref stays a child line and Bob's stays inline.
- Every other character of Alice's note is unchanged.

## 7. Offline edits

Take Vault B offline: switch off the network, or stop the server.
- Alice renames her task to `Prepare API contract v2`.
- Bob changes the due date to `📅 2026-10-25`.

Bring the network (or the server) back.

**Expect:** after the reconnect (a few seconds, with retries), both notes
show `Prepare API contract v2 … 📅 2026-10-25`. Neither edit was lost.

## 8. A conflict, and its resolution

Take both vaults offline. In Vault A mark the task in progress (`[/]`); in
Vault B cancel it (`[-]`). Bring both back online.

**Expect:**
- Both vaults' status bars say *1 shared task has a conflict*.
- The task line has a marker in the editor (not in the text) whose tooltip
  names the conflicting field.
- The note shows one of the two values as ordinary Markdown; no conflict text
  is written into it.

In Vault B, with the cursor on the task, run "Resolve shared task conflict",
pick `status`, then `cancelled`.

**Expect:** both vaults show `[-]`, and the conflict indicators disappear.

## 9. Restart

Quit Obsidian with both vaults open and start it again.

**Expect:**
- Both vaults come back with the same identities and no lock warning.
- Their notes are unchanged and nothing is resent.
- An edit made while Obsidian was closed (e.g. in another editor) is sent on
  the next start.

## 10. Detach

In Vault A, run "Detach shared task" on the task.

**Expect:**
- The ref comment is removed and the task line stays as it is.
- The task is no longer shared from that note: editing it there sends
  nothing.
- Bob's copy is unaffected, and the ref is never re-added by itself.

## 11. Privacy

Your private paragraphs stay private:
- Vault B never contains `PRIVATE-A-MARKER`, and Vault A never contains
  `PRIVATE-B-MARKER`.
- The server's state (`../openlfcp-demo/server/state/`) and log contain no
  note text and no task title. It stores ciphertext plus protocol metadata
  (IDs, sequence numbers, sizes), which is not hidden.

Check with `grep -r PRIVATE- ../openlfcp-demo/server/state` (no output) and
`grep -r "Prepare API" ../openlfcp-demo/server/state` (no output).

## Starting over

Quit Obsidian and delete `../openlfcp-demo`. Each vault's identity and local
LFCP state live in Obsidian's own profile (IndexedDB and secret storage),
keyed per vault. To start completely fresh, also remove the two vaults from
Obsidian's vault list, or use a new `--dir`.
