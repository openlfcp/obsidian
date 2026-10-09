#!/usr/bin/env node
// Prepares the canonical two-vault demo (LFCP-072) outside every repository:
//
//   node scripts/demo-vaults.mjs [--dir <path>] [--port <n>] [--sections]
//
// Default directory: ../openlfcp-demo, next to this checkout. It creates
//   <dir>/vault-a, <dir>/vault-b   two vaults with the plugin built and enabled,
//                                  and sample notes with private text;
//   <dir>/server/server.toml       a reference server config (state in <dir>/server/state);
// and prints the commands to start the server and open the vaults. The
// plugin bundle is built straight into the vaults, so no file is left in
// this repository. Re-running refreshes the plugin and keeps existing notes.
// --sections turns on the shared sections preview (sectionsPreview in each
// vault's data.json, other settings kept) and adds a note to share as a
// section in Vault A.
// Walkthrough: docs/demos/two-vault-demo.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    port: { type: "string" },
    sections: { type: "boolean", default: false },
  },
});
const dir = resolve(values.dir ?? join(root, "..", "openlfcp-demo"));
const port = Number(values.port ?? 8787);
const url = `ws://127.0.0.1:${port}/v1/ws`;

if (dir === root || dir.startsWith(`${root}/`))
  throw new Error("the demo directory must be outside the repository");

const NOTES = {
  "vault-a": {
    settings: { refPlacement: "child-line", defaultServer: url },
    notes: {
      "Private A.md": `# Private A

This paragraph belongs only to Vault A. PRIVATE-A-MARKER

- [ ] Prepare API contract 📅 2026-10-20
- [ ] Book venue for the offsite

More private A text: nobody else should ever see this.
`,
    },
    // With --sections: share "## Launch" with "Share section…"; the text around it stays private.
    sectionNotes: {
      "Launch plan.md": `# Launch plan

Private budget notes for Vault A only. PRIVATE-A-SECTION-MARKER

## Launch

- [ ] Prepare contract 📅 2026-10-20
- [ ] Book venue

Draft the announcement with the team.

## Notes

Private follow-ups, not shared.
`,
    },
  },
  "vault-b": {
    settings: { refPlacement: "inline", defaultServer: url },
    notes: {
      "Private B.md": `# Private B

This text is unique to B. PRIVATE-B-MARKER

Some unrelated notes.

`,
    },
  },
};

// Obsidian keys the plugin folder and community-plugins.json on the manifest ID.
const { id } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

for (const [vault, spec] of Object.entries(NOTES)) {
  const plugin = join(dir, vault, ".obsidian", "plugins", id);
  mkdirSync(plugin, { recursive: true });
  execFileSync("node", ["scripts/build.mjs", "--outfile", join(plugin, "main.js")], {
    cwd: root,
    stdio: "ignore",
  });
  for (const f of ["manifest.json", "styles.css"])
    writeFileSync(join(plugin, f), readFileSync(join(root, f)));
  // Enabled on open. Restricted mode must be turned off once per vault in Obsidian.
  writeFileSync(
    join(dir, vault, ".obsidian", "community-plugins.json"),
    `${JSON.stringify([id])}\n`,
  );
  const data = join(plugin, "data.json");
  if (!existsSync(data)) writeFileSync(data, `${JSON.stringify(spec.settings, null, 2)}\n`);
  if (values.sections) {
    // The shared sections preview (MVP 0.2), on top of whatever the vault has set.
    const settings = JSON.parse(readFileSync(data, "utf8"));
    writeFileSync(data, `${JSON.stringify({ ...settings, sectionsPreview: true }, null, 2)}\n`);
  }
  const notes = values.sections ? { ...spec.notes, ...(spec.sectionNotes ?? {}) } : spec.notes;
  for (const [name, text] of Object.entries(notes)) {
    const path = join(dir, vault, name);
    if (!existsSync(path)) writeFileSync(path, text);
  }
}

const server = join(dir, "server");
mkdirSync(server, { recursive: true });
writeFileSync(
  join(server, "server.toml"),
  [
    `bind = "127.0.0.1:${port}"`,
    `state_dir = ${JSON.stringify(join(server, "state"))}`,
    `public_urls = [${JSON.stringify(url)}]`,
    "",
  ].join("\n"),
);

const serverCheckout = resolve(root, "..", "server");
console.log(`Demo prepared in ${dir}

1. Start the reference server (in its own terminal):

   cargo run --manifest-path ${join(serverCheckout, "Cargo.toml")} -- --config ${join(server, "server.toml")}

   (or run an already built lfcp-server binary with the same --config)

2. Open both vaults in Obsidian ("Open folder as vault"), and in each turn
   off Restricted mode once (Settings → Community plugins):

   ${join(dir, "vault-a")}
   ${join(dir, "vault-b")}

3. Follow docs/demos/two-vault-demo.md. The server URL is ${url}
   (already the default server in both vaults).

To start over: quit Obsidian and delete ${dir}.`);
