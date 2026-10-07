// The esbuild plugins of the plugin bundle (scripts/build.mjs), shared with
// the test that loads the bundled Automerge wasm (test/bundle.test.ts).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { deflateRawSync } from "node:zlib";

/** Exactly `@automerge/automerge` -> its `/slim` entry; subpaths are untouched. */
export const automergeSlim = {
  name: "automerge-slim",
  setup(b) {
    b.onResolve({ filter: /^@automerge\/automerge$/ }, (args) =>
      b.resolve("@automerge/automerge/slim", {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
      }),
    );
  },
};

/**
 * Automerge's wasm, stored deflated (POST-018 follow-up, 0.3.1): the SDK's
 * initializeAutomerge() imports `@automerge/automerge/automerge.wasm.base64`
 * for the wasm as one base64 string, 4.9 MB of the bundle, which kept
 * main.js over the 5 MB Obsidian Sync limit. This module replaces it: the
 * same bytes (decoded from that module, so they always match its JS glue),
 * deflated at build time and stored as base64 (about 1.5 MB), inflated with
 * fflate (already in the bundle, through the SDK) when the SDK imports it,
 * and handed over as the base64 string the SDK expects. The SDK then
 * compiles it asynchronously as before.
 */
export const automergeWasmDeflated = {
  name: "automerge-wasm-deflated",
  setup(b) {
    const filter = /^@automerge\/automerge\/automerge\.wasm\.base64$/;
    b.onResolve({ filter }, async (args) => {
      if (args.pluginData?.real === true) return undefined;
      const real = await b.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { real: true },
      });
      if (real.errors.length > 0) return { errors: real.errors };
      return {
        path: real.path,
        namespace: "automerge-wasm-deflated",
        pluginData: { resolveDir: args.resolveDir },
      };
    });
    b.onLoad({ filter: /.*/, namespace: "automerge-wasm-deflated" }, async (args) => {
      const text = await readFile(args.path, "utf8");
      const m = /automergeWasmBase64\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(text);
      if (m === null) throw new Error(`no automergeWasmBase64 string in ${args.path}`);
      const deflated = deflateRawSync(Buffer.from(m[1], "base64"), { level: 9 });
      const contents = `import { inflateSync } from "fflate";
const DEFLATED = ${JSON.stringify(deflated.toString("base64"))};
const fromB64 = (s) => {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const toB64 = (bytes) => {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const automergeWasmBase64 = toB64(inflateSync(fromB64(DEFLATED)));
`;
      return { contents, loader: "js", resolveDir: args.pluginData.resolveDir };
    });
  },
};

/**
 * The license texts of the third-party packages in a bundle, from esbuild's
 * metafile, as one comment for the end of main.js: their MIT notices must
 * travel with the code, and the release ships main.js only. The project's
 * own packages (@openlfcp/*, Apache-2.0) are left out.
 */
export function thirdPartyLicenses(root, metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const file = input.replace(/^[a-z-]+:/, "");
    let dir = dirname(isAbsolute(file) ? file : join(root, file));
    while (dir !== dirname(dir)) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg.name === "string") {
          packages.set(pkg.name, { dir, version: pkg.version, license: pkg.license });
          break;
        }
      }
      dir = dirname(dir);
    }
  }
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  const parts = [];
  for (const [name, p] of [...packages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (name === own || name.startsWith("@openlfcp/")) continue;
    const file = readdirSync(p.dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
    if (file === undefined) throw new Error(`no LICENSE file for bundled ${name}`);
    const text = readFileSync(join(p.dir, file), "utf8").replaceAll("*/", "* /").trim();
    parts.push(`${name}@${p.version} (${p.license}):\n\n${text}`);
  }
  return `\n/*! Third-party licenses of the bundled packages:\n\n${parts.join("\n\n---\n\n")}\n*/\n`;
}
