# Support matrix for 0.2 (Shared Tasks 0.4)

The native evidence for what Shared Tasks 0.4 supports (069), by area. Each
section names its spec, the runs and the result. All runs use the native
harness ([native-harness.md](native-harness.md)) on Obsidian 1.13.4 and
1.14.4, on Linux, with the reference server at `LFCP_SERVER_BIN`.

## Install and upgrade

**Spec:** `test/native/specs/upgrade-install.e2e.mjs`. **Date:** 2026-10-14.
**Build:** obsidian `rw/upgrade-lock-first` (2bdca5a, on main 4187949),
SDK `@openlfcp/*` 0.2.0-beta.8.

### How the spec works

Each case starts with a fresh copy of the test vault: `reloadObsidian`
with no plugin enabled, so Shared Tasks is installed but has never run,
and its install is new. The plugin's files are written into
`.obsidian/plugins/shared-tasks/`, as an update writes them, and the
plugin is enabled.

The older versions are the assets of their GitHub releases, fetched once
into the harness cache (`releases/<version>/`):

- `0.3.4`: main.js 1,958,373 bytes;
- `0.4.0-beta.15`: main.js 2,291,152 bytes.

Markers check, each time, which code is on disk and which is running.

The headless peer B, on the current SDK, plays the collaborator:

- For the 0.1 tasks, B makes and hosts a 0.1 collaboration with three
  Tasks. A, on 0.3.4, joins it with its own UI ("Join collaboration",
  then "Insert all tasks from collaboration").
- For sections, B joins A's shared section.

### Results

| Case | Result |
| --- | --- |
| **Fresh install** of this build | Runs, shares a section that B joins; A's badge CURRENT; nothing upgraded (a new install) |
| **0.3.4 → this build**: 0.1 shared tasks joined from B, B's rename received on 0.3.4, A's edit pending while the server is down, then the update with the server still down | The local data is upgraded (`upgradedLocalData`, the notice) and the identity kept. Once the server is back, the pending edit reaches B, and B's later rename reaches A. Each Task is in the note once, with 3 refs. The outbound queue drains |
| **0.4.0-beta.15 → this build**: a shared section, an edit pending (the server down) | Identity kept; the edit reaches B; both notes show the same Tasks; A ends CURRENT; no marker problem |
| **Disabled and enabled; uninstalled and installed again** (the plugin's folder and `data.json` removed) | The identity and the section kept; an edit after the reinstall reaches B; A ends CURRENT |
| **The plugin reloaded 20 times in a row** (`section-restart-mid-pass`) | Ready every time (at most 221 ms on 1.13.4 and 215 ms on 1.14.4); the section CURRENT |
| **Downgrade 0.4 → 0.3.x** | Documented, not tested: 0.3.x refuses the upgraded data with "VersionError" ([0.4-compatibility.md](../../releases/0.4-compatibility.md)) |

Runs:

- the 0.3.4 update with the server down: 14 runs of both versions, every
  update step green. One run failed earlier, in 0.3.4's own setup (the
  insert ran before the joined tasks had arrived); the spec now inserts
  again until they are there.
- the whole spec: green on both versions;
- the full native suite with this build: 66/66 spec runs.

### Found and fixed: the update from 0.3.4 could leave Shared Tasks not running

Before obsidian 2bdca5a, updating 0.3.4 to 0.4 in one Obsidian window
failed in about half of the runs over both versions. That is what
Obsidian's plugin update does.

- The new runtime opened the install's database, which it upgrades to
  version 2, while 0.3.4's connection was still open.
- storage-idb rejects an open as soon as another connection blocks it
  ("IndexedDB … is blocked by another connection").
- Nothing retried and nothing was said. Shared Tasks did not run until
  Obsidian restarted: 0.1 tasks did not sync, and every section stayed
  loading.

Now:

- The writer lock is taken before the database is opened. 0.3.4 and later
  release it right after closing their storage.
- A start still blocked by a closing connection is tried again for up to
  10 s.
- A lock held by another window is tried again in the background.
- Any start failure is said once.

The SDK side is LFCP-02-120 (after 0.2): a blocked open that waits, and
connections that close on `versionchange`.

### Not covered

- **BRAT "Latest version".** In the harness BRAT would download real
  GitHub releases, so it would test a published release, not this build.
  What BRAT does on an update is the same as the cases above: it replaces
  the plugin's three files and reloads the plugin. The BRAT steps are in
  [release.md](../release.md); they stay a manual check of each release.
- **Obsidian's own update from the community catalog.** Same mechanism,
  same reason.
- **macOS and Windows.** These runs are Linux. Platform smoke covers the
  other platforms ([platform-smoke.md](platform-smoke.md)).
