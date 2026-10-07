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

The community directory submission comes after a BRAT beta; see
[community-submission.md](community-submission.md).
