#!/usr/bin/env node
// Enforces the plugin's layer boundary (LFCP-058, OBSIDIAN-ARCHITECTURE-01
// §5): a thin Obsidian adapter in src/obsidian/ over Obsidian-free modules
// that another editor adapter can reuse.
//
//   obsidian           an import of `obsidian` outside the adapter layer
//                      (src/obsidian/, and in tests test/obsidian/ and the
//                      mock in test/mocks/)
//   adapter-import     a file in src/ outside src/obsidian/ importing from
//                      src/obsidian/ (only the entry point src/main.ts may)
//   runtime-obsidian   `obsidian` in package.json dependencies: the app
//                      provides it, so it is a devDependency for types only
//   node-import        a node:* or Node built-in import in src/ (the plugin
//                      also runs on Obsidian mobile, which has no Node)
//   node-global        a Node-only global (process, Buffer, ...) in src/
//   protocol-import    an import in src/ of a library the SDK owns:
//                      @automerge/*, @noble/*, hpke, @panva/hpke-noble, a
//                      CBOR or COSE library, or @openlfcp/wire/cbor (LFCP-059:
//                      the plugin uses the SDK and re-implements no protocol)
//   protocol-dependency  one of those libraries in package.json dependencies
//   node-only-sdk      @openlfcp/storage-node (Node only) in src/ or dependencies
//   test-only          fake-indexeddb imported from src/, or as a runtime dependency
//
//   node scripts/check-boundaries.mjs              check this repository
//   node scripts/check-boundaries.mjs --root DIR   check another tree
//   node scripts/check-boundaries.mjs --self-test  run scripts/boundary-fixtures/*
//
// Each problem is one line: <file>:<line> <rule>: <detail>

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ADAPTER_DIRS = ["src/obsidian/", "test/obsidian/", "test/mocks/"];
const ENTRY = "src/main.ts";
const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "__dirname",
  "__filename",
  "require",
  "global",
  "setImmediate",
  "clearImmediate",
]);
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const isObsidian = (spec) => spec === "obsidian" || spec.startsWith("obsidian/");
const isProtocolLib = (spec) =>
  /^@automerge\//.test(spec) ||
  /^@noble\//.test(spec) ||
  /^(hpke|@panva\/hpke-noble)($|\/)/.test(spec) ||
  /^(@[^/]+\/)?(cbor|cose)[^/]*($|\/)/.test(spec) ||
  spec === "@openlfcp/wire/cbor";
const isNodeOnlySdk = (spec) => /^@openlfcp\/storage-node($|\/)/.test(spec);
const isTestOnly = (spec) => /^fake-indexeddb($|\/)/.test(spec);
const isNodeBuiltin = (spec) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "fixtures") return [];
    return statSync(path).isDirectory() ? walk(path) : SOURCE.test(name) ? [path] : [];
  });
}

// Module specifiers and Node-global uses in one source file.
function scan(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specs = [];
  const globals = [];
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push([node.moduleSpecifier.text, line(node)]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const e = node.moduleReference.expression;
      if (ts.isStringLiteral(e)) specs.push([e.text, line(node)]);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        specs.push([node.arguments[0].text, line(node)]);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specs.push([node.argument.literal.text, line(node)]);
    }
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const p = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node);
      const isDeclaration =
        (ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isImportSpecifier(p)) &&
        p.name === node;
      if (!isMemberName && !isDeclaration) globals.push([node.text, line(node)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specs, globals };
}

export function check(root) {
  const problems = [];
  // Repository-relative paths with forward slashes.
  const rel = (p) => relative(root, p).split(sep).join("/");

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (isObsidian(dep)) {
        problems.push(
          `package.json:1 runtime-obsidian: ${dep} is a dependency, not a devDependency`,
        );
      }
      if (isProtocolLib(dep))
        problems.push(`package.json:1 protocol-dependency: ${dep} (use the SDK)`);
      if (isNodeOnlySdk(dep)) problems.push(`package.json:1 node-only-sdk: ${dep}`);
      if (isTestOnly(dep))
        problems.push(`package.json:1 test-only: ${dep} is a dependency, not a devDependency`);
    }
  }

  for (const file of [...walk(join(root, "src")), ...walk(join(root, "test"))]) {
    const path = rel(file);
    // The native harness is its own package, run inside Obsidian (docs/devel/testing/native-harness.md).
    if (path.startsWith("test/native/")) continue;
    const inAdapter = ADAPTER_DIRS.some((d) => path.startsWith(d));
    const inSrc = path.startsWith("src/");
    const { specs, globals } = scan(file);
    for (const [spec, ln] of specs) {
      const where = `${path}:${ln}`;
      if (isObsidian(spec) && !inAdapter) problems.push(`${where} obsidian: import of ${spec}`);
      if (inSrc && isNodeBuiltin(spec)) problems.push(`${where} node-import: ${spec} in src/`);
      if (inSrc && isProtocolLib(spec))
        problems.push(`${where} protocol-import: ${spec} in src/ (use the SDK)`);
      if (inSrc && isNodeOnlySdk(spec)) problems.push(`${where} node-only-sdk: ${spec} in src/`);
      if (inSrc && isTestOnly(spec)) problems.push(`${where} test-only: ${spec} in src/`);
      if (inSrc && !inAdapter && path !== ENTRY && spec.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(path), spec));
        if (target === "src/obsidian" || target.startsWith("src/obsidian/")) {
          problems.push(`${where} adapter-import: ${spec} reaches into src/obsidian/`);
        }
      }
    }
    if (inSrc) {
      for (const [g, ln] of globals) problems.push(`${path}:${ln} node-global: ${g} in src/`);
    }
  }
  return problems;
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let failed = false;

if (args.includes("--self-test")) {
  const fixtures = join(here, "boundary-fixtures");
  for (const name of readdirSync(fixtures).sort()) {
    const dir = join(fixtures, name);
    if (!statSync(dir).isDirectory()) continue;
    const want = readFileSync(join(dir, "expected.txt"), "utf8").split("\n").filter(Boolean).sort();
    const got = check(dir).sort();
    if (JSON.stringify(got) === JSON.stringify(want)) {
      console.log(`ok    ${name} (${want.length} expected problem(s))`);
    } else {
      failed = true;
      console.log(`FAIL  ${name}`);
      for (const l of want.filter((x) => !got.includes(x))) console.log(`      missing:    ${l}`);
      for (const l of got.filter((x) => !want.includes(x))) console.log(`      unexpected: ${l}`);
    }
  }
} else {
  const i = args.indexOf("--root");
  const root = i >= 0 ? args[i + 1] : join(here, "..");
  const problems = check(root);
  for (const p of problems) console.log(p);
  failed = problems.length > 0;
  console.log(`boundaries: ${problems.length} problem(s)`);
}
process.exit(failed ? 1 : 0);
