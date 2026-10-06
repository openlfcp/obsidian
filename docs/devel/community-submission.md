# Community directory submission

For the owner (POST-011). Shared Tasks goes into Obsidian's community
directory through **community.obsidian.md**. The old pull request to
`obsidianmd/obsidian-releases` (`community-plugins.json`) is no longer the
process. Checked against docs.obsidian.md and its source
(`obsidianmd/obsidian-developer-docs`, "Community directory") on
2026-10-07.

Submit after a BRAT beta of the same version has run in clean vaults
([release.md](release.md)).

## What the directory needs

- A public GitHub repository with `README.md`, `LICENSE` and
  `manifest.json` at its root (`openlfcp/obsidian`: all three).
- A GitHub release whose **tag equals `manifest.json` `version`** (`x.y.z`,
  no `v`) with `main.js`, `manifest.json` and `styles.css` attached. The
  release workflow does this ([release.md](release.md)).
- A unique plugin ID without "obsidian": `shared-tasks`. It cannot be
  changed after publication.
- The developer policies: no obfuscation, no ads, no client-side
  telemetry, no self-updating. The README discloses remote services and
  server-side data collection, with a privacy policy link. It does, under
  "Network use" and "Privacy".

## The owner's steps on community.obsidian.md

1. **Make your GitHub membership in `openlfcp` public.** The directory
   offers to claim repositories you own, or that belong to an organization
   where you are listed as a *public* member. GitHub hides org membership
   by default. To change it: github.com/orgs/openlfcp/people → your row →
   "Public". Without this the directory cannot see that you may submit
   `openlfcp/obsidian`.
2. **Sign in** at https://community.obsidian.md with your Obsidian account
   (upper right).
3. **Link GitHub** to your profile. The link is read-only access to your
   public profile and is used to verify repository ownership.
4. **Create the organization** (sidebar → Organizations), so the entry
   belongs to the project and not to a person:
   - handle `openlfcp`;
   - display name `OpenLFCP`;
   - optional: website `https://openlfcp.org`, a bio of at most 500
     characters.
   You are its admin. Others can join later as members (they need a
   community.obsidian.md account with a matching email address). An
   organization cannot be deleted while it owns entries.
5. **Pre-check with "Review branch"** before relying on a release: run
   the automated review on the release tag (for example `0.2.1`) or on
   `main`, and read the result (see "The automated review" below).
6. **Add the plugin:**
   - repository URL `https://github.com/openlfcp/obsidian`;
   - owner: the `openlfcp` organization;
   - accept the developer policies, which include keeping the plugin
     maintained or transferring it properly.
