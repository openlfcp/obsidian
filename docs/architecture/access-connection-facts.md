# Access and connection facts

LFCP-03-005 (MVP 0.3, findings F-C05 and F-C06). How a section's access
and connection get from the SDK to the status view, the card, the badge
and a pane. The facts are additive fields of `StatusView`, next to `sync`
(LFCP-03-003). They use no new status path and no new store. An unknown
value stays unknown (`null`). It never becomes a default.

## Providers

| Fact | Source | Adapter |
| --- | --- | --- |
| Write access and its reason | SDK `canWrite` / status stream `access` (`WriteAccess`) | `src/core/status/sdk-status.ts`, `facts.ts` (`accessFact`) |
| As-of: `verifiedAt`, `current` | SDK `AccessState.verifiedAt`, `AccessState.current` | `facts.ts` (`accessVerifiedAt`, `accessCurrent`) |
| Server refusal of the Resource | SDK `resource-refused` event (POST-017) | `LfcpRuntime.refusal` |
| Session phase | SDK `resource-state` events (§65) | `LfcpRuntime.phase` |
| Transport transitions | SDK `connection` events (§63: CONNECTING … READY, DISCONNECTED) | `src/core/lfcp/transport.ts` (`TransportTracker`), `LfcpRuntime.transport` |
| Network gone or back | The window's `offline` and `online` events | `LfcpRuntime.networkLost`, `networkBack(true)` |
| Connection not answering | `LivenessProbe` (`src/core/lfcp/liveness.ts`) | `TransportTracker.unresponsive` |

No SDK API is missing for these facts.

## Access

`StatusView.access` is `{ access, verifiedAt, current, checking }`.

| SDK `WriteAccess` | `access` |
| --- | --- |
| `allowed` | `writer` |
| `read-only` | `reader` |
| `revoked` | `revoked` |
| `not-member` | `not-member` |
| `server-refused` | `refused` |
| `key-unavailable`, or the phase `KEY_BLOCKED` | `unavailable-key` |
| `unknown`, or no answer yet | `unknown` |

- `verifiedAt` is the local time of the Control validation. It is `null`
  when the chain was never validated or no answer came yet.
- `current` is `false` while the Control view is behind the server's. It
  is `null` when no server has reported a head in this session.
- `checking` is true while that view is catching up. It is false for
  `refused`, `revoked` and `not-member`.
- The card says a removal or a non-membership "as this device last
  verified it; it may have changed" unless `current` is true.

## Connection

`StatusView.connection` is one of `connected`, `connecting`, `failed` and
`offline`. `connectionQualifier` says why the section is not connected.
`refusal` is the server's code, or `null`.

| Session phase | Transport | `connection` | `connectionQualifier` |
| --- | --- | --- | --- |
| `OPENING` … `LIVE` | any | `connected` | `null` |
| other | none reported | `offline` | `no-evidence` |
| other | first attempt under way | `connecting` | `null` |
| other | READY | `offline` | `not-syncing` |
| other | lost after READY | `offline` | `lost`, or `not-responding` |
| other | attempt failed before READY | `failed` | `null`, or `not-responding` |
| other | any loss or failure while the network is gone | `offline` | `network-offline` |

- `connecting` is only the first attempt since the session started or was
  last READY. A retry reads as the last loss or failure until READY, so a
  section does not flip on every backoff.
- `failed` comes only from an attempt the SDK reported DISCONNECTED before
  READY. It is never inferred from a timeout.
- A server refusal, or the `refused` access, hides both `offline` and
  `connecting`: the server answered.

### In the reducer

| `connection` | Condition | State when it is first | Label |
| --- | --- | --- | --- |
| `offline` | `offline` (7) | `OFFLINE` | "Offline; local updates will wait" |
| `failed` | `offline` (7) | `OFFLINE` | "Could not connect to the server; local updates will wait" |
| `connecting` | `connecting` (last) | `LOADING` | "Connecting to the server" |

A section that is connecting is never current. With pending work it is
`LOCAL_DURABLE`, as before (SI04). `sync.sharedModel` is `catching-up`
only when connected. Otherwise a section that is receiving shows
`unknown`.

## Pane-ready reads

- `SectionsHost.sectionAccess(key)` and `sectionConnection(key)`.
- `vaultSyncSummary`: `connection` counts sections by state, and
  `accessNotCurrent` counts sections whose access is not verified current.

The tests are in `test/core/status/access-connection.test.ts`,
`test/core/lfcp/transport.test.ts` and
`test/core/lfcp/runtime-pool.test.ts`.
