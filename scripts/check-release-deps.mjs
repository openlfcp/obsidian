#!/usr/bin/env node
// A tag release is built from the @openlfcp/* npm packages only (the
// community directory's review reproduces the build from npm). During MVP
// 0.4 development main links the SDK from ../sdk-ts at sdk-ts.lock; a tag
// made on such a commit must not ship that build, so release.yml runs this
// first and stops on any problem.
//
//   node scripts/check-release-deps.mjs

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** What keeps this checkout from being released: [] when the SDK comes from npm. */
export function releaseDepsProblems({ pkg, sdkLock }) {
  const problems = [];
  if (sdkLock) problems.push("sdk-ts.lock is present: the SDK is pinned to a commit, not npm");
  for (const [name, version] of Object.entries(pkg.dependencies ?? {}))
    if (name.startsWith("@openlfcp/") && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
      problems.push(`${name} is "${version}", not an exact npm version`);
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, "..");
  const problems = releaseDepsProblems({
    pkg: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
    sdkLock: existsSync(resolve(root, "sdk-ts.lock")),
  });
  for (const p of problems) process.stderr.write(`release refused: ${p}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
