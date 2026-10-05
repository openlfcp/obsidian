// The plugin bundle (LFCP-059): Automerge's slim build, initialized
// asynchronously by the SDK, so loading the plugin never compiles the wasm
// synchronously on Obsidian's main thread (Chromium refuses that above
// 4 KB), and no protocol code from outside the SDK.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir = "";
let bundle = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openlfcp-bundle-"));
  const out = join(dir, "main.js");
  execFileSync("node", ["scripts/build.mjs", "--outfile", out], { stdio: "pipe" });
  bundle = readFileSync(out, "utf8");
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("plugin bundle", () => {
  it("uses Automerge's slim build with the SDK's asynchronous initialization", () => {
    // The base64 "fullfat" entry calls initSync(wasmBlob) at import: absent.
    expect(bundle).not.toContain("initSync(wasmBlob)");
    // The SDK's initializer and Automerge's async path are present.
    expect(bundle).toContain("initializeWasm");
    expect(bundle).toContain("WebAssembly.instantiate");
    expect(bundle).toContain("automergeWasmBase64");
  });

  it("keeps obsidian external and imports no Node built-in at run time", () => {
    expect(bundle).toMatch(/require\("obsidian"\)/);
    expect(bundle).not.toMatch(/require\("(node:)?(fs|path|os|child_process)"\)/);
  });
});
