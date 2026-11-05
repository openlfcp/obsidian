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
from 127.0.0.1 and the device flows connect per call.

## Files

| File | Scenarios |
| --- | --- |
| `test/core/collab/live-device-control.test.ts` | A section open while a device is approved syncs on (the fix it found) |
| `test/core/collab/live-devices.test.ts` | 1, 2, 12, 14 |
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
| 4 | Lost device | Verified: own section rotated at once, a colleague's at the colleague's upkeep, the result names it, later edits refused |
| 5 | Offline device caught by revocation | Verified: the offline edit kept unsent on the device, re-applied from another, three replicas converge, "removed from your identity" |
| 6 | Legacy human | Verified with a real 0.6.0 |
| 7 | Three generations | Verified with a real 0.6.0 (it shows the section as offline, error `INTERNAL`) and a real V_notice |
| 8 | Old server | Verified with the server at `138030a`, then updated in place |
| 9 | Human invited on one device | Not verified: the plugin does not accept an invitation as a device (§4.6) |
| 10 | Managing device lost with cascade | Verified |
| 11 | Resource created from a device | Not verified: the plugin does not create a Resource as a device (§4.7) |
| 12 | Vault copied to a new machine | Verified at the installation level (the notes of the copy are not modelled) |
| 13 | Leaked link and double approval | Verified; the double approval on one managing device (a second one cannot list another device's session) |
| 14 | Access change | Verified |
| 15 | Edit device revokes | Not verified: no preset has `device/manage` without `key/rotate` |
