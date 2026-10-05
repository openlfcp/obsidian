import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("manifest", () => {
  const manifest = json("manifest.json");

  it("is a community-plugin manifest for id openlfcp", () => {
    expect(manifest.id).toBe("openlfcp");
    expect(manifest.isDesktopOnly).toBe(false);
    for (const field of ["name", "version", "minAppVersion", "description", "author"]) {
      expect(typeof manifest[field], field).toBe("string");
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("agrees with package.json and versions.json", () => {
    expect(json("package.json").version).toBe(manifest.version);
    expect(json("versions.json")[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("targets the Obsidian API it is typed against", () => {
    const api = json("node_modules/obsidian/package.json").version;
    expect(manifest.minAppVersion).toBe(api);
  });
});
