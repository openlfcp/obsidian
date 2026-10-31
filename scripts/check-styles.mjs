#!/usr/bin/env node
// Checks styles.css for what the community Scorecard reports in a plugin's
// CSS, and for colours a theme cannot change.
//
//   has              a :has() selector (Obsidian's Chromium supports it only
//                    in part, by the Scorecard's count)
//   not-list         a selector list inside :not(); chain :not(a):not(b)
//   important        !important
//   hex              a #hex colour
//   colour-function  rgb(), rgba(), hsl() or hsla()
//   colour-value     color, background, background-color, border-color, fill
//                    or stroke set to something other than an Obsidian
//                    variable, var(--…). Also allowed: transparent, inherit,
//                    currentColor and none; color-mix() of those, where black
//                    or white may darken or lighten a variable; and a CSS
//                    system colour (CanvasText, Highlight, …) inside
//                    @media (forced-colors: active), where only those apply.
//
//   node scripts/check-styles.mjs              check this repository's styles.css
//   node scripts/check-styles.mjs --file FILE  check another file
//   node scripts/check-styles.mjs --self-test  run scripts/style-fixtures/*
//
// Each problem is one line: <file>:<line> <rule>: <detail>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COLOUR_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "border-color",
  "fill",
  "stroke",
]);
const KEYWORDS = new Set(["transparent", "inherit", "currentcolor", "none"]);
const MIX_AGENTS = new Set(["black", "white"]);
const SYSTEM_COLOURS = new Set([
  "canvas",
  "canvastext",
  "linktext",
  "visitedtext",
  "activetext",
  "buttonface",
  "buttontext",
  "buttonborder",
  "field",
  "fieldtext",
  "highlight",
  "highlighttext",
  "selecteditem",
  "selecteditemtext",
  "mark",
  "marktext",
  "graytext",
  "accentcolor",
  "accentcolortext",
]);

/** The text with comments blanked out, newlines kept, so offsets stay on their line. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** The index of the parenthesis closing the one at `open`, or the text's end. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
}

/** Whether `s` has a comma outside any parentheses. */
function topLevelComma(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

/** The value's colour words, var(--…) removed; null when a var() has no -- name. */
function colourWords(value) {
  let rest = value;
  for (;;) {
    const at = rest.search(/var\(/i);
    if (at < 0) break;
    const inner = rest.slice(at + 4, closing(rest, at + 3)).trim();
    if (!inner.startsWith("--")) return null;
    rest = `${rest.slice(0, at)} ${rest.slice(closing(rest, at + 3) + 1)}`;
  }
  return rest;
}

/** Why a colour property's value is refused, or null when it is allowed. */
function badColour(value, forcedColors) {
  const rest = colourWords(value);
  if (rest === null) return "var() without a --variable";
  const mix = /^\s*color-mix\(\s*in\s+[a-z-]+\s*,([\s\S]*)\)\s*$/i.exec(rest);
  const words = (mix ? mix[1] : rest)
    .replace(/\d+(\.\d+)?%/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  for (const w of words) {
    if (KEYWORDS.has(w)) continue;
    if (mix && MIX_AGENTS.has(w)) continue;
    if (forcedColors && SYSTEM_COLOURS.has(w)) continue;
    return `${w.includes("(") ? `${w.slice(0, w.indexOf("("))}()` : w} is not an Obsidian variable`;
  }
  return null;
}

export function check(text, file = "styles.css") {
  const css = stripComments(text);
  const problems = [];
  const lineAt = (i) => css.slice(0, i).split("\n").length;
  const report = (i, rule, detail) => problems.push(`${file}:${lineAt(i)} ${rule}: ${detail}`);

  const selector = (prelude, start) => {
    for (const m of prelude.matchAll(/:has\(/gi)) report(start + m.index, "has", ":has()");
    for (const m of prelude.matchAll(/:not\(/gi)) {
      const open = m.index + 4;
      const args = prelude.slice(open + 1, closing(prelude, open));
      if (topLevelComma(args)) report(start + m.index, "not-list", `:not(${args.trim()})`);
    }
  };

  const declarations = (body, start, forcedColors) => {
    let from = 0;
    let depth = 0;
    const one = (decl, at) => {
      const colon = decl.indexOf(":");
      if (colon < 0) return;
      const lead = decl.length - decl.trimStart().length;
      const where = at + lead;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (/!\s*important/i.test(value)) report(where, "important", `${prop}: ${value}`);
      for (const m of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) report(where, "hex", m[0]);
      for (const m of value.matchAll(/\b(rgba?|hsla?)\(/gi)) {
        report(where, "colour-function", `${m[1]}()`);
      }
      // A hex or rgb() colour is reported above, once.
      if (COLOUR_PROPS.has(prop) && !/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(value)) {
        const why = badColour(value.replace(/!\s*important/i, ""), forcedColors);
        if (why) report(where, "colour-value", `${prop}: ${value} (${why})`);
      }
    };
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === ";" && depth === 0) || i === body.length) {
        one(body.slice(from, i), start + from);
        from = i + 1;
      }
    }
  };

  // A rule list: at-rules with a block nest one, other blocks hold declarations.
  const rules = (from, to, forcedColors) => {
    let i = from;
    while (i < to) {
      const brace = css.indexOf("{", i);
      const semi = css.indexOf(";", i);
      if (brace < 0 || brace >= to) break;
      if (semi >= 0 && semi < brace) {
        i = semi + 1; // @import and the like
        continue;
      }
      const prelude = css.slice(i, brace);
      let depth = 0;
      let end = brace;
      for (; end < to; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      const head = prelude.trim();
      if (head.startsWith("@")) {
        const forced = forcedColors || /forced-colors\s*:\s*active/i.test(head);
        if (/^@(media|supports|container|layer|document)\b/i.test(head)) {
          rules(brace + 1, end, forced);
        } else {
          declarations(css.slice(brace + 1, end), brace + 1, forced);
        }
      } else {
        selector(prelude, i);
        declarations(css.slice(brace + 1, end), brace + 1, forcedColors);
      }
      i = end + 1;
    }
  };

  rules(0, css.length, false);
  return problems;
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let failed = false;

if (args.includes("--self-test")) {
  const fixtures = join(here, "style-fixtures");
  for (const name of readdirSync(fixtures).sort()) {
    const dir = join(fixtures, name);
    if (!statSync(dir).isDirectory()) continue;
    const want = readFileSync(join(dir, "expected.txt"), "utf8").split("\n").filter(Boolean).sort();
    const got = check(readFileSync(join(dir, "styles.css"), "utf8")).sort();
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
  const i = args.indexOf("--file");
  const file = i >= 0 ? args[i + 1] : join(here, "..", "styles.css");
  const problems = check(readFileSync(file, "utf8"), i >= 0 ? file : "styles.css");
  for (const p of problems) console.log(p);
  failed = problems.length > 0;
  console.log(`styles: ${problems.length} problem(s)`);
}
process.exit(failed ? 1 : 0);
