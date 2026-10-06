// The plugin is "Shared Tasks" in every user-facing text (POST-011, owner
// decision before 0.2.0); "OpenLFCP" names only the protocol, the project
// and its server. Comments are not user-facing and are skipped.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath, not URL.pathname: on Windows the pathname is "/D:/…".
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Code lines naming OpenLFCP on purpose: the project and its server. */
const ALLOWED = ["Hosted by the OpenLFCP project (beta)", "the OpenLFCP project server (beta)"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("branding", () => {
  it("names the plugin Shared Tasks, never OpenLFCP, in its texts", () => {
    const files = sources(SRC);
    // A wrong path must not pass by scanning nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
    const found: string[] = [];
    for (const file of files)
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (code.includes("OpenLFCP") && !ALLOWED.some((a) => code.includes(a)))
            found.push(`${file.slice(SRC.length)}:${i + 1}: ${code}`);
        });
    expect(found).toEqual([]);
  });
});
