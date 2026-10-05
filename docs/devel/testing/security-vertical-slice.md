# Security/privacy vertical slice (LFCP-071)

`test/e2e/security-vertical-slice.test.ts` is the MVP 0.1 **release gate**.
It runs one scenario that crosses every security boundary:

Principal → Genesis and DEK → invitation and claim → HPKE → authenticated
session → encrypted Data Units → offline → anti-entropy → restart →
revocation → epoch rotation → stale-write cutoff → Snapshot → catch-up.

The server must never receive application plaintext at any point.
**If it fails, OpenLFCP MVP 0.1 is not ready for release.**

## Running it

```sh
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH  # cargo, if not on PATH
LFCP_REQUIRE_LIVE=1 pnpm run test:security
```

It also runs in `pnpm test`. CI runs it in the platform smoke matrix as a
named step, "Security/privacy vertical slice (LFCP-071, release gate)", on
macOS, Windows and Linux, with `LFCP_REQUIRE_LIVE=1`. Without that
variable the suite skips when cargo or `../server` is missing, so a gate
must set it. It takes about 10 seconds once the server is built.

## Real components, no bypasses

- **Vaults:** three vaults (A, B, C) on the LFCP-066 harness. Each has its
  own mock app, `secretStorage`, IndexedDB install and Principal, and runs
  the real plugin.
- **Server:** the real reference server binary over real WebSockets.
- **Invitations:** the real invitation and claim flow.
- **Not used anywhere:** plaintext transport, fake grants, pre-shared
  access, an in-memory server, disabled signature checks or disabled epoch
  checks.

The plugin UI covers sharing, inviting, joining, editing and conflict
resolution. Some steps have no UI:
- revocation and Data Epoch rotation;
- a write beyond a cutoff, given to a client directly;
- Snapshot publication;
- forged server-delivered units.

These steps call the SDK through the plugin runtime
(`runtime.collaborationContext()`: the vault's own storage, secrets,
Principal and pooled session), and each test says so.

**Revocation scenario:**
- The owner revokes B's whole claimed grant (`data/read` and `data/write`).
- It then rotates the epoch (reason 1) with a Key Package for itself only.
- B gets no later DEK and cannot open the Resource again.

## What it proves

| Phase | Proof |
| --- | --- |
| 1 Principals | Three independent Principals: different IDs and private keys; nothing sent before a command (no account service) |
| 2 Genesis | Random Resource ID, epoch-0 DEK matching the Genesis commitment, `RESOURCE_HOST`; the server stores the exact Genesis bytes |
| 3 Invitation | One-time link; B claims (`source: claim`, data/read + data/write), decrypts the invitation Key Package, its DEK matches the commitment; C's second claim of the same link is refused |
| 4 Sessions | HELLO → CHALLENGE → AUTH → READY on both vaults; one server ID. A Principal with a hosting credential but no grant is refused `RESOURCE_OPEN` and gets no packages; the credential is never logged |
| 5 Fixtures | Private Markdown markers per vault; one Shared Task projected child-line on A and inline on B |
| 6 Pipeline | A's `DATA_PUT` objects are canonical COSE Data Units without plaintext. Re-verified independently from their wire bytes (signature, actor key, ChaCha20-Poly1305, §11 framing), they are Automerge changes of A's §8 actor and replay to A's edit |
| 7 Server privacy | No marker in the server's state directory or log; the stored unit is exactly the signed ciphertext A sent |
| 8 Two-way sync | B edits the title, A the due date; same ObjectId and logical root; private text byte-exact; placements kept |
| 9 Offline | Independent offline edits converge through real anti-entropy: Have vectors on `RESOURCE_OPEN`/`RESOURCE_OPENED`, then `DATA_GET`/`DATA_BATCH`; periodic `DATA_HAVE` while LIVE |
| 10 Conflict | done vs cancelled: both values stay (no timestamp or UUID winner), both status bars show it; resolved by the conflict command, both converge |
| 11 Client restart | A crashed plugin keeps its Principal, Control Head, state, actor sequence and the exact pending bytes; the edit lands once; the next write takes the next sequence; projection reindexed |
| 12 Server restart | SIGKILL and restart: same server ID; the Resource, head and Key Packages are served to a new session; both vaults reconnect and sync; no duplicate objects |
| 13a/14a Routine rotation | B's offline epoch-0 unit is beyond the cutoff: quarantined, never merged; B re-applies it as a new epoch-1 unit, reusing the removed Automerge sequence (§9, baseline.6), and keeps writing |
| 13b/14b/15 Revocation | `CAPABILITY_REVOKE` + `KEY_EPOCH` 1 → 2. The server answers B's stale epoch-1 unit `STALE_DATA_EPOCH`; A, given the bytes directly, quarantines them, keeps the evidence and does not merge; B is refused `RESOURCE_OPEN` (`AUTHORIZATION_FAILED`), keeps its item, and has no epoch-2 DEK |
| 16 Snapshot | A publishes a signed, encrypted Snapshot, then writes more; C joins by a new invitation, loads the Snapshot, catches up beyond its frontier and equals A's full state; Control comes from the chain; earlier-epoch units within their cutoffs stay accepted |
| 18 Server trust | Two units signed by A that the server accepts: garbage ciphertext, and a correctly encrypted unit framing B's change. C refuses both (`AEAD`, `PROFILE_REJECTED`), merges neither, and A's next edit still reaches C |
| 17 Final privacy | No marker, DEK of any epoch, private key or invitation secret/link in the server's state, log or `/health`, nor on any vault's wire; client stores hold the authorized Task, never the other vault's Markdown |

**What the privacy claim covers.** The server never receives application
plaintext, DEKs, private keys or invitation secrets. It does see protocol
metadata by design: Resource and Principal IDs, sequences, epochs, sizes and
timing. The test does not assert otherwise.

## Harness

- **`test/support/security-server.ts`:** `startSecurityServer(bin)`.
  - `restart()`: SIGKILL, then the same port and state directory.
  - `stored()`, `log()` (across restarts) and `http(path)`.
- **`test/support/security-raw-session.ts`:** `RawSession`. It runs the
  real handshake, then lets the test send exact messages (a stale
  `DATA_PUT`, an open with no grant, forged units).
- It reuses `serverBinary()` (`e2e-server.ts`) and `E2EVault` (`e2e-vault.ts`).

**Failure messages** carry the phase, vault, Resource ID, Control Head,
epoch and Task ID. They never include keys, DEKs, invitation links or
decrypted test data.
