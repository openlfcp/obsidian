// POST-011: the release check run on a tag (scripts/release-assets.mjs).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BETA_TAG, betaProblems, releaseProblems } from "../scripts/release-assets.mjs";

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

describe("beta release check (LFCP-02-094)", () => {
  const manifest = json("manifest.json");
  const [major, minor] = (manifest.version as string).split(".").map(Number);
  const next = `${major}.${(minor as number) + 1}.0-beta.1`;
  const beta = { ...manifest, version: next };

  it("takes X.Y.Z-beta.N tags only", () => {
    expect(BETA_TAG.test("0.4.0-beta.1")).toBe(true);
    for (const t of ["0.4.0", "v0.4.0-beta.1", "0.4.0-beta", "0.4.0-rc.1", "0.4.0-beta.1.2"])
      expect(BETA_TAG.test(t)).toBe(false);
  });

  it("passes a manifest-beta.json that is the catalog manifest with the tag as its version", () => {
    expect(betaProblems({ tag: next, manifest, beta })).toEqual([]);
  });

  it("refuses a missing or mismatched beta manifest, and a beta not newer than the catalog", () => {
    expect(betaProblems({ tag: next, manifest, beta: null })).toEqual([
      "manifest-beta.json is missing: a beta's manifest asset comes from it",
    ]);
    expect(
      betaProblems({ tag: next, manifest, beta: { ...beta, version: "0.9.0-beta.2" } }),
    ).toEqual([`manifest-beta.json version 0.9.0-beta.2 is not the tag ${next}`]);
    expect(
      betaProblems({ tag: next, manifest, beta: { ...beta, minAppVersion: "1.0.0" } }),
    ).toEqual(["manifest-beta.json minAppVersion differs from manifest.json"]);
    const old = `${manifest.version}-beta.1`;
    expect(betaProblems({ tag: old, manifest, beta: { ...manifest, version: old } })).toEqual([
      `beta ${old} is not newer than the catalog version ${manifest.version}`,
    ]);
  });
});
