# Two-Obsidian check of a beta

A short manual run of a 0.4 beta on two real Obsidian vaults, for the owner
before a beta is announced. It covers what the native harness cannot see
with a person's eyes (the native acceptance report,
[reports/native-ux-status-acceptance.md](../reports/native-ux-status-acceptance.md)):
an invitation, editing one section together, offline work, a conflict, and
removing access. The full reviewer script, with every check, is the
two-vault demonstration in `openlfcp/examples`
(`docs/demos/two-vault-sections.md`).

**Setup.** Two vaults, A and B: on two computers, or both on one. Install
the beta in each with BRAT ("Add a beta plugin for testing",
`openlfcp/obsidian`, the beta version) and enable Shared Tasks. Keep the
default server. In A, write a note with a heading `## Plan`, three Tasks
under it, a paragraph, and a line `PRIVATE-A` above the heading. Record the
Obsidian version, the OS and the beta version.

| # | Do | Expect |
| --- | --- | --- |
| 1 | A: cursor on `## Plan`, **Share section…**, then **Share**. | The preview shows the Tasks and the paragraph, not `PRIVATE-A`. The notice says the section is shared; ✓✓ on the heading turns green. |
| 2 | A: **Invite collaborator**, pick the section, **Read + write**, **Copy link**. Send it to B privately. | "The server has the invitation: the link works now." |
| 3 | B: **Join collaboration**, paste the link. Then in any note, **Insert shared section…**, **Insert**. | The join stages run; "joined the shared section…". The section appears in B's note, B's own text untouched. |
| 4 | B: add a Task in the section. A: check a Task and edit the paragraph. | Each vault shows the other's changes within seconds; the badges end green. |
| 5 | Turn off the network for both vaults. A: edit the paragraph; B: edit a Task's text. Quit and reopen B. | Badges show "Offline; local updates will wait"; after the restart, B's edit is still there, "Saved locally; waiting to sync". |
| 6 | Still offline, in Source mode: A moves one Task (with its `lfcp-ref` line) under another Task; B moves the same Task elsewhere. Turn the network back on. | The text edits merge on both sides. Both badges show "Needs your attention"; **Go to next shared section problem** finds the moved Task. |
| 7 | A: click the badge, **Review conflicts…**, pick a place, **Apply**. | Both vaults show the Task once, in that place; the attention clears. Nothing else is lost. |
| 8 | A: in the details card, **Remove access…** on B's row, confirm. Then B edits the section. | A: "Removing access: waiting for the server" until the server confirms. B: "Your access to this section was removed. Your local copy stays…"; A never gets B's edit. |

**Record** pass or fail per row, with what differed. On a failure, run
**Export diagnostics…** in the vault that misbehaved and attach the report
(it holds no note text, names, paths or keys) to an issue with the row
number.
