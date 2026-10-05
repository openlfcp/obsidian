# Two-vault E2E (LFCP-066)

`test/e2e/two-vaults.test.ts` is the product proof. It runs in `pnpm test`:
- two clean vaults on two simulated devices, each with its own mock
  Obsidian app (vault files, `secretStorage`, vault-scoped local storage),
  IndexedDB install and Principal;
- the real plugin, driven only through its commands (scripted dialogs) and
  vault events;
- real WebSockets to the openlfcp reference server binary.

It takes about 5 seconds once the server is built.

## Running it

```sh
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH  # cargo, if not on PATH
LFCP_REQUIRE_LIVE=1 pnpm vitest run test/e2e
```

The server is built from `../server` (or `$LFCP_SERVER_DIR`) with cargo into
the shared target directory: `$LFCP_SERVER_TARGET_DIR`, default
`$TMPDIR/openlfcp-sdk-ts-server-target`, the same one sdk-ts uses. You can
also pass a built binary as `$LFCP_SERVER_BIN`. Without cargo or the
checkout the E2E is skipped; with `LFCP_REQUIRE_LIVE=1` that is an error, so
a gate cannot pass by skipping it.

## What it checks

| Step | Proof |
| --- | --- |
| Clean vaults | Independent Principals |
| Create, host, share | Two collaborations hosted on the server; two Tasks of one note shared into different Resources (Test B), child-line and inline |
| Invite, join | Real one-time invitations and claims; B decrypts the Task's plaintext |
| Different files | B inserts the same Tasks into its own note with the other placements; A projects one Task twice |
| Remote completion | B ticks the Task; both of A's projections update, private text byte-exact, placements kept |
| Offline | B offline while A renames and B adds a due date; both converge after reconnect, with identical logical roots |
| Conflict | Both offline set different statuses; the conflict shows on both vaults (status bar), then B resolves it with the conflict command and both converge |
| Detach (Test C) | The projection loses its ref and keeps its text; editing it creates no Data Unit; other projections keep syncing |
| Privacy | No private paragraph, note path, Task plaintext or local collaboration name appears in any wire frame, the server's stored state or its log, or in the other vault |

## Harness

- `test/support/e2e-server.ts`: `serverBinary()`, `startServer()`. The
  server exposes `stored()` (every byte of its state directory) and `log()`.
- `test/support/e2e-vault.ts`: `E2EVault.open(name)` with `command(id,
  answers)`, `write`, `editLine`, `focus`, `read`, `settle`,
  `network.frames` and `network.offline`; `until(what, fn)` for explicit
  waits.

Failure messages name the vault, note and step. They never include keys or
invitation links.
