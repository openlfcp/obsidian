# Changelog

All notable changes to Shared Tasks (plugin ID `shared-tasks`). The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each entry
is a short summary; the full release notes, with install, upgrade, rollback
and known limits, are the linked files in [docs/releases](docs/releases/).

The Markdown format of your notes and the sync protocol have not changed
since 0.4.0.

## [Unreleased]

### Changed

- The command "Open Shared Tasks pane" has a new ID, `open-pane`
  (it was `open-shared-tasks-pane`), as the Obsidian community review asks.
  A custom hotkey you set on the old command is lost: set it again under
  Settings, Hotkeys.
- The developer pane prototype and its `developerPanePrototype` setting are
  gone. It never shipped in a release build; an old `data.json` that still
  has the key is read as before and the key is ignored.
- Fixes for the warnings of the Obsidian community review: elements are
  made with Obsidian's own helpers, timers come from the window, and the
  damaged-marker line is marked with a solid warning underline instead of
  a wavy one.

## [0.5.1] — 2026-10-25

Sharing a section is harder to get wrong.
Notes: [docs/releases/0.5.1.md](docs/releases/0.5.1.md).

### Changed

- The palette command "Invite to this section…" (new ID `invite-to-section`)
  invites to the shared section at the cursor, as the pane does. With the
  cursor outside every shared section it says so and opens no picker.
- The commands of the older one-task-at-a-time collaborations are named
  "Legacy: …". Except "Legacy: Join task collaboration", they appear in the
  palette only in a vault that already holds such a collaboration (checked
  when the plugin starts and after a join; a vault that joins its first one
  gets them at once). "Legacy: Invite to task collaboration" (the old
  `invite-collaborator` ID, so hotkeys keep working) lists only those
  collaborations, never shared sections.
- A join from the pane or a palette join accepts shared sections only: a
  link to an older task collaboration is refused before it is used, says
  what it is, and still works with "Legacy: Join task collaboration".
- Dead ends say why and what next: "already joined" for an older task
  collaboration, an empty section list on a device with only an older
  collaboration, "Insert shared section…" with nothing to insert yet.
- A section start or end marker changed by a typo shows one problem with
  "Restore", says edits are not sent until it is fixed, and the section
  reads "Damaged in this note"; the pane's main action is the fix.
- With sharing metadata hidden, typing into a marker line in Live Preview
  is refused with a notice; a damaged marker is hidden with a warning mark.

### Fixed

- A one-character change to a section's start marker showed every marker,
  ignored "Show sharing metadata" and silently stopped sending edits (#89).

## [0.5.0] — 2026-10-19

Collaboration you can do without learning the commands.
Notes: [docs/releases/0.5.0.md](docs/releases/0.5.0.md). Pre-releases
(BRAT only): [0.5.0-beta.1](docs/releases/0.5.0-beta.1.md) and
[0.5.0-beta.2](docs/releases/0.5.0-beta.2.md) (fixes #79, #80 and #82, listed
below).

### Added

- The Shared Tasks pane (ribbon icon, command, section card, editor context
  menu): it follows your note and offers the next step, such as "Share
  section…", "Invite collaborator…" or "Insert into a note…", and lists the
  shared sections of this device.
- Share, then invite in one place, with a preview of what a share publishes
  and a one-time invitation of your choice of Read or Read + write.
- "Join with a link…" with visible steps, then insert into a note you choose,
  with a preview. A join that was cut short is checked again, never started
  twice.
- A problem hub that opens the matching conflict dialog or "Repair shared
  sections in this note".
- A share cut short by a restart resumes by itself; an unfinished insert or
  join is listed in the pane, where you continue it or check the result.
- The pane and its dialogs work from the keyboard (commands have no default
  hotkeys).
- Short tips when an action is offered ("Hide tip", "Show tips again"); no
  tour on install or update.

### Changed

- Pasted lines in a section that already syncs are held for your choice
  instead of being replaced by the shared version (closes the 0.4.2 known
  limit, [#41](https://github.com/openlfcp/obsidian/issues/41)).
- A line dropped by Obsidian's merge is reported as missing and can be put
  back with "Repair shared sections in this note".
- Neutral wording on section surfaces; shared sections no longer appear in
  the 0.1 task pickers.
- The pane redraws at once after a cursor move.

### Fixed

- A second Share no longer stays "hosting pending", and the section's
  server record is no longer created twice.
- The first click on "Join with a link…" after a restart and on "Remove
  access…" counts.
- The insert preview no longer says "Not inserted in any note yet" for the
  note the section came from.
- Records of deleted notes are forgotten; your own text is never removed.
- A deletion made while a section is suspended is kept and sent after it
  resumes ([#57](https://github.com/openlfcp/obsidian/issues/57)).
- The stopped-syncing notice names the section and no longer prints the
  server address.
- One "Review conflicts" button beside a single conflict.
- A pending status timer no longer runs after the plugin is unloaded.
- "Choose another note…" in the insert dialog and Apply in the repair and
  recovery dialogs no longer overlap the text.
- "Link copied" is a short confirmation and no longer lingers in the pane.

## [0.4.2] — Task edits in copied sections

Fixes a Task edit in a copy of a shared section that could be lost without a
warning. [Notes](docs/releases/0.4.2.md).

## [0.4.1] — Edits after a restart

Fixes edits to a shared section that could be lost after a restart.
[Notes](docs/releases/0.4.1.md).

## [0.4.0] — Shared sections

Share a heading with everything under it: preview, status marks, conflicts,
removing access, detach, copy and repair. Local encryption of the decrypted
shared state at rest. Developed in twenty betas; one entry here.
[Notes](docs/releases/0.4.0.md), [0.4 compatibility](docs/releases/0.4-compatibility.md).

## [0.3.4] — Security fix

A change from a collaborator with write access could make a collaboration
unusable on your device. [Notes](docs/releases/0.3.4.md).

## [0.3.3] — Security fix

A change from a collaborator with write access could make a collaboration
fail to open. [Notes](docs/releases/0.3.3.md).

## [0.3.2] — Safer with newer collaborations

Safer with newer collaborations and a server that lost data; requires
Obsidian 1.13.4. [Notes](docs/releases/0.3.2.md).

## [0.3.1] — Smaller plugin

`main.js` is 1.9 MB instead of 5.6 MB and builds from a clean clone.
[Notes](docs/releases/0.3.1.md).

## [0.3.0] — Many tasks at once

"Share selected tasks" and "Insert all tasks from collaboration".
[Notes](docs/releases/0.3.0.md).

## [0.2.1] — Refused collaborations say so

A collaboration the server refuses for good now shows one notice and its
reason. [Notes](docs/releases/0.2.1.md).

## [0.2.0] — Shared Tasks

The plugin is renamed Shared Tasks (ID `shared-tasks`) and offers the
project's default server. [Notes](docs/releases/0.2.0.md).

## [0.1.0]

First beta, published as "OpenLFCP" (ID `openlfcp`). Upgrading:
[0.2.0 notes](docs/releases/0.2.0.md).