7. **Edit the listing:**
   - icon;
   - descriptions (the manifest's: "Share tasks between vaults,
     end-to-end encrypted, without uploading your notes.");
   - categories (for example tasks, collaboration);
   - payment type **Free**;
   - screenshots (the README's `docs/assets/shared-tasks-demo.gif`).
   Credit people with **Add contributors**; that grants them no edit
   rights.
8. **After the review passes** the entry is published. Later versions need
   no new submission: the directory picks up each new release. Use
   **Check for new releases** if one does not show up.

## The automated review

After each release the directory scans `manifest.json`, the release
assets and the source code, and verifies the build. Each finding is an
error, a warning, a recommendation or a pass. **Warnings do not block.**
Fix errors in the repository, then publish a new release with a higher
version, or use **Request review** to recheck.

- **Build verification: the main risk.** The scanner runs the first of
  the `build`, `build:plugin` or `compile` package scripts. Our `build`
  needs the sibling `sdk-ts` checkout: the `@openlfcp/*` packages are
  `link:../sdk-ts/...` dependencies, built at `sdk-ts.lock`, as CI does.
  The scanner has no such checkout, so the build may fail there. Run
  **Review branch** first.
  - If it reports an error, the remedy is to depend on the published
    `@openlfcp/*` npm packages at the pinned version instead of `link:`.
    That is a change of its own (publish sdk-ts at the lock, switch the
    dependencies, regenerate `pnpm-lock.yaml`).
  - If it only warns, nothing is needed.
- **Source code** is checked with the rules of `eslint-plugin-obsidianmd`
  (the official lint plugin; the recommended config includes
  typescript-eslint's type-checked rules). Run it locally before a
  release:

  ```sh
  mkdir -p /tmp/obsidian-lint && cd /tmp/obsidian-lint
  npm init -y && npm i -D eslint eslint-plugin-obsidianmd typescript@5
  cat > eslint.config.mjs <<'EOF'
  import { defineConfig } from "eslint/config";
  import obsidianmd from "eslint-plugin-obsidianmd";
  export default defineConfig([...obsidianmd.configs.recommended,
    { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: process.env.REPO } } }]);
  EOF
  cd "$REPO" && /tmp/obsidian-lint/node_modules/.bin/eslint -c /tmp/obsidian-lint/eslint.config.mjs --no-cache src
  ```

  (First `export REPO=/path/to/this/checkout`, with `pnpm install` done there.)
- **Licence:** `LICENSE` is Apache-2.0, which GitHub recognises.

Answer review findings in the repository and with a release; a finding
that is a deliberate choice can stay a warning. The reasons for ours are
in the table below.

## Pre-submission audit (2026-10-07, obsidian main after 0.2.0)

| Rule | Status | Where |
| --- | --- | --- |
| Release: tag = version x.y.z; main.js, manifest.json, styles.css assets | pass (0.2.0 published by `release.yml`) | `.github/workflows/release.yml`, `scripts/release-assets.mjs` |
| README, LICENSE, manifest.json at the root | pass | repository root |
| ID unique, without "obsidian"; cannot change later | pass: `shared-tasks`, free on 2026-10-06 | `manifest.json` |
| Description: an action, under 250 characters, ends with a period, no emoji | pass | `manifest.json` |
| `minAppVersion` is the lowest supported version | pass: 1.13.1, the typed and tested API (secretStorage needs 1.11.4) | `manifest.json`, `versions.json` |
| `isDesktopOnly` true if Node or Electron APIs are used | pass: false; no Node in `src/` (boundary check); mobile untested, said in the README | `scripts/check-boundaries.mjs` |
| No `fundingUrl` unless donations are accepted | pass: none | `manifest.json` |
| Command IDs without the plugin ID; names without the plugin name | pass: e.g. `create-collaboration`, "Create collaboration" | `src/core/commands.ts:20` |
| No default hotkeys | pass | `src/obsidian/plugin.ts:101` |
| Sentence case in UI text | fixed: "Read + Write" → "Read + write" (a6b7988). The plugin name "Shared Tasks" and the project name "OpenLFCP" are proper nouns: the lint rule flags them, and they stay | `src/core/collab/presets.ts:32`; warnings at `src/obsidian/plugin.ts:169`, `:389`, `src/obsidian/ui/prompter.ts:161-162`, `src/obsidian/settings-tab.ts:48`, `:82`; `:52` is the `wss://` placeholder |
| No "settings" in settings headings; `setHeading` instead of `<h1>`/`<h2>` | pass: the settings tab has no headings | `src/obsidian/settings-tab.ts` |
| Modal titles | recommendation: modals put their title in an `h3` in the content; `Modal.setTitle()` would be the native place (not flagged) | `src/obsidian/ui/prompter.ts:41`, `:146`, `:198` |
| No `innerHTML`, `outerHTML`, `insertAdjacentHTML`; `createEl`/`createDiv` | pass; `createEl("div")` → `createDiv` (844cca3) | `src/obsidian/ui/prompter.ts:110` |
| No unnecessary console logging | pass: no `console` in `src/` | — |
| No client-side telemetry, ads, obfuscation, self-update | pass | — |
| README discloses remote services and server data collection, with a privacy link | pass: "Network use", the privacy note and terms | `README.md` |
| Clean up on unload; `registerEvent` | pass: vault events through `registerEvent`; the runtime, sessions and timers stop in `onunload` | `src/obsidian/plugin.ts:120` |
| No references to custom views; no `workspace.activeLeaf` | pass: no custom views; `getActiveViewOfType` | `src/obsidian/ui/prompter.ts:280` |
| Editor API for the active note instead of a vault write | deliberate: the active note's unsaved changes are saved first, then `Vault.process` writes atomically and byte-exactly (refs, detach); not flagged by the lint rules | `src/obsidian/ui/prompter.ts:286`, `src/obsidian/plugin.ts:392` |
| `Vault.process` over `Vault.modify`; no iterating files to find one by path; `normalizePath` for user paths | pass: `process`, `getFileByPath`; no user-entered paths | `src/obsidian/plugin.ts:356` |
| No hardcoded styles; CSS classes and variables | pass: `styles.css` uses `var(--text-warning)` | `styles.css` |
| `const`/`let`; async/await | pass: no `var`; `.then` only to chain the serial write queues | `src/core/lfcp/runtime.ts:319` |
| No lookbehind in regular expressions (older iOS) | pass | `src/` |
| typecheck-level lint errors (official recommended config) | fixed: 9 → 0 (844cca3, dc7eede) | see the commits |
| `globalThis` → `window`, `setTimeout` → `window.setTimeout` (popout windows) | warning, kept: process-wide timers, `navigator` and clipboard; the adapter also runs in the Node test environment, where `window` does not exist | `src/obsidian/lfcp-env.ts:55`, `:74-75`, `src/obsidian/plugin.ts:51-52`, `src/obsidian/ui/prompter.ts:120`, `:223`, `src/core/collab/service.ts:234` |
| Declarative settings (`getSettingDefinitions`, 1.13+; `display()` deprecated) | warning, follow-up: the settings tab works; adopting the declarative API makes the settings searchable | `src/obsidian/settings-tab.ts:14`, `:98` |
| Build verification by the scanner | **risk**: `build` needs the sibling sdk-ts checkout; run "Review branch" first | `package.json` |

The fixes since 0.2.0 change a text users see ("Read + write") and the
source the review scans, so they ship as **0.2.1** before submitting.
