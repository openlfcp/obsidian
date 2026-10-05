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

Repository scaffold only. The plugin bootstrap is LFCP-058.

## Build from a clean checkout

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

Requires Node.js 24 or later and pnpm 10.

## License

Apache License 2.0. See [LICENSE](LICENSE).
