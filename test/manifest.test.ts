import { readFileSync } from "node:fs";
import { principalId } from "@openlfcp/core";
import { principalKeySecretRef } from "@openlfcp/storage";
import { describe, expect, it } from "vitest";
import { databaseName, INSTALL_KEY } from "../src/core/lfcp/install";
import { markerSlotId, secretSlotId } from "../src/core/lfcp/secrets";

const json = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("manifest", () => {
  const manifest = json("manifest.json");

  it("is the community-plugin manifest of Shared Tasks (POST-011)", () => {
    expect(manifest.id).toBe("shared-tasks");
    expect(manifest.name).toBe("Shared Tasks");
    expect(manifest.isDesktopOnly).toBe(false);
    for (const field of ["name", "version", "minAppVersion", "description", "author"]) {
      expect(typeof manifest[field], field).toBe("string");
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("follows the community directory's rules", () => {
    // A lowercase ID; no "obsidian" in the ID, name or description, and no
    // "plugin" in the name; the description is one sentence ending in a stop.
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
    for (const field of ["id", "name", "description"])
      expect(manifest[field].toLowerCase(), field).not.toContain("obsidian");
    expect(manifest.name.toLowerCase()).not.toContain("plugin");
    expect(manifest.description).toMatch(/[.?!)]$/);
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.authorUrl).toMatch(/^https:\/\//);
    expect(manifest.authorUrl).not.toContain("openlfcp/obsidian");
  });

  it("keeps the device-local state keys of 0.1.0, which do not follow the plugin ID", () => {
    // Renaming the plugin must not orphan an identity: these name the
    // vault-scoped install ID, the IndexedDB database and the secret slots.
    expect(INSTALL_KEY).toBe("openlfcp-install");
    expect(databaseName("abc")).toBe("openlfcp-v1-abc");
    const install = "0123456789abcdef0123456789abcdef";
    expect(markerSlotId(install)).toBe(`openlfcp-${install}-marker`);
    const ref = principalKeySecretRef(principalId(new Uint8Array(32).fill(7)), "signing");
    expect(secretSlotId(install, ref)).toBe(
      "openlfcp-498a8cf11613ce45d54989ef743473c8354dd67f524f2feb0e799f5",
    );
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
