#!/usr/bin/env node
// Builds the release assets of the plugin (POST-011) and checks them:
//
//   node scripts/release-assets.mjs [--tag TAG]
//
// A beta (LFCP-02-094) is tagged X.Y.Z-beta.N and published as a GitHub
// pre-release, which BRAT installs and the catalog ignores. manifest.json on
// main keeps the catalog version until GA, so a beta's manifest asset comes
// from manifest-beta.json: the same manifest with the beta version, which
// must be the tag and newer than the catalog version.
//
// into release/: main.js, manifest.json and styles.css, the three files
// Obsidian, BRAT and the community directory read from a GitHub release
// (since 0.3.1 nothing else: the directory flags extra assets). It fails when
// manifest.json, package.json and versions.json disagree, or when --tag is
// not exactly the version: Obsidian requires the bare version ("0.2.0",
// no "v") as the release tag. The release workflow runs it on the tag.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** A beta tag: X.Y.Z-beta.N (LFCP-02-094). */
export const BETA_TAG = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

const newer = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The problems of a beta release of `tag` with manifest-beta.json `beta`; empty when fine. */
export function betaProblems({ tag, manifest, beta }) {
  const m = BETA_TAG.exec(tag ?? "");
  if (m === null) return [`tag ${tag} is not X.Y.Z-beta.N`];
  if (beta === null)
    return ["manifest-beta.json is missing: a beta's manifest asset comes from it"];
  const problems = [];
  if (beta.version !== tag)
    problems.push(`manifest-beta.json version ${beta.version} is not the tag ${tag}`);
  for (const k of new Set([...Object.keys(manifest), ...Object.keys(beta)]))
    if (k !== "version" && JSON.stringify(manifest[k]) !== JSON.stringify(beta[k]))
      problems.push(`manifest-beta.json ${k} differs from manifest.json`);
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  if (!newer(base, manifest.version ?? "0.0.0"))
    problems.push(`beta ${tag} is not newer than the catalog version ${manifest.version}`);
  return problems;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--tag");
  const tag = at >= 0 ? (process.argv[at + 1] ?? "") : null;
  const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
  const catalog = read("manifest.json");
  const isBeta = tag !== null && BETA_TAG.test(tag);
  const beta =
    isBeta && existsSync(join(root, "manifest-beta.json")) ? read("manifest-beta.json") : null;
  // A beta checks its own manifest; package.json and versions.json are the catalog's.
  const problems = isBeta
    ? betaProblems({ tag, manifest: catalog, beta })
    : releaseProblems({
        tag,
        manifest: catalog,
        pkg: read("package.json"),
        versions: read("versions.json"),
      });
  const manifest = isBeta ? beta : catalog;
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
  copyFileSync(
    join(root, isBeta ? "manifest-beta.json" : "manifest.json"),
    join(out, "manifest.json"),
  );
  copyFileSync(join(root, "styles.css"), join(out, "styles.css"));
  const assets = readdirSync(out).sort();
  const expected = ["main.js", "manifest.json", "styles.css"];
  if (JSON.stringify(assets) !== JSON.stringify(expected)) {
    console.error(`release: release/ holds ${assets.join(", ")}, not ${expected.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `release: ${manifest.name} ${manifest.version} (${manifest.id})${isBeta ? " pre-release" : ""} in release/:`,
  );
  console.log("  main.js manifest.json styles.css");
}
