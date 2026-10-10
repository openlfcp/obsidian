# Shared sections on mobile: manual checklist (LFCP-02-095)

On Obsidian mobile, shared sections are **read-only** (owner decision V3):
they are received and shown, and nothing written on the device is shared.
0.1 shared tasks keep working. `isDesktopOnly` stays `false`. Automated
evidence: `test/core/lfcp/runtime-sections.test.ts` (the runtime with
`sectionsReadOnly`), `test/mobile.test.ts` (no desktop-only API in the
sections path, the manifest flag). These steps are for one real device.

Use test vaults and a test collaboration only, never a personal vault.

## Setup

1. On a desktop, in a test vault (`node scripts/demo-vaults.mjs --sections`
   prepares one): share a section and invite a second identity with
   "Read + write".
2. On the phone or tablet: install the build (BRAT beta or the plugin
   files copied into `.obsidian/plugins/shared-tasks/`), join with the
   invitation, and insert the section into a note.

## Checks

| # | Step on the device | Expected |
|---|---|---|
| M1 | Open the note with the section. | The section shows; its badge says "read-only" (tooltip and details). |
| M2 | On the desktop, edit the section's text and a Task. | The device's note shows both changes. |
| M3 | On the device, type into the section and wait. | The text stays in the note. The badge shows that a local edit was not sent. Nothing reaches the desktop. |
| M4 | Run "Share section…" on another heading. | A notice says shared sections are read-only on this device. Nothing is created. |
| M5 | Open the section's details. | No "Invite collaborator…" and no "Remove access…". |
| M6 | Run "Detach this section". | The note keeps the text without bindings; nothing changes on the desktop. |
| M7 | In a 0.1 collaboration, check a shared task. | The change reaches the desktop (legacy Tasks work). |
| M8 | Run "Export diagnostics…". | The report opens; Copy works. |

Record for each: the device, its OS and Obsidian version, the plugin
version, pass or fail, and a screenshot of any failure (no note text in
it).
