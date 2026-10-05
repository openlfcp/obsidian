# openlfcp/obsidian

Obsidian editor adapter and product UI for OpenLFCP.

It consumes `sdk-ts`, the Shared Objects Profile, and the Markdown
reference format. It owns Markdown scanning, the projection engine,
CodeMirror integration, commands, the Resource Explorer, plugin settings,
and editor conflict presentation.

## Scope

The plugin implements the OpenLFCP MVP 0.1 product slice on
sdk-ts: sharing Tasks between vaults over the MVP 0.1 subset of
LFCP-WIRE-01 at `mvp-0.1-baseline.6`, not every deferred WIRE-01 feature
(see `.github: docs/release/deferred-wire-01-features.md` (in [openlfcp/.github](https://github.com/openlfcp/.github))). Desktop only is
tested; mobile is not.

## Documents

- [docs/OBSIDIAN-ARCHITECTURE-01.md](docs/OBSIDIAN-ARCHITECTURE-01.md): architecture of the Obsidian adapter.
- The Markdown ref grammar it implements is normative and lives in `spec: integration/MARKDOWN-REFS-01.md`.

## Status

- Plugin bootstrap (LFCP-058): the plugin loads, registers its commands and
  has a settings tab.
- `lfcp-ref` markers (LFCP-060, done before LFCP-059 on purpose): parsing,
  diagnostics and serialization per MARKDOWN-REFS-01, in
  [`src/core/refs`](src/core/refs/README.md).
- The TypeScript SDK in the plugin (LFCP-059), in `src/core/lfcp`:
  - a per-vault install with its own identity and an install marker that
    locks writing on any copied, wiped or rolled-back state;
  - IndexedDB storage and `app.secretStorage` secrets;
  - one sync session per server, opened on demand;
  - the local Resource registry;
  - start and stop with the plugin (never blocked on the network).

  See [docs/architecture/local-state.md](docs/architecture/local-state.md).
- Vault-level change events (`src/core/vault`), collected for projection
  scanning whatever made them (LFCP-059).
- Markdown ↔ Shared Object projection (LFCP-061, LFCP-062,
  `src/core/projection`): edits to bound Tasks (title, status, due,
  scheduled, completion date, priority, tags) become Shared Objects intents
  through the SDK, and shared changes are rendered back into every note that
  projects them. Conflicts show in the status bar and the editor, never in
  the text. See [docs/architecture/projection.md](docs/architecture/projection.md).

- Collaboration commands (LFCP-065, `src/core/collab`, `src/obsidian/ui`):
  create, join, share the task under the cursor, insert a shared task,
  invite (Read or Read + Write, one-time links), Resource status, detach,
  and resolving a shared conflict. See
  [docs/architecture/collaboration.md](docs/architecture/collaboration.md).

## Demo

[docs/demos/two-vault-demo.md](docs/demos/two-vault-demo.md) walks through
the canonical two-vault demo in real Obsidian. `node scripts/demo-vaults.mjs`
prepares the vaults and the server config outside this repository.

## Layout

| Path | What it is |
| --- | --- |
| `manifest.json`, `versions.json` | Obsidian community-plugin manifest (id `openlfcp`) and its app-version map |
| `src/main.ts` | Entry point; bundled into `main.js` by `scripts/build.mjs` (esbuild) |
| `src/obsidian/` | The thin Obsidian adapter: plugin lifecycle, commands, settings tab. The only code that imports `obsidian` |
| `src/core/` | Obsidian-free modules, reusable by other editor adapters |
| `src/core/lfcp/` | The LFCP runtime over the SDK: install and marker, secret slots, sessions, registry |
| `src/core/vault/` | Vault-level file change hub |
| `src/core/projection/` | Markdown → Shared Object projection, the mutation guard |
| `test/` | Vitest unit tests; `test/mocks/obsidian.ts` stands in for the Obsidian API; `test/fixtures/refs/` holds golden `lfcp-ref` fixtures |
| `sdk-ts.lock` | The `openlfcp/sdk-ts` commit CI builds next to this repository for the `link:` dependencies |
| `spec.lock` | The `openlfcp/spec` tag and commit the tests read MARKDOWN-REFS-01 and spec fixtures from (`$LFCP_SPEC_DIR`, or `../spec`) |
| `scripts/check-boundaries.mjs` | Fails if code outside the adapter imports `obsidian`, reaches into `src/obsidian/`, or uses Node in `src/` |

`obsidian` is a devDependency for types only: the app provides it at
runtime. The plugin does not reimplement any LFCP protocol logic: it uses
the TypeScript SDK (`@openlfcp/*`, linked from `../sdk-ts`). The boundary
check also refuses Automerge, `@noble`, HPKE, CBOR and COSE libraries,
`@openlfcp/wire/cbor` and the Node-only `@openlfcp/storage-node` in `src/`,
and keeps `fake-indexeddb` test-only.

## Build from a clean checkout

The `@openlfcp/*` packages are `link:` dependencies on a sibling `sdk-ts`
checkout (`../sdk-ts`), which must be installed and built first. CI uses the
commit pinned in `sdk-ts.lock`.

```sh
(cd ../sdk-ts && pnpm install --frozen-lockfile && pnpm build)
pnpm install --frozen-lockfile
pnpm run build       # typecheck src and bundle main.js
pnpm run lint        # Biome and the boundary check (with its self-test)
pnpm run typecheck   # src and tests
pnpm test
```

`main.js` is about 5.4 MB, almost all of it Automerge's wasm as base64 (the
community-plugin format ships one script; see the local-state note).

Requires Node.js 24 or later and pnpm 10. To try the plugin in Obsidian,
see [docs/devel/testing/load-in-clean-vault.md](docs/devel/testing/load-in-clean-vault.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
