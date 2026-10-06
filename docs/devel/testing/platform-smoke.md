# Desktop platform smoke (LFCP-068)

The release-blocking smoke run of the Obsidian plugin on macOS, Windows and
Linux. It has two parts:

- **Automated.** `.github/workflows/platform-smoke.yml` runs build, lint,
  typecheck and the full test suite on each OS. The suite includes the live
  tests against the reference server built on that OS, and the two-vault
  harness. They may not skip (`LFCP_REQUIRE_LIVE=1`). Each OS uploads a
  `platform-smoke-<OS>.md` record (`scripts/smoke-report.mjs`).
- **Manual.** The checklist below, in real Obsidian, because desktop
  Obsidian cannot be driven reliably from CI.

A platform is PASS only when both parts ran on it and passed. Never mark a
check PASS without running it. "Not run" is a valid, honest result.

Records of past runs are in [platform-smoke-runs.md](platform-smoke-runs.md).

## Rules for every run

- **Server URL.** Use `ws://` only on loopback (`ws://127.0.0.1:…`, a server
  on the same machine). Anywhere else, use `wss://`. A run across two
  machines therefore needs a `wss://` server, for example behind the
  `deploy/` Caddy setup in the server repository.
- **Data.** Use synthetic notes only. Screenshots and logs must show no
  invitation link (`lfcp://join/…`), no `#secret=` fragment, and no content
  of the secret store.
- **Versions.** Record them before starting (the template is below).
- **Clean state.** Use a new vault for every run. Delete it afterwards. The
  plugin's state lives outside the vault (IndexedDB and the OS secret
  store), so also use a new OS user or browser profile, or note what was
  reused.

## Record (one per platform)

```text
Platform:           <OS> <version> <arch>
Obsidian:           <version> (installer <version>)
Plugin:             openlfcp <manifest version>, built from obsidian <commit>
sdk-ts / spec:      <sdk-ts.lock commit> / <spec.lock tag>
Server:             <server.lock commit>, <ws://127.0.0.1:PORT | wss://host>
Peer (if any):      <OS of the other vault>
Automated record:   platform-smoke-<OS>.md from run <URL>: PASS | FAIL
```

Then one line per check: `A1 PASS`, `C2 FAIL <non-secret diagnostic>`, or
`B4 NOT RUN <why>`.

## A. Installation

1. Create a new, empty vault. Name it with a space and a non-ASCII
   character, e.g. `Smoke Vault Ü`.
2. Copy the built plugin into `<vault>/.obsidian/plugins/openlfcp/`:
   `main.js` and `manifest.json`, from `pnpm run build` at the recorded
   commit.
3. Enable it in Settings → Community plugins. Expected: no error notice,
   and the developer console (Ctrl/Cmd+Shift+I) shows no error from
   `openlfcp`.
4. Open Settings → OpenLFCP. Expected:
   - "Identity on this device: Ready", with no keys shown;
   - "Ref placement" set to Child line;
   - "Default server" explained as not your identity.
5. Restart Obsidian. Expected: the identity is still Ready. A new identity
   is not created silently.

## B. Storage

1. Run "Create collaboration" with the name `Smoke` and the server. Then run
   "Resource status". Expected: the name, a Resource ID, "Hosted on the
   server", you as owner, and Control Head #0.
2. Share a task: `- [ ] Smoke task 📅 2026-12-01` with the cursor on it.
   Expected:
   - a child line `<!-- lfcp-ref: … -->` under the task, indented to its
     text;
   - the due date stays readable (Obsidian Tasks syntax).
3. Restart Obsidian, then edit the task title. Expected:
   - no "writing is paused" warning;
   - "Waiting to send" returns to 0 once online. Seeing it reach 0 after the
     edit shows the sequence continued without reuse; a reuse is refused by
     the server and would stay pending.
4. Close the note, delete nothing, and reopen the vault. Expected: the
   projection index rebuilds. Edits to the shared task are still sent, and
   remote changes still render into it.
5. Check that the identity survives in Obsidian's secret storage
   (`app.secretStorage`). After a restart, Settings still shows the same
   "Ready" identity, and the collaboration still writes. Do not inspect or
   export the stored values. Where the OS keeps them is Obsidian's concern.

## C. WebSocket

1. With the developer console's Network → WS tab open, run "Resource
   status". Expected:
   - one connection to the server URL with subprotocol `lfcp-1`;
   - the status shows the sync phase as live and in sync.
   The handshake (HELLO, CHALLENGE, AUTH, READY) and RESOURCE_OPEN are binary
   frames. It is enough that the connection stays open and the status is in
   sync: the automated live tests check the messages themselves.
2. Stop the server. Expected:
   - the status turns offline, and edits are kept ("Waiting to send"
     grows);
   - "Join collaboration" and "Invite collaborator" report that they need a
     connection.
3. Start the server again. Expected: the client reconnects by itself and
   "Waiting to send" drains.
4. For a `wss://` run: the same, against the TLS endpoint.

## D. Basic two-vault sync

Use two vaults, either on this machine or one on another OS (see the
cross-platform pair below).

1. In vault 1, run "Invite collaborator" with "Read + Write" and "Copy
   link". Send it to vault 2's user over a trusted channel, never in a
   screenshot.
2. In vault 2, run "Join collaboration" and paste the link in the masked
   field. Expected: the stages run, then "joined … (read and write)".
3. In vault 2, run "Insert shared object" on `Smoke task`. Expected: the
   task appears with its due date and a ref.
4. In vault 2, tick the task (`[x]`). Expected: within seconds, vault 1
   shows `- [x] Smoke task 📅 2026-12-01 ✅ <date>`, with nothing else in
   the note changed.
5. In vault 1, run "Detach shared task". Expected: only the ref line goes,
   and vault 2's task stays done and shared.

## E. Restart recovery

1. Go offline (stop the server), edit the shared task in vault 1, and quit
   Obsidian while "Waiting to send" is above 0.
2. Start Obsidian, then start the server. Expected:
   - the edit reaches vault 2;
   - no "writing is paused" warning;
   - the projections are correct in both vaults;
   - the reconnect happened without user action.

## Windows: CRLF

Before step D4 on Windows, make the note's line endings CRLF, for example by
saving it from Notepad. After the remote update arrives, check the file is
still CRLF throughout, for example with `Format-Hex` or a hex editor. A
remote update must not turn the whole file into LF. The automated suite
checks the same with byte fixtures (`test/fixtures/collab`,
`test/fixtures/projection`).

## Paths

On each platform, put one shared task in a note under a folder with a space
and a Unicode name, e.g. `Ünïcode Folder/Smoke note é.md`. Rename and move
that note, and check that it keeps syncing.

## Cross-platform pair (release-blocking)

At least one D and E run must pair two different operating systems, e.g.
macOS ↔ Windows or Windows ↔ Linux, against a `wss://` server. Record both
platform records and the pair.

## Mobile

iOS and Android are not part of this smoke run (LFCP-068). The plugin keeps
its mobile portability boundaries (no Node APIs in `src/`), but mobile is
not tested here.
