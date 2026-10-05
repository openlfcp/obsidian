# openlfcp/obsidian

Obsidian editor adapter and product UI for OpenLFCP.

It consumes `sdk-ts`, the Shared Objects Profile, and the Markdown
reference format. It owns Markdown scanning, the projection engine,
CodeMirror integration, commands, the Resource Explorer, plugin settings,
and editor conflict presentation.

## Documents

- [docs/OBSIDIAN-ARCHITECTURE-01.md](docs/OBSIDIAN-ARCHITECTURE-01.md): architecture of the Obsidian adapter.
- The Markdown ref grammar it implements is normative and lives in `spec: integration/MARKDOWN-REFS-01.md`.

## Status

- Plugin bootstrap (LFCP-058): the plugin loads, registers its commands as
  stubs and has a settings tab with placeholder fields.
- `lfcp-ref` markers (LFCP-060, done before LFCP-059 on purpose): parsing,
  diagnostics and serialization per MARKDOWN-REFS-01, in
  [`src/core/refs`](src/core/refs/README.md).

Nothing is shared yet.

## Layout

| Path | What it is |
| --- | --- |
| `manifest.json`, `versions.json` | Obsidian community-plugin manifest (id `openlfcp`) and its app-version map |
| `src/main.ts` | Entry point; bundled into `main.js` by `scripts/build.mjs` (esbuild) |
| `src/obsidian/` | The thin Obsidian adapter: plugin lifecycle, commands, settings tab. The only code that imports `obsidian` |
| `src/core/` | Obsidian-free modules, reusable by other editor adapters |
| `test/` | Vitest unit tests; `test/mocks/obsidian.ts` stands in for the Obsidian API; `test/fixtures/refs/` holds golden `lfcp-ref` fixtures |
| `spec.lock` | The `openlfcp/spec` tag and commit the tests read MARKDOWN-REFS-01 and spec fixtures from (`$LFCP_SPEC_DIR`, or `../spec`) |
| `scripts/check-boundaries.mjs` | Fails if code outside the adapter imports `obsidian`, reaches into `src/obsidian/`, or uses Node in `src/` |

`obsidian` is a devDependency for types only: the app provides it at
runtime. The plugin does not reimplement any LFCP protocol logic; it will
use the TypeScript SDK (LFCP-059).

## Build from a clean checkout

```sh
pnpm install --frozen-lockfile
pnpm run build       # typecheck src and bundle main.js
pnpm run lint        # Biome and the boundary check (with its self-test)
pnpm run typecheck   # src and tests
pnpm test
```

Requires Node.js 24 or later and pnpm 10. To try the plugin in Obsidian,
see [docs/devel/testing/load-in-clean-vault.md](docs/devel/testing/load-in-clean-vault.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
