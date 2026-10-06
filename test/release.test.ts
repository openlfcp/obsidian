// POST-011: the release check run on a tag (scripts/release-assets.mjs).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseProblems } from "../scripts/release-assets.mjs";

const json = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const files = () => ({
  manifest: json("manifest.json"),
  pkg: json("package.json"),
  versions: json("versions.json"),
});

describe("release check", () => {
  it("passes for this checkout, untagged and on its bare version tag", () => {
    const f = files();
    expect(releaseProblems({ ...f, tag: null })).toEqual([]);
    expect(releaseProblems({ ...f, tag: f.manifest.version })).toEqual([]);
  });

  it("refuses a v-prefixed or wrong tag, and disagreeing files", () => {
    const f = files();
    const v = f.manifest.version;
    expect(releaseProblems({ ...f, tag: `v${v}` })).toEqual([
      `tag v${v} is not the manifest version ${v} (Obsidian wants the bare version)`,
    ]);
    expect(releaseProblems({ ...f, tag: "9.9.9" })).toHaveLength(1);
    expect(releaseProblems({ ...f, pkg: { version: "0.0.1" }, tag: null })).toEqual([
      `package.json version 0.0.1 is not ${v}`,
    ]);
    expect(releaseProblems({ ...f, versions: {}, tag: null })).toEqual([
      `versions.json has no "${v}": "${f.manifest.minAppVersion}" entry`,
    ]);
    expect(
      releaseProblems({ ...f, manifest: { ...f.manifest, version: "0.2" }, tag: null }),
    ).toContain("manifest.json version 0.2 is not x.y.z");
  });
});
