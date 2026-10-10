# Native harness: the plugin in a real Obsidian

The native harness (LFCP-02-096) runs the built plugin in a real Obsidian
desktop app, started from the command line. The specs read Obsidian's state
(the app object, the DOM, CodeMirror) and run commands. The unit tests
(`pnpm test`) cannot reach any of this: they use a mock of the Obsidian API.

Locally with `pnpm native`; in CI by hand: the "Native harness" workflow
(`.github/workflows/native.yml`, Actions → Run workflow) runs it on macOS,
Linux (under `xvfb-run`) and Windows for both pinned Obsidian versions. It
caches Obsidian with `actions/cache` and keeps each log, `METRIC` lines
included, as an artifact. Metrics never gate.

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
