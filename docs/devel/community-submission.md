# Community directory submission (draft)

Prepared for the owner (POST-011); **not submitted**. Submit only after a
BRAT beta of the same version has run in clean vaults ([release.md](release.md)).

## The entry

Appended to `community-plugins.json` in
[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases):

```json
{
  "id": "shared-tasks",
  "name": "Shared Tasks",
  "author": "OpenLFCP",
  "description": "Share tasks between vaults, end-to-end encrypted, without uploading your notes.",
  "repo": "openlfcp/obsidian"
}
```

`id`, `name`, `author` and `description` must equal `manifest.json` at the
released tag.

## Pull request text

> **Title:** Add plugin: Shared Tasks
>
> Shared Tasks shares individual tasks between vaults, end-to-end
> encrypted, without uploading your notes. Each shared task stays a normal
> Markdown task line in every vault; changes sync through an OpenLFCP sync
> server chosen by the user (by default the project's public server,
> disclosed in the README with its privacy note and terms).
>
> - Repository: https://github.com/openlfcp/obsidian
> - Release: https://github.com/openlfcp/obsidian/releases/tag/X.Y.Z
>   (main.js, manifest.json, styles.css)
> - Network use: only to the sync servers of the user's collaborations
>   (wss://), with end-to-end encrypted payloads; no telemetry, no account.
> - Tested on: macOS (desktop). Windows and Linux: automated smoke; mobile:
>   not tested (isDesktopOnly is false: no Node or Electron APIs are used).

Then tick the template's checklist in the PR body.

## Checklist the owner runs before opening the PR

- [ ] A BRAT beta of the same version installed from the release in a
      clean vault, with the two-vault demo passed.
- [ ] The release tag equals `manifest.json` `version` (bare, no `v`), and
      the release has `main.js`, `manifest.json` and `styles.css` as assets.
- [ ] `manifest.json`: ID `shared-tasks` (lowercase; not in the
      directory yet); name without "Obsidian" or "Plugin"; the description
      is one sentence ending with a period and has no "Obsidian";
      `minAppVersion` set; `isDesktopOnly` as intended (false).
- [ ] The ID and the name are still free in `community-plugins.json`
      (checked free on 2026-10-06).
- [ ] The README states the purpose, how to use it, network use and the
      default server with its privacy note and terms; `LICENSE` exists
      (Apache-2.0).
- [ ] The plugin has no default hotkeys, no telemetry, no `console.log`
      in normal use, no `innerHTML` and no remote code.
- [ ] `versions.json` maps the version to its `minAppVersion`.
- [ ] Read the review comments of the directory bot and fix them in a new
      patch release; the entry needs no change for later versions.

Assumed from the well-known directory rules, since no copy of the
current `obsidian-releases` guidelines is in this repository: the bare
version tag; the three assets; no "Obsidian" or "Plugin" in the name; a
description ending in a period; disclosure of network use; no default
hotkeys. Check the current guidelines before submitting.
