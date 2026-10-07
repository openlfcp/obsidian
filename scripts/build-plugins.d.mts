// Types of scripts/build-plugins.mjs for the tests.
import type { Metafile, Plugin } from "esbuild";

export const automergeSlim: Plugin;
export const automergeWasmDeflated: Plugin;
export function thirdPartyLicenses(root: string, metafile: Metafile): string;
