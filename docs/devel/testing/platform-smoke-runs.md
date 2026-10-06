# Desktop platform smoke: runs (LFCP-068)

Records of the platform smoke described in
[platform-smoke.md](platform-smoke.md), newest first. Each record uses that
page's template. A check is PASS only if that run exercised it.

## 2026-10-06: macOS, manual, via the two-vault demo

The project owner ran the [two-vault demo](../../demos/two-vault-demo.md),
steps 0 to 11, in real Obsidian. Every step passed. Both vaults were on one
machine, so this is not a cross-OS pair.

```text
Platform:           macOS (version and arch not recorded)
Obsidian:           1.14.4 (installer 1.14.4)
Plugin:             openlfcp 0.0.0, built from obsidian faaf020
sdk-ts / spec:      98efaab / mvp-0.1-baseline.8
Server:             e84fa74, ws://127.0.0.1:8788
Peer (if any):      none: both vaults on the same macOS machine
Automated record:   platform-smoke-macOS.md from run
                    https://github.com/openlfcp/obsidian/actions/runs/37424167751
                    (commit 3cc9915): PASS
```

The demo runs a storyline, not the checklist. The table maps each check to
the demo step that exercised it. A check the demo does not exercise is
NOT RUN.

| Check | Result | Demo step, or why not run |
| --- | --- | --- |
| A1 | NOT RUN | The demo vaults are new but ASCII-named (`vault-a`, `vault-b`) |
| A2 | PASS | 0: `scripts/demo-vaults.mjs` installs the built plugin |
| A3 | PASS | 0: the plugin enables. This is the step that found the bug below |
| A4 | PASS | 0: "Identity on this device: Ready", no keys shown. The demo sets the ref placement per vault, so the default placement was not checked |
| A5 | PASS | 9: same identities after a restart |
| B1 | PASS | 1: create and host `Project Alpha`. "Resource status" was not run |
| B2 | PASS | 2: child-line ref, task line unchanged |
| B3 | PASS | 9: restart, then edits keep syncing, no lock warning |
| B4 | PASS | 9: notes unchanged, nothing resent, sync continues |
| B5 | PASS | 9: identity survives in `app.secretStorage` |
| C1 | NOT RUN | The WebSocket frames were not inspected |
| C2 | PASS | 7: offline edits are kept. Join and invite while offline were not tried |
| C3 | PASS | 7: reconnects by itself, both edits arrive |
| C4 | NOT RUN | Loopback `ws://` only |
| D1 | PASS | 3: Read + Write invitation link |
| D2 | PASS | 4: join with stages, "(read and write)" |
| D3 | PASS | 5: insert shared object (inline ref in Vault B) |
| D4 | PASS | 6: tick in B, done with ✅ in A, nothing else changed |
| D5 | PASS | 10: detach removes only the ref |
| E1, E2 | NOT RUN | The demo never quits while "Waiting to send" is above 0. Steps 7 and 9, the closest ones, passed |
| Paths | NOT RUN | No note under a Unicode folder was renamed or moved |
| CRLF | n/a | Windows only |

Beyond the checklist, the demo also passed conflict resolution (step 8) and
the privacy check of the server state (step 11).

**Bug found and fixed.** On the first try, Obsidian 1.14.4 refused to start
the plugin: "Secret ID is invalid. Use only lowercase letters, numbers and
dashes. 64 characters max." The secret slot IDs were 74 characters long.
The fix is obsidian `faaf020`. Slot IDs are now `openlfcp-` plus 55 hex
characters, 64 in all. The tests had missed it because their stand-ins for
`app.secretStorage` did not apply Obsidian's ID rule. Both stand-ins now
apply it, with Obsidian's exact error message.

## Status by platform (as of 2026-10-06)

| Platform | Automated (run 37424167751, commit 3cc9915) | Manual |
| --- | --- | --- |
| macOS | PASS | PASS for the checks above. A1, C1, C4, E and Paths NOT RUN |
| Windows | PASS | NOT RUN |
| Linux | PASS | NOT RUN |
| Cross-OS pair (D and E, `wss://`) | n/a | NOT RUN: needs a second OS |
