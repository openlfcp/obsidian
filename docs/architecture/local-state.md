# Local state of the plugin (LFCP-059)

Where the plugin keeps LFCP state for one vault on one device, and why. This
note records the storage design the orchestrator approved for LFCP-059.
OBSIDIAN-ARCHITECTURE-01 §34 suggests a folder under
`.obsidian/plugins/shared-tasks/`. The plugin does not use that folder, because
it syncs with the vault.

## Where each kind of state lives

| State | Where | Synced with the vault? |
| --- | --- | --- |
| Control Records, Data Units, Key Packages, Snapshots, outbound queue, sequence counters, profile checkpoints (plaintext Shared Objects state), Resource rows and labels | IndexedDB database `openlfcp-v1-<installId>` (`@openlfcp/storage-idb`) in Obsidian's profile directory | No |
| Principal private keys, Resource DEKs | `app.secretStorage`, slots `openlfcp-<installId>-<hash of the SecretRef>` | No (device-level, shared by all vaults) |
| Install marker: install ID, Principal, high-water mark of every sequence counter | `app.secretStorage` slot `openlfcp-<installId>-marker` | No |
| Install ID of this vault on this device | `app.saveLocalStorage("openlfcp-install")`, vault-scoped | No |
| Settings: ref placement, default server | `data.json` (`.obsidian/plugins/shared-tasks/`) | Yes. It holds no identity and no secrets |

A vault synced or copied to another device (Obsidian Sync, iCloud, Git of
`.obsidian`) carries none of the LFCP state. Its plugin starts a new install
there, with its own Principal and sequences.

## Install marker (ST-3)

Three records must agree: the install ID in vault-scoped local storage, the
`install` row in the database, and the marker secret. If any of them is
missing or disagrees, writing is locked: no actor or Snapshot sequence is
reserved. This covers:

- a wiped or evicted database;
- a reset secret store;
- records that name different Principals;
- missing keys;
- a database restored from a backup.

A restored database is caught by the marker's high-water marks: after every
durable reservation, and before the value is used, the marker records the
counter. At startup a database counter below its mark locks writing.
Settings then offer to create a new identity. That makes a new install ID and
namespace and leaves the old one untouched, never reused.

`app.secretStorage` cannot delete. A replaced install's slots stay behind, and
a deleted secret is an empty string.

A second Obsidian instance on the same vault cannot take the install's Web
Lock (`navigator.locks`), so it starts locked.

## Eviction

On first run the plugin calls `navigator.storage.persist()` and records the
result. If persistence is denied or unavailable, settings show a warning.
Eviction would trip the marker lock, which is safe, but the user should know
why writing stopped.

## Plaintext at rest

Profile checkpoints are the decrypted Shared Objects state. They are as safe
as the OS user's profile directory, the same exposure as the CLI's 0600
SQLite file. Follow-up (not in LFCP-059): wrap checkpoints in AEAD with a
device key kept in `app.secretStorage`.

## Automerge wasm

The bundle resolves `@automerge/automerge` to its `/slim` build
(`scripts/build.mjs`). At startup, before any replica exists, the runtime
awaits `initializeAutomerge()` from `@openlfcp/shared-objects`. That decodes
the base64 wasm quickly and compiles it asynchronously. The base64 build
would compile 3.5 MB of wasm synchronously on import, which Chromium refuses
on a renderer's main thread above 4 KB. Measured in Node 24 on a minimal
bundle, cold start:

| Variant | Bundle | Init total | Longest main-thread stall |
| --- | --- | --- | --- |
| base64 (sync `initSync`) | 5.02 MB | ~280 ms | ~250 ms (import time) |
| slim + Automerge's `initializeBase64Wasm` | 5.02 MB | ~290 ms | ~250 ms (its base64 decode) |
| slim + SDK `initializeAutomerge` (chosen) | 5.02 MB | ~100 ms | ~60 ms |

The plugin starts the runtime in the background, so `onload` returns without
waiting for it.
