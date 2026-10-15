# Native harness: the plugin in a real Obsidian

The native harness (LFCP-02-096) runs the built plugin in a real Obsidian
desktop app, started from the command line. The specs read Obsidian's state
(the app object, the DOM, CodeMirror) and run commands. The unit tests
(`pnpm test`) cannot reach any of this: they use a mock of the Obsidian API.

Locally with `pnpm native`; in CI on demand with the "Native harness"
workflow (`.github/workflows/native.yml`, [below](#run-it-in-ci)). CI is
the place for a full run: a task branch does not need the owner's Mac, its
630 MB Obsidian cache or a server built at `server.lock`.

## Run it

```sh
pnpm native
```

This builds `main.js`, installs the harness's own dependencies
(`test/native/`, with their own lockfile), runs every spec on each Obsidian
version, and checks that no harness process is left. The first run
downloads Obsidian. Later runs take about 20 seconds for both versions.

- `NATIVE_OBSIDIAN=1.14.4 pnpm native`: run only one version.
- `pnpm --dir test/native test -- --spec test/native/specs/smoke.e2e.mjs`:
  run one spec without rebuilding. It uses whatever `main.js` is in the
  repository root.

## Run it in CI

The workflow runs only when started by hand, on any branch:

```sh
gh workflow run native.yml --ref <branch>                       # every spec, ubuntu-latest, Obsidian 1.14.4
gh workflow run native.yml --ref <branch> -f specs="smoke,section-ime*"
gh workflow run native.yml --ref <branch> -f os="ubuntu-latest,macos-latest,windows-latest" -f obsidian="1.13.4,1.14.4"
gh run watch <run id> --exit-status
gh run view <run id> --log-failed
```

Or Actions → "Native harness" → Run workflow, with the same inputs.

| Input | Default | What |
| --- | --- | --- |
| `specs` | empty: every spec | Spec names (`smoke`), file names (`smoke.e2e.mjs`) or globs (`section-*`) under `test/native/specs`, separated by commas or spaces. A name that matches nothing fails the run |
| `os` | `ubuntu-latest` | Runners, comma-separated: `ubuntu-latest`, `macos-latest`, `windows-latest`. Linux is the cheapest; add the others for a platform check |
| `obsidian` | `1.14.4` | Obsidian versions, comma-separated; the pinned ones are `1.13.4` and `1.14.4`. Each version is its own job |

What a run does:

1. **Server.** One job per system checks out `openlfcp/server` at the
   commit in `server.lock` and `openlfcp/sdk-rs` at the server's own
   `sdk-rs.lock`, and builds `lfcp-server` with `cargo build --release
   --locked` (toolchain: the server's `rust-toolchain.toml`). Its target
   directory is cached by system, server commit and `Cargo.lock`: the job
   takes about a minute cold, half a minute cached. The binary goes to the
   harness jobs as an artifact.
2. **Harness.** One job per system and Obsidian version builds the plugin
   and the harness bundles (`pnpm native` without the run), with
   `LFCP_SERVER_BIN` set to that binary and `LFCP_REQUIRE_LIVE=1`. The
   plugin is a **developer build** (`LFCP_DEV_PANE=1`), with the pane
   prototype that `specs/pane-prototype.e2e.mjs` checks; the native set
   never runs the release build. That one is checked by
   `test/bundle.test.ts` (`pnpm test`): built without `LFCP_DEV_PANE`, it
   must not contain the prototype. The live
   specs never skip: without a server they fail. The spec checkout
   (`spec.lock`) is not needed: no native spec reads it.
3. **No skips.** The release assets `specs/upgrade-install.e2e.mjs`
   updates from (0.3.4, 0.4.0-beta.15) are downloaded into the harness
   cache first, and a job whose log reports any skipped test fails.
4. **Known failing.** Specs in `test/native/known-failing.txt` are left
   out of the gating run (below).
5. **Caches.** Obsidian (installer, app, chromedriver) is cached per
   system and version with `actions/cache`, under the runner's temp
   directory (`OPENLFCP_OBSIDIAN_CACHE`).

Every spec on `ubuntu-latest` with one Obsidian version takes about 20
minutes in all: half a minute to a minute for the server, about 18 for
the specs (2026-10-15, 40 spec files).

Results:

- The job summary lists the reporter's totals per spec file.
- The artifact `native-<os>-<version>` holds `native.log` (and
  `known-failing.log` when the known failing step ran): the whole
  WebdriverIO output with the `METRIC {…}` and `EVIDENCE {…}` lines. Get it
  with `gh run download <run id> -n native-ubuntu-latest-1.14.4`, then
  `grep -E 'METRIC|EVIDENCE' native.log`. Its `screenshots/` folder holds
  the screenshots of `specs/pane-prototype.e2e.mjs` (`LFCP_SCREENSHOT_DIR`).
  Cite the run id in a PR's evidence. Metrics vary by runner and never
  gate.
- A failure: `gh run view <run id> --log-failed` shows the failing step;
  the spec reporter's error and stack are in `native.log` (search for
  `✖` or `failing`). Rerun only the failing spec with `-f specs=<name>`.

### Known failing

`test/native/known-failing.txt` lists the specs that fail for a known
reason, each with the task that fixes it. One spec per line: its name
without `.e2e.mjs`, whitespace, the task ID (`LFCP-NN-NNN`), for example
`acceptance-sections  LFCP-03-033`. Blank lines and lines starting with
`#` are ignored. A line without a task ID, or naming no spec, fails the
run. The workflow passes each listed spec that the run selected
to WebdriverIO as `--exclude`, so the gating run never sees it. Nothing is
skipped, and the "No spec skipped" check stays as strict as before. A
separate step, "Known failing specs (not gating)", then runs only those
specs with `continue-on-error: true`:

- a spec that fails is reported as `KNOWN FAILING (<task>)` in the job
  summary and as a notice; the job stays green;
- a spec that passes gets the warning "remove it from the list". Remove
  its line in the same change that fixes it.

A limit: the step looks only for the spec's `PASSED` line. So it reports
`KNOWN FAILING` also when the spec never ran, because the build or the
harness itself failed. Check `known-failing.log` before you treat that
line as the spec's own failure.

Its whole output is `known-failing.log` in the run's artifact. Add a line
only with a task that tracks the failure, never to make a run green.

## What it never touches

- **No installed Obsidian.** Obsidian is downloaded into the harness cache
  (below) by [obsidian-launcher](https://www.npmjs.com/package/obsidian-launcher).
  It is never `/Applications/Obsidian.app` or another installed copy.
- **No user settings or vaults.** Each run gets a throw-away configuration
  directory (Electron `--user-data-dir`) and a throw-away copy of the test
  vault `test/native/vaults/basic`, both in the system temp directory and
  removed afterwards. Your own Obsidian can stay open: a separate
  configuration directory makes a separate instance. The first run was
  checked against this: the mtime of the owner's `obsidian.json` did not
  change.
- **One instance at a time.** `test/native/run.mjs` refuses to start while
  a process from the harness cache runs. After WebdriverIO exits, it waits
  up to 5 s for Obsidian's helpers to exit. If any process remains, it
  lists it, terminates it and fails the run. It looks only at processes
  whose command line contains the cache directory, so it never sees or
  stops another Obsidian.

- **The plugin's files in a test vault are this checkout's.** The harness
  puts `main.js`, `manifest.json` and `styles.css` into
  `.obsidian/plugins/shared-tasks/` of each vault copy as **hard links** to
  this checkout's files: not copies, and not symbolic links (a symlink
  check does not see them). A spec that writes them in place writes the
  checkout's build and manifest. Remove a file first, then write it, as
  `specs/upgrade-install.e2e.mjs` does when it installs another version.
  The upgrade spec's first runs (2026-10-14) replaced this checkout's
  `main.js` and `manifest.json` with 0.4.0-beta.15's that way.

## The cache

| | |
| --- | --- |
| Where | `~/Library/Caches/openlfcp-obsidian-cache` on macOS, `${XDG_CACHE_HOME:-~/.cache}/openlfcp-obsidian-cache` elsewhere, or `OPENLFCP_OBSIDIAN_CACHE` |
| Not in the temp directory | macOS deletes temp files it has not seen accessed for some days. On 2026-10-10 that left a cached app without its `Info.plist` and signature, and macOS killed it at launch ("Chrome instance exited"). `pnpm native` now refuses to start with such an app and names it |
| What | per version: the desktop installer (~540 MB), the app bundle (~25 MB); plus chromedriver (~70 MB) |
| Size | about 630 MB for one version, 1.2 GB for both pinned versions |
| Delete | any time: `trash ~/Library/Caches/openlfcp-obsidian-cache` (macOS). The next run downloads again |

## Pinned Obsidian versions

| Version | Why |
| --- | --- |
| 1.13.4 | The manifest's `minAppVersion` since 0.3.2, and the earliest **public** 1.13 build. The earlier minimum, 1.13.1, was an Insider-only beta (`isBeta` in obsidian-launcher's version list): it cannot be downloaded without an Obsidian Insiders account, and the harness uses none |
| 1.14.4 | The latest public build (also the version the owner tests with by hand) |

The app and the installer are the same version, as for a fresh install.
Change the pins in `test/native/wdio.conf.mjs`.

## Tools and versions

WebdriverIO with [wdio-obsidian-service](https://www.npmjs.com/package/wdio-obsidian-service),
chosen over Playwright on Electron. Playwright would leave the download of
Obsidian versions, the configuration sandbox and the plugin install to us;
the service does all three and provides `browser.executeObsidian`.

Exact pins, each at least two weeks old when chosen (2026-10-08):

| Package | Version |
| --- | --- |
| wdio-obsidian-service | 3.2.1 (3.3.0 was two days old) |
| webdriverio, @wdio/cli, @wdio/local-runner, @wdio/mocha-framework, @wdio/spec-reporter | 9.32.0 |
| obsidian (types, the service's peer) | 1.13.1 |

The harness is a separate package: about 460 packages and 140 MB of
`node_modules` that the plugin's build, its root `pnpm install`, the root
`tsconfig.json` and Biome never see (`test/native` is excluded from both).
The community directory's build verification and `release.yml` do not
touch it either.

## Specs

| Spec | What it checks |
| --- | --- |
| `specs/smoke.e2e.mjs` | The plugin is enabled, registers its commands, and its runtime reaches `ready` |
| `specs/host-facts.e2e.mjs` | Obsidian host facts that MVP 0.2 designs rely on; see [obsidian-host-facts.md](obsidian-host-facts.md) |
| `specs/projection-race.e2e.mjs` | Regression (0.3.2): a collaborator's change arriving right after sharing and editing is not sent back |
| `specs/adr-0001-spikes.e2e.mjs` | ADR 0001 spikes S1–S6: CodeMirror transactions, undo grouping, several views, external writes, cost, Live Preview; through the test-only plugin `plugins/cm-spike` |
| `specs/tasks-plugin.e2e.mjs` | The Obsidian Tasks plugin (8.4.0) next to Shared Tasks: the lines it writes when toggling a Task (plain, inline ref, child-line ref, recurring) and its transactions |
| `specs/section-metadata.e2e.mjs` | LFCP-02-048 in Shared Tasks itself: a section's binding lines hidden in Live Preview, standalone refs kept, the boundary line, "Show or hide sharing metadata" |
| `specs/marker-hiding.e2e.mjs` | LFCP-02-048 spike: hiding binding lines in Live Preview with the test-only plugin `plugins/marker-spike` (installed disabled, enabled by this spec); results in [../reports/marker-hiding-spike.md](../reports/marker-hiding-spike.md) |
| `specs/section-sync.e2e.mjs` | LFCP-02-041..043: the section engine in the editor on a fake SDK, in Live Preview and Source mode: typing becomes one batch after the idle (status "edited" first), a collaborator's change arrives while the user types (both kept, the caret where it was), an emoji selection typed over (scalar positions), a new paragraph gets its ID and marker; Enter after a Task keeps its child-line ref with it (MS27, MS28) and one undo removes the new line; a paragraph removed with its marker is deleted; through `plugins/section-sync` |
| `specs/section-preview.e2e.mjs` | The shared sections preview in Shared Tasks itself (sections on, real SDK, no server): a section Resource created and its section committed locally; typing in a note becomes a commit in the section's replica and the new paragraph's marker is written; the flag is switched off again; "Share section…" shows exactly the range under the heading, private text outside, and a heading inside disables Share |
| `specs/baseline-0.3.e2e.mjs` | Baselines of the 0.3 plugin: start, "Share selected tasks" with 200 Tasks, edit → queued, change → render. Prints `METRIC {…}` lines; results in [obsidian-host-facts.md](obsidian-host-facts.md) |
| `specs/section-cut-paste-move.e2e.mjs` | Two-Obsidian check step 6 (0.4.0-beta.5): A, offline, cuts a Task and pastes it one place up within one pass (real Cmd+X, Cmd+V); the headless peer moves it last; after reconnecting both report one placement conflict, on that Task; Review conflicts asks one question, names each place by its position ("After Task …"), chooses nothing beforehand, and the place chosen is where both vaults show it. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-ime.e2e.mjs` | IME in a shared section (owner check B13): a simulated composition (compositionstart/end, composed edits) in real Obsidian commits nothing while open, then the composed word and its deletion sync: no refused Text edit, no LOCAL_SAVE_FAILED. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-ime-enter.e2e.mjs` | IME-3 of the owner's check of 0.4.0-beta.6, Live Preview with a headless peer B: a space and a composed word at the end of the paragraph, a real Enter at the end of a Task line, a composed word in the new Task; both vaults show each once, A CURRENT with nothing kept. Then vault C's state built directly (B shows the word twice, A's base drifted, A's note lost it): A shows the model's text again by itself, deletes nothing at B, CURRENT, and says so. Then typing in the healed paragraph at once (0.4.0-beta.7: older text came back) stays and syncs; and typing through a heal is never set back, the model takes nothing at a wrong place, and what was typed is kept as a local copy. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-blank-lines.e2e.mjs` | Blank lines in a shared section (owner check of 0.4.0-beta.8), Live Preview with a headless peer B: a real Enter at the start of a paragraph is a blank line before its marker, no new node, B unchanged, CURRENT; then B splits the paragraph at its start (as 0.4.0-beta.8 did) and A deletes the empty paragraph's empty line: the two markers bind, CURRENT. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-lp-markers.e2e.mjs` | Live Preview around a section's hidden binding lines, with a headless peer B: typing at the start and the end of a Task line, Enter at the end of the last Task, a paste of two Task lines, a mouse drag onto a hidden ref line (snaps to the whole line; a copy takes no half marker), Backspace at the start of the first Task's text (ATTENTION, nothing deleted at B, Undo makes it whole), and one-character deletes next to a hidden binding line, which change nothing (Backspace at column 0 under the start marker or a ref takes the caret to the end of the nearest visible line above; Delete at the end of the heading or of the last ref keeps it). After each: no stray marker text, every ID bound once, the section balanced, A's model in the note's order, B's model A's. Checks in `specs/support/section-checks.mjs`. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-undo-redo.e2e.mjs` | Undo and redo across the plugin's writes in Live Preview, with a headless peer B: a cut and paste move and Move line up and down, each written by its pass, undone with Ctrl/Cmd+Z to the first order and redone with Ctrl/Cmd+Shift+Z; the same checks after every key, no duplicated or orphaned ref, the Tasks keep their IDs. Obsidian binds no Alt+Up/Down to Move line, so the spec runs its command and says so. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-idle-remote.e2e.mjs` | A collaborator's edits in a row while vault A is idle, with a headless peer B: B edits a Task's title four times, A never touches the editor; each edit shows in A and A sends no DATA_PUT. Once with the server running, once restarted before each edit. Up to 0.4.0-beta.13 every second edit was reverted. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-two-panes.e2e.mjs` | One shared section in two panes, with a headless peer B: typing in both alternately, a cut in one pane pasted in the other (within one pass, and after the cut's pass), Move line in one pane while the other has focus, a pane closed with an edit or a cut its pass has not seen; then two copies of the section in two notes side by side. The same checks as `section-lp-markers`; a moved Task keeps its ID. A Move line next to a Task cut and pasted earlier names the Task moved, and a cut in one copy is followed by the other copy (nothing held) and its paste there is a move. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-access-mid-edit.e2e.mjs` | Access removed while a member's work is pending (gap 8), with a headless peer B and the member's network switched off: B's pending edit, and a cut whose paste comes after the removal, are held (blocked) and kept in B's note, never in A's; then A as the member, in the plugin's own UI: its pending edit stays in its note, A needs attention and the card says the server no longer accepts its changes. Making a member read-only and giving access back have no path (no grant to an existing member; a new invitation answers "already-member"). Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-remove-invite.e2e.mjs` | Remove someone, invite someone new (soak finding #3 on 0.4.0-beta.17): A removes headless peer B with "Remove access…" (the Data Epoch rotates) and, with no edit since, invites a new identity C with its own UI; C loads the whole section through A's Snapshot of the new epoch, within seconds. Then the same with A's plugin reloaded between the removal and the invitation. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-shift-down-cut.e2e.mjs` | The owner's check of 0.4.0-beta.19, step 4: headless B nests Delta under Gamma; in A (Live Preview, real keys) the caret at Gamma's line start, Shift+Down (it ends after Delta's indentation), Cmd+X, the caret at Alpha's line start, Cmd+V. Every Task keeps its binding line, A stays CURRENT, B gets Gamma first. Before f04c5e3: Alpha indented under Gamma and Delta out of it, both bindings damaged, ATTENTION. |
| `specs/section-whole-line-cut.e2e.mjs` | The owner's check of 0.4.0-beta.19: "- [ ] Gamma" selected with a real mouse drag from the line's end to its start, Cmd+X, Cmd+V at Alpha's line start: the same Task (its ID) moved, every binding in place, A CURRENT, B has the move; then Backspace on Delta's selected line: Delta deleted in A and B, no binding left behind. Before withBindingLines: only the Task's text was cut ("Gamma- [ ] Alpha 4", a new ID), orphaned refs, ATTENTION. |
| `specs/section-stale-epoch.e2e.mjs` | Offline edits in vault A across an unrelated removal (§19.1): B (headless) owns a section, A and C are members; A, offline, edits a Task title; B removes C (the Data Epoch rotates); A comes back. The edit stays in A's note, is re-applied and reaches B, A ends current. When B changed the same title meanwhile, A needs attention, the card says so and "Review conflicts…" offers Keep (send again) or Discard; Keep sends it. A member whose first edit went stale keeps it in its note, needing attention (sdk-ts cannot send it yet, §26.2). Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-review-conflicts.e2e.mjs` | Review conflicts beyond placement (coverage gap 7): A owns a section, the headless peer B is a member; B, offline, and A change the same Task. A Task's title changed by both, A choosing in "Review conflicts…" or B choosing first; a Task A deleted while B changed it, A choosing Keep it deleted or B choosing Restore first. A needs attention, then both notes show the same Tasks, A's badge is CURRENT and B has nothing to review or send. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-resolve-dispatch.e2e.mjs` | "Resolve shared task conflict" by where the cursor is (F-05, U03-24): A shares a section, the headless peer B joins. With the cursor on a Task of the section the command opens that section's "Review conflicts…" and gives no "newer version" advice; on a plain Task below the section the 0.1 command answers as before. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-restart-mid-pass.e2e.mjs` | A restart of the plugin in the middle of a pass (coverage gap 5): A types on a Task; its pass stops right after the journal reached ids-allocated, committed or projected, or after the projection's base was saved; the plugin is disabled and enabled again. The edit reaches B once, both notes agree, A ends CURRENT and nothing moves afterwards. Reference server at `LFCP_SERVER_BIN`. |
| `specs/section-other-plugins.e2e.mjs` | Other plugins changing a shared section (coverage gap 10): A owns a section, the headless peer B is a member. A Linter-style rewrite of the whole note through `vault.process` (open, and while another note is open: trailing spaces, list markers, blank lines), a Task's line deleted through the editor API with no user event (with and without its ref line), Templater-style insertions at the cursor (an empty line, the end of a Task's line before its hidden ref, a CodeMirror transaction with no user event). Nothing that was in the section is lost; while A's badge is CURRENT its section shows what B's does; a deletion without a user event needs attention, with the damaged line named. Reference server at `LFCP_SERVER_BIN`. |
| `specs/pane-prototype.e2e.mjs` | LFCP-03-007, first run in CI with LFCP-03-031 (passed on Linux, Obsidian 1.14.4): the developer pane prototype on mock facts. No command without the `developerPanePrototype` flag; each scenario and fixture in a narrow pane, light and dark, with the fixture's primary action and a screenshot in `$LFCP_SCREENSHOT_DIR` (default: the temp directory); share → invite by keyboard, focus kept in the pane, the flow keeping its note when the active note changes. Needs a developer build, `LFCP_DEV_PANE=1 pnpm native`: a release build leaves the prototype out (D11). `native.yml` builds with `LFCP_DEV_PANE=1` and keeps the screenshots in its artifact. See [../reports/ux-prototype-0.3.md](../reports/ux-prototype-0.3.md) |
| `specs/pane-share-invite.e2e.mjs` | LFCP-03-014: share and invite as one journey in the Shared Tasks pane, without the palette. A opens the pane from the ribbon; on a private heading it shows the share preview with the sync server; "Share section…" opens the share dialog (which names the server too); once hosted the pane says "ready to invite" and offers "Invite collaborator…"; the role is chosen in its dialog; the invitation dialog says the one-time link rule (D2) and keeps the link hidden until "Show link"; "Copy link" makes the pane say "Link copied" when the system clipboard takes it. The headless peer B claims the link and holds the section. Reference server at `LFCP_SERVER_BIN`. |
| `specs/upgrade-install.e2e.mjs` | Install and upgrade (069, [support-matrix-0.2.md](support-matrix-0.2.md)): a fresh vault each time (`reloadObsidian` with no plugin enabled), the plugin's files written into it as an update writes them, then enabled. A fresh install of this build; 0.3.4 with 0.1 shared tasks joined from the headless peer B and an edit pending (the server down) updated to this build; 0.4.0-beta.15 with a shared section and an edit pending updated to this build; disabled and enabled, uninstalled and installed again. The older versions are their GitHub release assets, cached in the harness cache under `releases/<version>/` (a case without them is skipped). Reference server at `LFCP_SERVER_BIN`. |

Each run also installs the Obsidian Tasks plugin 8.4.0 (released
2026-08-25) **disabled**; only `specs/tasks-plugin.e2e.mjs` enables it, so
the other specs run without it.

Besides the plugin under test, each run installs `plugins/cm-spike`: a
test-only plugin (never shipped) that records CodeMirror transactions and
exposes `window.__lfcpSpike` to the specs. It uses only the public API the
plugin itself would (`registerEditorExtension`, the app's `@codemirror`
modules), since a page script cannot load those modules.

`plugins/section-sync` (installed disabled; `specs/section-sync` enables
it) is built from TypeScript, unlike the spikes:
`test/native/section-sync/main.ts` bundles the section engine, the editor
extension (`src/obsidian/section-editor.ts`) and the fake SDK port
(`test/core/sections/fake-port.ts`) into its `main.js`
(`scripts/build-native-harness.mjs`, run by `pnpm native`; the bundle is
gitignored). It exposes `window.__lfcpSectionSync`. Mock SDK on a real
host: the SDK binding replaces the fake; IME stays the manual
[checklist](ime-checklist.md).

Specs are plain ES modules run by Mocha. The `browser` and `expect` globals
come from WebdriverIO. `browser.executeObsidian(({ app, obsidian }) => …)`
runs a function inside Obsidian and returns its JSON result.
