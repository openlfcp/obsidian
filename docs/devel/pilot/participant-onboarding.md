# Pilot onboarding: installing the beta

For the moderator to follow before a pair arrives, and for the participant to
read first. It is **not timed** and is not part of the usability tasks:
installation and the network are checked first and assessed separately. It
names no feature of Shared Tasks beyond installing it, so it does not give
away the tasks. The pilot protocol is
[pilot-protocol.md](pilot-protocol.md).

## What you need

- A computer with Obsidian 1.13.4 or later (Settings → About shows the
  version).
- A way to talk to your partner (a phone call, a chat). You will each need
  the other's help once, and the moderator will tell you when.
- Nothing else: no account, no key, no sign-up. Your identity is created on
  your device when the plugin first starts.

## Install the beta

1. In Obsidian, open the vault the moderator gave you (File → Open folder as
   vault, if it is not open yet).
2. Settings → Community plugins. If it says Restricted mode is on, turn it
   off.
3. Install and enable **BRAT**: Browse, search "BRAT", Install, Enable.
4. Open the command palette and run "BRAT: Add a beta plugin for testing".
5. Enter `openlfcp/obsidian`. For the version choose **Latest version**.
6. Back in Settings → Community plugins, enable **Shared Tasks**.
7. Check that Shared Tasks is listed as version `0.5.0-beta.1`, and that the
   moderator has compared its checksum with the candidate's (the release notes
   list it).

Moderator only: the same files can be put in by hand from the release page
(`main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/shared-tasks/`); the checksum comparison is the
same. Never install a build from the branch tip: the pilot runs the
candidate's exact files.

## The server

The default is already set: the project server
`wss://sync.openlfcp.org/v1/ws`. Settings → Shared Tasks → "Default server"
should show it. Leave it as it is. Before you start, the moderator tells you
what that server can see and keep (it never sees your note text; it sees your
network address and the sizes of what you sync) and gives you its
[privacy note](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md)
and [terms](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md).
The notes in the pilot vault are made-up.

## Pairs

Two people are a pair: one is **A**, the other **B**. The moderator tells you
which you are. A's vault holds a note called `Plan`; B's vault holds a note
called `Sprint notes`. Each of you works on your own computer, with your own
copy of Obsidian, and your own vault. You will not share a vault or an account
with your partner.

Check before the clock starts (moderator, each machine):

- [ ] Obsidian shows the right vault, the right fixture notes
- [ ] Shared Tasks 0.5.0-beta.1, checksum compared
- [ ] Settings → Shared Tasks shows the project server and an identity that is
      ready
- [ ] The machine is online; the moderator and the pair have a channel to send
      a message
- [ ] Obsidian and the machine will not show notifications, update prompts or
      other windows during the session

Then the moderator starts the session as described in the protocol. From that
point nobody explains how Shared Tasks works.
