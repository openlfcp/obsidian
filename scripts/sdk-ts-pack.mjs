#!/usr/bin/env node
// The development pin of the TypeScript SDK until @openlfcp/* 0.7.0 is on
// npm: the eight packages of openlfcp/sdk-ts at the commit in sdk-ts.lock,
// built from a checkout of that commit and packed into vendor/sdk-ts/
// (gitignored). package.json takes them as file: tarballs (with
// pnpm.overrides, so a package's own ^version dependencies resolve to the
// tarballs too, never to npm) and pnpm-lock.yaml records each tarball's
// integrity: sdk-ts.lock pins the commit, the lockfile pins the bytes.
//
//   node scripts/sdk-ts-pack.mjs [--checkout DIR] [--no-build]
//   node scripts/sdk-ts-pack.mjs --self-test
//
// DIR defaults to ../sdk-ts next to this repository (as CI checks it out).
// Its HEAD must be the commit in sdk-ts.lock. The packing is reproducible:
// `pnpm pack` writes `workspace:` ranges in no stable order, so each
// package is staged with its ranges already rewritten (workspace:^ and
// workspace:~ to ^version and ~version, workspace:* to the version, in
// place) and packed from there; the checkout itself is never modified.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The packages, in dependency order. */
export const SDK_PACKAGES = [
  "core",
  "crypto",
  "storage",
  "wire",
  "storage-idb",
  "shared-objects",
  "client",
  "storage-node",
];

/** One `workspace:` range as published, given the workspace's version of its package. */
export function publishedRange(range, version) {
  if (!range.startsWith("workspace:")) return range;
  const spec = range.slice("workspace:".length);
  if (spec === "*") return version;
  if (spec === "^" || spec === "~") return `${spec}${version}`;
  throw new Error(`unsupported workspace range "${range}"`);
}

/** A package.json with its workspace ranges rewritten, every key in its order. */
export function publishedManifest(pkg, versions) {
  const out = { ...pkg };
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field] === undefined) continue;
    out[field] = Object.fromEntries(
      Object.entries(pkg[field]).map(([name, range]) => {
        if (!range.startsWith("workspace:")) return [name, range];
        const version = versions[name];
        if (version === undefined) throw new Error(`${name} is not a workspace package`);
        return [name, publishedRange(range, version)];
      }),
    );
  }
  return out;
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });

function selfTest() {
  const versions = { "@openlfcp/core": "0.6.0", "@openlfcp/wire": "0.6.0" };
  const got = publishedManifest(
    {
      name: "@openlfcp/x",
      dependencies: {
        "@openlfcp/wire": "workspace:^",
        other: "^1.0.0",
        "@openlfcp/core": "workspace:*",
      },
    },
    versions,
  );
  const want = { "@openlfcp/wire": "^0.6.0", other: "^1.0.0", "@openlfcp/core": "0.6.0" };
  if (JSON.stringify(got.dependencies) !== JSON.stringify(want))
    throw new Error(`self-test: ${JSON.stringify(got.dependencies)}`);
  if (publishedRange("workspace:~", "1.2.3") !== "~1.2.3")
    throw new Error("self-test: workspace:~");
  let threw = false;
  try {
    publishedManifest({ dependencies: { "@openlfcp/y": "workspace:^" } }, versions);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("self-test: an unknown workspace package must throw");
  process.stdout.write("sdk-ts-pack self-test: ok\n");
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const root = resolve(import.meta.dirname, "..");
  const at = argv.indexOf("--checkout");
  const checkout = resolve(at === -1 ? join(root, "..", "sdk-ts") : argv[at + 1]);
  const lock = JSON.parse(readFileSync(join(root, "sdk-ts.lock"), "utf8"));
  const head = run("git", ["rev-parse", "HEAD"], checkout).trim();
  if (head !== lock.commit) {
    process.stderr.write(
      `sdk-ts-pack: ${checkout} is at ${head}, sdk-ts.lock pins ${lock.commit}\n`,
    );
    process.exit(1);
  }
  if (!argv.includes("--no-build")) {
    run("pnpm", ["install", "--frozen-lockfile"], checkout);
    run("pnpm", ["build"], checkout);
  }
  const manifests = Object.fromEntries(
    SDK_PACKAGES.map((p) => [
      p,
      JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")),
    ]),
  );
  const versions = Object.fromEntries(Object.values(manifests).map((m) => [m.name, m.version]));
  const out = join(root, "vendor", "sdk-ts");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "sdk-ts-pack-"));
  try {
    for (const p of SDK_PACKAGES) {
      const src = join(checkout, "packages", p);
      const dir = join(stage, p);
      cpSync(src, dir, {
        recursive: true,
        filter: (f) => !/[\\/](node_modules|src|test)([\\/]|$)/.test(f.slice(src.length)),
      });
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify(publishedManifest(manifests[p], versions), null, 2)}\n`,
      );
      run("pnpm", ["pack", "--pack-destination", out], dir);
      process.stdout.write(`packed ${manifests[p].name}@${manifests[p].version}\n`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
