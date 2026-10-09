# Releasing the plugin

How a version of Shared Tasks (plugin ID `shared-tasks`) is released
(POST-011). CI builds the release; people only tag.

## Tag convention

The release tag is **the bare version**: `0.2.0`, not `v0.2.0`. Obsidian,
BRAT and the community directory look up a release by a tag equal to
`manifest.json`'s `version`. Only bare `x.y.z` tags run
`.github/workflows/release.yml`; a `v` tag runs nothing, and
`scripts/release-assets.mjs` refuses a tag that is not the manifest version.

Tag only the bare version. The old `v0.1.0` stays as it is: it has no
release assets and no install path. Project-wide references can name the
plugin version and the commit, as the other repositories' `v` tags do;
a second `v0.2.0` tag on the same commit would be harmless but adds
nothing.

## What the workflow does

On a pushed tag `X.Y.Z`:

1. It checks out the tagged commit and spec at `spec.lock`, as CI does;
   the SDK is the `@openlfcp/*` npm packages locked in `pnpm-lock.yaml`.
2. It runs build, lint, typecheck and the tests.
3. `node scripts/release-assets.mjs --tag X.Y.Z` checks that the tag,
   `manifest.json`, `package.json` and `versions.json` agree. It then
   writes `release/main.js`, `manifest.json` and `styles.css`, and checks
   that nothing else is there: the community directory flags extra release
   assets (0.3.0 had a zip).
4. `actions/attest` signs SLSA build provenance for `main.js`,
   `manifest.json` and `styles.css` (check one with `gh attestation verify
   main.js --repo openlfcp/obsidian`).
5. It needs `docs/releases/X.Y.Z.md` (non-empty), the release notes.
6. `gh release create X.Y.Z` attaches the three files, with the notes as
   the body.

## The owner's steps

1. On `main`, with CI green and pushed: `manifest.json`, `package.json`
   and `versions.json` say `X.Y.Z`, and `docs/releases/X.Y.Z.md` exists.
   Check locally: `node scripts/release-assets.mjs --tag X.Y.Z`. It ends
   with `release: Shared Tasks X.Y.Z (shared-tasks) in release/`.
2. Tag and push the tag:

   ```sh
   git tag -a X.Y.Z -m "Shared Tasks X.Y.Z"
   git push origin X.Y.Z
   ```

3. Watch the "Release" workflow. Check the release page: three assets, and
   the manifest asset shows `"id": "shared-tasks"` and the version.
4. BRAT beta, in a clean vault with Restricted mode off:
   - install BRAT;
   - run "BRAT: Add a beta plugin for testing" with `openlfcp/obsidian`;
   - BRAT installs `X.Y.Z` into `.obsidian/plugins/shared-tasks/`;
     enable Shared Tasks.
   Then run [testing/load-in-clean-vault.md](testing/load-in-clean-vault.md),
   and create a collaboration on the default server. The line under the
   server field names the project and links its privacy note and terms.
   Join it from a second vault.
5. A broken release: delete the GitHub release and the tag, fix, and
   release the next patch version. Never re-tag a published version:
   BRAT users may have it.

## Betas (pre-releases)

A beta (LFCP-02-094) runs the pilot without updating catalog users: it is
tagged `X.Y.Z-beta.N` and published as a GitHub **pre-release** with the
same three attested assets. BRAT installs it; the community directory and
Obsidian's own updates ignore pre-releases.

`manifest.json` on `main` keeps the catalog version until GA (B14). A
beta's manifest asset comes from `manifest-beta.json` at the repository
root: the same manifest with `"version": "X.Y.Z-beta.N"`.
`scripts/release-assets.mjs` refuses a beta whose `manifest-beta.json` is
missing, differs from `manifest.json` in anything but the version, has
another version than the tag, or is not newer than the catalog version.
`package.json` and `versions.json` stay the catalog's.

Before the first beta with shared sections: 087 is released (0.3.2 on
`@openlfcp/*` 0.1.3), the owner has decided the public server quotas
(B15), and 098 is fixed or accepted for the beta (B8). The release
workflow builds only from the `@openlfcp/*` npm packages
(`scripts/check-release-deps.mjs`), so the beta's commit carries npm
versions of the SDK, not the development pin.

### The owner's steps for a beta

1. On `main`, pushed with CI green: `manifest-beta.json` with the beta
   version, and `docs/releases/X.Y.Z-beta.N.md`. Check locally:

   ```sh
   node scripts/release-assets.mjs --tag 0.4.0-beta.1
   ```

   It ends with `release: Shared Tasks 0.4.0-beta.1 (shared-tasks)
   pre-release in release/`.

2. Dry run on GitHub, without a tag: it runs every check and builds the
   assets, and releases nothing.

   ```sh
   gh workflow run release.yml --repo openlfcp/obsidian --ref main -f version=0.4.0-beta.1
   gh run watch --repo openlfcp/obsidian
   ```

3. Tag and push the tag:

   ```sh
   git -C ~/dev/openlfcp/obsidian tag -a 0.4.0-beta.1 -m "Shared Tasks 0.4.0-beta.1"
   git -C ~/dev/openlfcp/obsidian push origin 0.4.0-beta.1
   ```

4. Check the release: a pre-release, three assets, the manifest asset at
   the beta version, provenance attested.

   ```sh
   gh release view 0.4.0-beta.1 --repo openlfcp/obsidian --json isPrerelease,assets
   gh release download 0.4.0-beta.1 --repo openlfcp/obsidian --dir /tmp/st-beta
   grep '"version"' /tmp/st-beta/manifest.json
   gh attestation verify /tmp/st-beta/main.js --repo openlfcp/obsidian
   ```

5. Install it with BRAT, in a clean vault with Restricted mode off:
   - install BRAT from Community plugins;
   - run "BRAT: Add a beta plugin for testing", enter `openlfcp/obsidian`,
     and pick the version `0.4.0-beta.1` (or the latest version, which
     includes pre-releases);
   - enable Shared Tasks; Settings → Community plugins shows
     `0.4.0-beta.1`.
   Pilot users do the same. A later beta reaches them through BRAT's
   update check.

6. Leaving the beta: remove the plugin from BRAT and install Shared Tasks
   from Community plugins. A 0.4 beta upgrades local data, which 0.3.x
   cannot open ([../releases/0.4-compatibility.md](../releases/0.4-compatibility.md)):
   tell pilot users before they go back.

A broken beta is never re-tagged: release the next `-beta.N`.

The community directory submission comes after a BRAT beta; see
[community-submission.md](community-submission.md).
