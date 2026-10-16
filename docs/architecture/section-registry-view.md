# Section registry view

LFCP-03-011 (MVP 0.3, findings F-02 and F-10, case U03-02). The read-only
list of shared sections that the pane (LFCP-03-012/013) shows: which
sections this device knows, where their copies are, and what is not
inserted yet. It adds no registry, no store and no network session. It
joins sources that already exist.

## Sources

| Fact | Source | Code |
| --- | --- | --- |
| Section Resources on this device, local alias, registry state, refusal | `LfcpRuntime.registry()`, filtered by `SECTIONS_PROFILE_ID` | `src/core/lfcp/runtime.ts` |
| Section ID and shared title | The section model, only when it is already open here (`sectionProfile`) | `SectionsHost.registry` sources |
| Status | The one status path: `StatusView` of watched Resources | `SectionsHost#statuses` |
| Notes with a copy, valid or damaged | The placement index, built at start and kept current by vault events | `src/core/sections/placement-index.ts` |

The view is `SectionRegistryView` in `src/core/sections/registry-view.ts`.
`SectionsHost.registry` is the instance. It holds no state of its own
beyond the last registry read.

## Snapshot

`registry.snapshot()` returns an immutable `RegistrySnapshot`.
`registry.onChange(listener)` calls the listener with each new snapshot.
A recompute that changes nothing is not reported. `version` grows with
each reported change.

| Field | Meaning |
| --- | --- |
| `status` | `loading` before the first registry read, `ready`, or `error` when the last read failed |
| `placementIndex` | `unknown` (no build, or the build failed), `building`, `complete` |
| `rows` | One per section Resource. On `error`, the rows of the last good read: a failed read does not lose joined sections |
| `sections` | The number of rows. `null` unless `ready`: an error is not an empty list |
| `unplaced` | Sections with no copy in any note. `null` unless `ready` and the index is `complete` |

Each row has:

- `resource` (base64url), `sectionId` and `key` (`<resource>#<sectionId>`,
  the key of `sectionSync`, `sectionAccess` and `sectionConnection`).
  `sectionId` and `key` are `null` until the model is open here.
- `sharedTitle` (`null` until the model is open) and `localAlias` (the
  registry's local name, never sent). They are separate fields. `rowLabel`
  applies the contract's naming rules N1–N3.
- `status.watched` and `status.state`. `state` is `null` when the Resource
  is not watched (for example, joined and not inserted before a restart)
  or has no status yet. `null` means unknown. It never means healthy.
- `placements` (note path, valid copies, damaged copies), `placementCount`
  (`null` until the index is complete) and `placed`: `placed` as soon as a
  copy is found, `unplaced` only with a complete index, else `unknown`.

`registry.inNote(path)` gives the rows with a copy in one note.

## Updates

| Event | What updates |
| --- | --- |
| Start | The index is rebuilt (`building` → `complete`). The registry is read after the index is complete |
| A note is created, changed, renamed or deleted | The index, from the vault events `SectionsHost.vaultChange` already handles |
| Insert, share, detach | The note is indexed again right after the edit |
| A runtime event about a Resource's state, or about a section Resource not listed yet (a join) | The registry is read again at the next status pass (debounced). Data events (`unit`, `status`, `ack`, …) do not cause a read |
| A creation finishes or is discarded; `registryChanged()` | The registry is read again at the next status pass |
| A status pass | The rows are recomposed (titles, statuses) |

Reads of the registry never overlap. A read asked during one runs once
after it.

## Limits

- Rows are one per Resource and are never merged by name. Two sections
  with the same title are two rows.
- Paths are vault paths, local to this device, and follow renames. They
  are not a stable note identity. The note identity of LFCP-03-002
  (`src/core/note-targets.ts`) is not needed here.
- A copy of a Resource that is not in the registry (pasted from elsewhere)
  is in the index but has no row.
- A section joined with an empty name stores no local name: its row shows
  the shared title, with no alias (contract N5, RC-13). Only a 0.1
  Resource joined that way is stored as "Shared collaboration".
