// The plugin bundle (LFCP-059): Automerge's slim build, initialized
// asynchronously by the SDK, so loading the plugin never compiles the wasm
// synchronously on Obsidian's main thread (Chromium refuses that above
// 4 KB), and no protocol code from outside the SDK.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { automergeSlim, automergeWasmDeflated } from "../scripts/build-plugins.mjs";

let dir = "";
let bundle = "";
let inputs: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openlfcp-bundle-"));
  const out = join(dir, "main.js");
  const meta = join(dir, "meta.json");
  execFileSync("node", ["scripts/build.mjs", "--outfile", out, "--metafile", meta], {
    stdio: "pipe",
  });
  bundle = readFileSync(out, "utf8");
  inputs = Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("plugin bundle", () => {
  it("uses Automerge's slim build with the SDK's asynchronous initialization", () => {
    // The minified bundle renames identifiers, so the build's inputs say what is in it.
    const automerge = inputs.filter((i) => i.includes("@automerge/automerge/"));
    expect(automerge.some((i) => i.endsWith("/entrypoints/slim.js"))).toBe(true);
    // No "fullfat" entry, which would compile the wasm synchronously at import.
    expect(automerge.filter((i) => /fullfat/.test(i))).toEqual([]);
    // The wasm module the SDK imports is the deflated replacement.
    expect(
      automerge
        .filter((i) => i.endsWith("automerge_wasm_bg_base64.js"))
        .map((i) => i.split(":")[0]),
    ).toEqual(["automerge-wasm-deflated"]);
    expect(bundle).toContain("WebAssembly.instantiate");
  });

  it("stays under the 5 MB Obsidian Sync limit: minified, the wasm deflated (0.3.1)", () => {
    expect(bundle.length).toBeLessThan(3 * 1024 * 1024);
    // The raw base64 wasm ("\0asm" = AGFzbQ) is not in the bundle; its deflated form is.
    expect(bundle).not.toContain('"AGFzbQ');
    expect(bundle).toContain("Third-party licenses of the bundled packages");
    for (const name of ["@automerge/automerge@", "fflate@", "hpke@", "@noble/hashes@"])
      expect(bundle).toContain(name);
  });

  it("initializes the deflated Automerge wasm as the SDK does", async () => {
    // A bundle of only the SDK's initializer, with the plugin bundle's plugins, run in Node.
    const out = join(dir, "init.cjs");
    await build({
      stdin: {
        contents: `import { initializeAutomerge, isAutomergeInitialized } from "@openlfcp/shared-objects";
(async () => {
  const before = isAutomergeInitialized();
  await initializeAutomerge();
  process.stdout.write(JSON.stringify({ before, after: isAutomergeInitialized() }));
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });`,
        resolveDir: join(import.meta.dirname, ".."),
        loader: "js",
      },
      outfile: out,
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      plugins: [automergeSlim, automergeWasmDeflated],
    });
    const result = JSON.parse(execFileSync("node", [out], { encoding: "utf8" }));
    expect(result).toEqual({ before: false, after: true });
  }, 60_000);

  it("keeps obsidian external and imports no Node built-in at run time", () => {
    expect(bundle).toMatch(/require\("obsidian"\)/);
    expect(bundle).not.toMatch(/require\("(node:)?(fs|path|os|child_process)"\)/);
  });
});
