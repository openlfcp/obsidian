// LFCP-065 test 18: the collaboration UI and its flows duplicate no
// protocol cryptography. They reach keys, signatures, HPKE, invitation
// secrets and URIs only through the SDK's flows (createInvitation,
// acceptInvitation, createResource, writeIntent); the protocol libraries
// themselves are banned plugin-wide by scripts/check-boundaries.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const DIRS = ["src/core/collab", "src/obsidian/ui"];

const files = DIRS.flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${d}/${f}`),
);

/** Every name imported from a module, per module. */
function imports(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const names = (m[1] as string)
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, ""))
      .filter((n) => n !== "");
    out.set(m[2] as string, [...(out.get(m[2] as string) ?? []), ...names]);
  }
  return out;
}

/** What these layers may take from the low-level SDK packages: constants and parsing, no keys. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "@openlfcp/wire": ["ABILITY", "ABILITY_NAMES", "abilitiesOf", "parseInviteUri"],
  "@openlfcp/crypto": [],
};

describe("no protocol logic in the collaboration UI (LFCP-065 test 18)", () => {
  it("covers the collaboration modules", () => {
    expect(files).toContain("src/core/collab/service.ts");
    expect(files).toContain("src/obsidian/ui/prompter.ts");
  });

  for (const file of files)
    it(`${file} uses the SDK's flows only`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const [module, names] of imports(source)) {
        const allowed = ALLOWED[module];
        if (allowed !== undefined)
          for (const name of names)
            expect(allowed, `${file}: ${name} from ${module}`).toContain(name);
      }
      // No hand-rolled crypto or encodings.
      expect(source).not.toMatch(
        /crypto\.subtle|getRandomValues|sha256|ed25519|x25519|hpke|chacha/i,
      );
      // Nothing that prints a revealed link.
      expect(source).not.toMatch(/console\.|reveal\(\)\s*\)\s*;?\s*\/\/\s*log/);
    });
});
