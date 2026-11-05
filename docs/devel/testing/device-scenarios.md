# Device scenarios against the reference server (LFCP-04-414)

The end-to-end scenarios of a person's devices (IDENTITY draft §7.4, 1–15)
run with installations of the plugin against the reference server, in the
style of `test/core/collab/live*.test.ts`. Each installation has its own
runtime, IndexedDB install, secret slots and Principal, and runs the
plugin's `Collaboration` and `DeviceService` on the SDK's identity flows.
Nothing is faked: the server is the real binary over real WebSockets.

## Running them

```sh
export LFCP_SERVER_BIN=<lfcp-server built at server.lock>   # identity-01
LFCP_REQUIRE_LIVE=1 pnpm vitest run --maxWorkers=2 test/core/collab/live-device
```

Without a server binary every test skips with its reason (`ctx.skip`);
with `LFCP_REQUIRE_LIVE=1` it fails instead. Scenarios 6, 7 and 8 need
more:

| Variable | What | Needed by |
| --- | --- | --- |
| `LFCP_PLUGIN_0_6_0` | A checkout of Shared Tasks 0.6.0 with its dependencies installed (`pnpm install --frozen-lockfile`) | 6, 7 |
| `LFCP_PLUGIN_V_NOTICE` | A checkout of obsidian `f33bb4d` (#105, V_notice) with its dependencies installed | 7 |
| `LFCP_OLD_SERVER_BIN` | The reference server at `server-legacy.lock` (`138030a`, before identity-01) | 8 |

Without one of them the test that needs it skips with the reason; with
`LFCP_REQUIRE_VERSIONS=1` it fails instead. The platform smoke run does not
provide them, so there these three skip.

The older plugins run from their own sources and their own SDK (0.2.2), as
their tests run them: `LfcpRuntime`, `Collaboration` and their
`test/support/lfcp-env.ts`. Their test env would replace the IndexedDB
globals; the harness keeps them, so every version shares one IndexedDB, as
on a device, and an update is the same installation started by a newer
version.

The servers of these tests lift the reference server's per-IP limits (new
WebSockets per minute, new Resources per day): every installation connects
from 127.0.0.1 and the device flows connect per call. One test does not:
`live-devices-limits.test.ts` runs the server with its defaults (20 new
WebSockets per IP per minute, a burst of 20) and fails on any refusal.

## The server's own limits

`live-devices-limits.test.ts`: one Mac pairs a second Mac and removes it,
paced as the dialogs pace it (requests and the result asked every 4 s,
20 s for the person to compare fingerprints). It counts every WebSocket
the installations open, sessions and device flows alike. Measured: **25
opened in about 26 s, all within one minute, none refused.** It fits, with
little room: the bucket holds 20 and refills 20 a minute.

Not within the limits (measured once, not a test): the same person adding
**two** devices one after the other (10 s each to compare fingerprints),
then removing one: **33 WebSockets in 25 s; the last 5 were refused**
(HTTP 429 before opening). The removal preview said "The server could not
be reached", and the removal itself ended "not finished" (Try again). A
removal of a lost device right after pairing others is the case where it
matters. Each call of a device flow opens its own connection (the SDK's
`ChannelPool` is per call), and the new device's dialog asks every 4 s.

## Files

| File | Scenarios |
| --- | --- |
| `test/core/collab/live-device-control.test.ts` | A section open while a device is approved syncs on (the fix it found) |
| `test/core/collab/live-devices.test.ts` | 1, 2, 12 (a new installation), 14 |
| `test/e2e/vault-copy-device.test.ts` | 12: a real copy of a vault (the real plugin) |
| `test/core/collab/live-devices-limits.test.ts` | Pairing and removal within the server's own limits |
| `test/core/lfcp/control-race.test.ts` | The race of 1ba1f5a, made certain (no server) |
| `test/core/collab/live-devices-bridge.test.ts` | 3 |
| `test/core/collab/live-devices-removal.test.ts` | 4, 5, 10, 13 |
| `test/core/collab/live-devices-versions.test.ts` | 6, 7, 8 |
| `test/support/live-devices.ts` | The harness: installations, sections, edits, pairing, older plugins |
| `test/e2e/security-vertical-slice.test.ts` | §7.5: pair → write from the device → remove → rotate (phases 19–22) |

## Scenarios

| # | Scenario | Status |
| --- | --- | --- |
| 1 | Mac → second Mac (Full) | Verified: every section the person had at pairing opens; one author with one alias; one human with two devices in the access list |
| 2 | Mac → iPhone (V3) | Verified: Edit offered for the phone (`Platform.isMobile`), the same fingerprint, read-only on the phone |
| 3 | Bridge CLI | Verified, except an edit written by the bridge: `lfcp-node pair` for two sections, the same fingerprint, the bridge's Principal is the person "via" the bridge, no invitation, no third section, no device list. Not verified: a section edit by the bridge (no headless section writer in SDK 0.3.0) |
| 4 | Lost device | Verified: own section rotated at once, a colleague's at the colleague's upkeep (called by the test, as the plugin calls it when a section comes live), the result names it. The lost laptop's late unit, taken by its bytes: refused `STALE_DATA_EPOCH` (it names the head before the removal, in the closed epoch); a unit it seals at the `DEVICE_REVOKE` head: refused `AUTHORIZATION_FAILED`; handed directly to a reader, the late unit is quarantined |
| 5 | Offline device caught by revocation | Verified: the offline unit, by its bytes, refused `STALE_DATA_EPOCH`; handed directly to a reader, quarantined (`BEYOND_CUTOFF`); the laptop restarted still holds the same unit and its text; the text written again verbatim from another device; three replicas converge, the unit merged nowhere; "removed from your identity". **Not verified:** the export as the user sees it (notes and "Copy shared section" are not modelled by this harness: the text is checked in the replica, the unit in the queue) |
| 6 | Legacy human | Verified with a real 0.6.0 |
| 7 | Three generations | Verified with a real 0.6.0 (it stops with the error `INTERNAL` and shows "Sync: Offline … (control sync)", asserted; not a chain error) and a real V_notice |
| 8 | Old server | Verified with the server at `138030a`, then updated in place |
| 9 | Human invited on one device | Not verified: the plugin does not accept an invitation as a device (§4.6) |
| 10 | Managing device lost with cascade | Verified |
| 11 | Resource created from a device | Not verified: the plugin does not create a Resource as a device (§4.7) |
| 12 | Vault copied to a new machine | Verified with the real plugin (`vault-copy-device.test.ts`): files and data.json copied, not localStorage, secretStorage or IndexedDB; nothing machine-local in the copy; a new installation without the original's keys; its note kept as copied; paired, the copied note follows the section (this found a bug, fixed). `live-devices.test.ts` also pairs a fresh installation |
| 13 | Leaked link and double approval | Verified; the double approval on one managing device (a second one cannot list another device's session) |
| 14 | Access change | Verified: the Read device removed, its replacement paired as Full and writing; the authors of what the Mac and the Full device wrote stay the person. The removed Read device wrote nothing, so a record it wrote is not in that history: its own attribution is checked on the chain only |
| 15 | Edit device revokes | Not verified: no preset has `device/manage` without `key/rotate` |
