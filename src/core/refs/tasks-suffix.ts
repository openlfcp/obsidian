// A Tasks suffix after an inline ref inside a shared section
// (MARKDOWN-SECTIONS-01 §4.1, host facts H6 and H8): the Obsidian Tasks
// plugin reads its fields only at the end of the line, and appends ✅ after
// an inline ref, so inside a section an inline ref may be followed by Tasks
// fields. Outside a section MARKDOWN-REFS-01 is unchanged: any text after an
// inline ref is LFCP_REF_NOT_AT_LINE_END.

const VS = "️?";
const ID = "[A-Za-z0-9_-]+";
/** One field: dates, priority, recurrence, dependencies, on completion (§4.1 table). */
const FIELD = [
  `(?:📅|⏳|🛫|➕|✅|❌)${VS} \\d{4}-\\d{2}-\\d{2}`,
  `(?:🔺|⏫|🔼|🔽|⏬)${VS}`,
  `🔁${VS} [A-Za-z0-9,:]+(?: +[A-Za-z0-9,:]+)*`,
  `🆔${VS} ${ID}`,
  `⛔${VS} ${ID}(?:,${ID})*`,
  `🏁${VS} (?:keep|delete)`,
].join("|");
const SUFFIX = new RegExp(`^(?:[ \\t]+(?:${FIELD}))+(?:[ \\t]+\\^[A-Za-z0-9-]+)?[ \\t]*$`, "u");

/** The fields' signs, to tell a field given both before and after the ref. */
const SIGNS = [
  "📅",
  "⏳",
  "🛫",
  "➕",
  "✅",
  "❌",
  "🔺",
  "⏫",
  "🔼",
  "🔽",
  "⏬",
  "🔁",
  "🆔",
  "⛔",
  "🏁",
];
const PRIORITY = new Set(["🔺", "⏫", "🔼", "🔽", "⏬"]);

/** Whether `text` (what follows an inline ref) is a Tasks suffix. */
export function isTasksSuffix(text: string): boolean {
  return text.trim() !== "" && SUFFIX.test(text);
}

/** The kinds of field a text gives (a sign, or "priority" for any priority sign). */
function kinds(text: string): Set<string> {
  const out = new Set<string>();
  for (const s of SIGNS)
    if (new RegExp(`(?:^|[ \\t])${s}`, "u").test(text)) out.add(PRIORITY.has(s) ? "priority" : s);
  return out;
}

/** A field given both before the ref and in the suffix: ambiguous, the Task is blocked (§4.1). */
export function suffixAmbiguous(before: string, suffix: string): boolean {
  const after = kinds(suffix);
  return [...kinds(before)].some((k) => after.has(k));
}
