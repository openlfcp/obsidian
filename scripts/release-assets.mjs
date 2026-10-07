#!/usr/bin/env node
// Builds the release assets of the plugin (POST-011) and checks them:
//
//   node scripts/release-assets.mjs [--tag TAG]
//
// into release/: main.js, manifest.json and styles.css, the three files
// Obsidian, BRAT and the community directory read from a GitHub release
// (since 0.3.1 nothing else: the directory flags extra assets). It fails when
// manifest.json, package.json and versions.json disagree, or when --tag is
// not exactly the version: Obsidian requires the bare version ("0.2.0",
// no "v") as the release tag. The release workflow runs it on the tag.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The problems of a release of `tag` (null: no tag) with these files; empty when fine. */
export function releaseProblems({ tag, manifest, pkg, versions }) {
  const problems = [];
  const v = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) problems.push(`manifest.json version ${v} is not x.y.z`);
  if (pkg.version !== v) problems.push(`package.json version ${pkg.version} is not ${v}`);
  if (versions[v] !== manifest.minAppVersion)
    problems.push(`versions.json has no "${v}": "${manifest.minAppVersion}" entry`);
  if (tag !== null && tag !== v)
    problems.push(`tag ${tag} is not the manifest version ${v} (Obsidian wants the bare version)`);
  return problems;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--tag");
  const tag = at >= 0 ? (process.argv[at + 1] ?? "") : null;
  const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
  const manifest = read("manifest.json");
  const problems = releaseProblems({
    tag,
    manifest,
    pkg: read("package.json"),
    versions: read("versions.json"),
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`release: ${p}`);
    process.exit(1);
  }
  const out = join(root, "release");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync("node", ["scripts/build.mjs", "--outfile", join(out, "main.js")], {
    cwd: root,
    stdio: "inherit",
  });
  for (const f of ["manifest.json", "styles.css"]) copyFileSync(join(root, f), join(out, f));
  const assets = readdirSync(out).sort();
  const expected = ["main.js", "manifest.json", "styles.css"];
  if (JSON.stringify(assets) !== JSON.stringify(expected)) {
    console.error(`release: release/ holds ${assets.join(", ")}, not ${expected.join(", ")}`);
    process.exit(1);
  }
  console.log(`release: ${manifest.name} ${manifest.version} (${manifest.id}) in release/:`);
  console.log("  main.js manifest.json styles.css");
}
