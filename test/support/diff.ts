// Test-only: a concise unified diff for golden fixture failures (LFCP-063).

/** A concise unified diff of two texts (line based, line endings shown). */
export function unifiedDiff(expected: string, actual: string, context = 2): string {
  const show = (l: string) => l.replace(/\r/g, "\\r");
  const a = expected.split("\n");
  const b = actual.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const out = [`@@ -${from + 1} +${from + 1} @@`];
  for (let i = from; i < start; i++) out.push(`  ${show(a[i] as string)}`);
  for (let i = start; i < endA; i++) out.push(`- ${show(a[i] as string)}`);
  for (let i = start; i < endB; i++) out.push(`+ ${show(b[i] as string)}`);
  for (let i = endA; i < Math.min(a.length, endA + context); i++)
    out.push(`  ${show(a[i] as string)}`);
  return out.join("\n");
}
