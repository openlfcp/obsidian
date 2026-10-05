// Test 10 (LFCP-059): the generic SDK the plugin consumes imports no
// Obsidian API. The dependency arrow is Obsidian -> adapter -> SDK, never
// back. sdk-ts enforces it at its source (scripts/check-boundaries.mjs);
// this checks the built packages the plugin actually links.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "node_modules", "@openlfcp");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
  });
}

describe("the linked SDK", () => {
  const packages = readdirSync(root);

  it("is every package the plugin uses, from sdk-ts", () => {
    expect(packages.sort()).toEqual([
      "client",
      "core",
      "crypto",
      "shared-objects",
      "storage",
      "storage-idb",
      "wire",
    ]);
  });

  it("imports no Obsidian API in any built file", () => {
    for (const name of packages) {
      const dist = join(realpathSync(join(root, name)), "dist");
      const js = files(dist);
      expect(js.length).toBeGreaterThan(0);
      for (const file of js)
        expect(readFileSync(file, "utf8"), file).not.toMatch(
          /from\s*["']obsidian["']|require\(\s*["']obsidian["']\)|import\(\s*["']obsidian["']\)/,
        );
    }
  });
});
