# Choosing a sync server

A collaboration needs a sync server: it relays the encrypted changes
between your vault and your collaborators' vaults, and keeps a copy so
that people need not be online at the same time. The server is not your
identity and does not own your collaborations: your identity is a key pair
on your device, and you own what you create. The server cannot read your
tasks: they are encrypted on your device before they leave it.

## The default: none

The plugin ships with **no default server**: Settings → OpenLFCP →
"Default server" is empty. You choose a server the first time you run
"Create collaboration".

## Where the server is used

- **Creating a collaboration.** "Create collaboration" asks for the sync
  server, pre-filled with the default server. That URL becomes the
  collaboration's server and its coordinator (the server that orders
  membership changes). It is written into the collaboration's first signed
  record, so **it cannot be changed later**: MVP 0.1 has no command to move
  a collaboration to another server. Choose before you create.
- **Joining a collaboration.** The server comes from the invitation link,
  which carries the inviter's server. The default server plays no part.

So the default server only saves typing when you create collaborations.

## Using the public server sync.openlfcp.org

The OpenLFCP project runs a free public server:

```text
wss://sync.openlfcp.org/v1/ws
```

To make it your default: Settings → OpenLFCP → "Default server", paste
the URL above. Or paste it into the "Sync server" field when you create a
collaboration.

Before you use it, read what it can see and keep, and the rules:
- [Privacy note](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md):
  it stores ciphertext and protocol metadata (public keys, Resource IDs,
  sizes) and sees your IP address, never your task text;
- [Terms of service](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md):
  free, no guarantees, quotas per key and per IP address, and data may be
  deleted.

It is MVP software on a small machine: fine for trying OpenLFCP, not for
data you need to protect or cannot afford to lose. Your vaults keep the
full copy of every collaboration either way. *The public server is being
prepared; until it is announced as live, the URL may not answer.*

## Running your own server

The reference server is open source: see
[openlfcp/server](https://github.com/openlfcp/server), "Docker", for a
container setup with TLS. Use its `wss://` URL as above.

## Rules for any server URL

- Use `wss://` (TLS). `ws://` travels without TLS and is meant only for a
  server on your own machine, such as `ws://127.0.0.1:7820/v1/ws` for local
  testing (WIRE-01 §16).
- The URL includes the WebSocket path, usually `/v1/ws`.
- Everyone in a collaboration syncs through its server, so pick one your
  collaborators can reach.
