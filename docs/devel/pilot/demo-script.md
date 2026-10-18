# Demo script for the 0.5 candidate

A script for a person showing the candidate on two real Obsidian vaults, about
10 minutes. It is the guided version of what the pilot asks participants to
find for themselves, so **never use it with a pilot participant before or
during their session**. It claims only what 0.5.0-beta.1 does; for the
longer manual check, see
[two-obsidian-beta-check.md](../testing/two-obsidian-beta-check.md), and for
the scripted two-vault demo, [two-vault-demo.md](../../demos/two-vault-demo.md).

**Setup.** Two vaults from `test/fixtures/pilot/` (A and B), the candidate
installed in both (the release notes' Install), the default server. Two
windows side by side, or two computers. Record the build and its `main.js`
checksum.

| # | Say and do | What the audience should see |
| --- | --- | --- |
| 1 | "Two people, two private vaults. Nothing is shared yet." Show both notes. | `Plan.md` (A) and `Sprint notes.md` (B), with private lines. |
| 2 | A: click the **Shared Tasks** ribbon icon. | One pane opens; no dialog, no tour. With the cursor on `## Launch` it offers "Share section…". |
| 3 | A: choose **Share section…**. Read the preview. | The preview lists the Launch lines and the sync server; the private lines and `## Budget` are not in it. Confirm. |
| 4 | Wait for the pane to say the section is shared and ready to invite. | "Shared and on its sync server: ready to invite." and a green ✓✓ on the heading. |
| 5 | A: **Invite collaborator…**, choose **Read + write**, **Copy link**. | The dialog says the link is one-time, does not expire, and the first person to open it joins. After copying: "Link copied". Say that the plugin sent nothing. |
| 6 | Pass the link to B privately (a chat message). | The link is the only thing that travels. |
| 7 | B: open the pane, **Join with a link…**, paste the link, **Join**. | The steps appear one by one: the server accepted the claim, access read and write, loaded on this device. |
| 8 | B: **Insert into a note…**, choose `Sprint notes`, read the preview, **Insert**. | The section appears in B's note below B's own text; B's text is untouched. The pane tells the result. |
| 9 | A ticks a Task; B changes a Task's text. | Each change shows on the other side within seconds. |
| 10 | Both go offline; each edits; both come back. | The badge shows "Offline; local updates will wait", then current. Edits from both sides are there. |
| 11 | A and B move the same Task, differently, while offline. Reconnect. | "Needs your attention". Open the pane (its problem hub lists it) and choose **Review conflicts…**; pick one; both show the Task once, in the same place. |
| 12 | Say what ✓✓ means: "shared", not "seen". Show `PILOT-PRIVATE-A` is not in B's vault. | The privacy markers stay in their own vaults. |

**What not to say.** There is no read receipt, no "delivered" state, no inbox
of invitations and no way to cancel a link; do not imply any. The link works
once for whoever opens it first. Mobile shows sections read-only and has not
been tried.

**If something goes wrong.** Do not retry with a fresh vault to hide it:
note the step, run "Export diagnostics…" in the vault that misbehaved (it holds
no note text, names, paths or keys), and report it with the build checksum.
