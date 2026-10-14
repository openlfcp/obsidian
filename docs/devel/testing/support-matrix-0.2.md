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

## Themes and views

**Spec:** `test/native/specs/section-matrix.e2e.mjs`. **Date:** 2026-10-14.
**Build:** obsidian `rw/reading-view` (b1ad00f, on main b7178b0), SDK
`@openlfcp/*` 0.2.0-beta.8.

Vault A is real Obsidian with the real plugin; B is the headless peer. A
section is shared from A and joined by B. In each case B renames a Task,
and the spec waits for A.

| Theme × view | B's edit shows | Badge | Binding lines shown | Reaches A's file |
| --- | --- | --- | --- | --- |
| Light (moonstone), Source | yes | CURRENT | yes (Source shows them as written) | yes |
| Light, Live Preview | yes | CURRENT | no | yes |
| Light, Reading view | yes | CURRENT | no | yes |
| Dark (obsidian), Source | yes | CURRENT | yes | yes |
| Dark, Live Preview | yes | CURRENT | no | yes |
| Dark, Reading view | yes | CURRENT | no | yes |

After each Reading view case the note is switched back to Live Preview:
B's edit is still in the editor and in the file, and B still has it 5 s
later (A sends nothing back).

Colour contrast of the section status in both themes is measured by
`section-a11y` (status from mocked facts, the plugin's own styles).

Runs: 10/10 cases on 1.13.4 and on 1.14.4, and again after the rebase
onto b7178b0; the full native suite with this build (before the rebase onto b7178b0): 66/66 spec runs, one of them (acceptance-sections C10/C11/C14 on 1.13.4, a known timing flake) green on its rerun.

### Found and fixed: Reading view lost a collaborator's edit

Before obsidian 547921c, a note open only in Reading view never got a
collaborator's edit, on both versions and in both themes:

- Obsidian keeps a note's editor behind its Reading view. Shared Tasks
  counted that editor as open and wrote the edit into it.
- Obsidian never saved it: the Reading view and the file kept the old
  text, and the section's badge said CURRENT.
- Switching back to editing reloaded the file: the edit was gone from the
  note.

In split view (Live Preview and Reading view on the same note) it worked:
the Live Preview pane's editor saved the file.

Now a note shown only in Reading view is synced through its file, which
the Reading view renders. Back to editing, the editor takes the file as
written before the note is synced again, and a sync that was under way
when the note went into Reading view is dropped.

## Split view and focus

**Spec:** `section-matrix` (as above) and `section-two-panes`.

| Case | Result |
| --- | --- |
| The same note in Live Preview and in Reading view, side by side: A types in the Live Preview pane, B renames a Task | Both panes show both edits; B gets A's edit; no binding text in either pane |
| One shared note in Reading view next to another shared note in Live Preview | B's edits show in both panes and reach both files (each note synced by its own route) |
| A types, then clicks into the other pane (no further key) | The edit reaches B |
| `section-two-panes`: one section in two panes, typing in both, a cut in one pasted in the other, Move line while the other pane has focus, a pane closed with an edit or a cut not synced yet; two copies of a section in two notes | 11/11 on 1.13.4 and 1.14.4 |

## Tasks plugin on and off

**Spec:** `test/native/specs/tasks-plugin.e2e.mjs` (Tasks 8.4.0 enabled);
every other spec runs with Tasks off.

| Case | Result |
| --- | --- |
| Tasks on: its edits arrive as editor transactions; the Task lines it writes, an inline ref and a recurring Task | 1/1 on 1.13.4 and 1.14.4 |
| Tasks off | Every other native spec (the full suite, both versions) |

Not covered: Tasks versions other than 8.4.0, and Tasks' own commands on
lines inside a shared section beyond the ones the spec runs.

## Clipboard

**Spec:** `section-matrix`, and C12–C13 of `acceptance-sections`.

| Case | Result |
| --- | --- |
| Two Task lines copied in Live Preview and pasted into a plain note | The clipboard holds the lines with their ref lines; pasted outside any section, the refs are removed: no binding text in the plain note |
| `acceptance-sections` C12–C13: "Copy readable" and "Copy shared section" | The readable copy has no binding text; the shared copy keeps the section's markers, and its notice says it gives nobody access. On 1.13.4 and 1.14.4 |

## Not covered on the desktop

- **macOS and Windows.** These runs are Linux. Platform smoke covers the
  plugin's build and tests there ([platform-smoke.md](platform-smoke.md));
  the views, themes and clipboard on those platforms are the owner's
  manual checks.
- **Community themes** other than Obsidian's default light and dark.
- **Mobile.** Sections are read-only there (0.4.0 limits); not part of
  this matrix.
