// Scale workloads (LFCP-02-067, MVP-0.2-TEST-AND-RELEASE-PLAN §9): one
// deterministic note per workload, from a recorded seed. A section under
// "## Workload" between private text, with Tasks (some nested), child and
// root paragraphs of about `paragraph` Unicode scalars in Latin, Cyrillic
// and emoji, ordinary list items and supported dates, nesting up to
// `depth` levels. Test data only.

export interface WorkloadSpec {
  readonly name: string;
  readonly seed: number;
  readonly tasks: number;
  /** Of `tasks`, how many are nested under another Task. */
  readonly nestedTasks: number;
  readonly paragraphs: number;
  /** Unicode scalars per paragraph, about. */
  readonly paragraph: number;
  readonly items: number;
  /** Deepest list nesting (1: no nesting). */
  readonly depth: number;
}

export const WORKLOADS: Readonly<Record<string, WorkloadSpec>> = {
  W20: {
    name: "W20",
    seed: 20,
    tasks: 20,
    nestedTasks: 0,
    paragraphs: 20,
    paragraph: 80,
    items: 10,
    depth: 1,
  },
  W100: {
    name: "W100",
    seed: 100,
    tasks: 100,
    nestedTasks: 25,
    paragraphs: 100,
    paragraph: 120,
    items: 25,
    depth: 4,
  },
  W200: {
    name: "W200",
    seed: 200,
    tasks: 200,
    nestedTasks: 50,
    paragraphs: 200,
    paragraph: 200,
    items: 50,
    depth: 4,
  },
  W2000: {
    name: "W2000",
    seed: 2000,
    tasks: 2000,
    nestedTasks: 500,
    paragraphs: 2000,
    paragraph: 200,
    items: 500,
    depth: 4,
  },
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = [
  "contract",
  "venue",
  "budget",
  "review",
  "draft",
  "release",
  "schedule",
  "partner",
  "договор",
  "встреча",
  "бюджет",
  "черновик",
  "выпуск",
  "команда",
  "план",
  "отчёт",
  "🚀",
  "📌",
  "🎯",
  "🌿",
  "café",
  "naïve",
  "Zürich",
  "São",
];

/** About `n` Unicode scalars of words. */
function text(r: () => number, n: number): string {
  const out: string[] = [];
  let len = 0;
  while (len < n) {
    const w = WORDS[Math.floor(r() * WORDS.length)] as string;
    out.push(w);
    len += [...w].length + 1;
  }
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const date = (r: () => number) => {
  const d = new Date(Date.UTC(2026, 10, 1) + Math.floor(r() * 120) * 86_400_000);
  return d.toISOString().slice(0, 10);
};

/** The note of a workload: private text, the section under "## Workload", private text. */
export function workloadNote(spec: WorkloadSpec): string {
  const r = rng(spec.seed);
  const lines: string[] = ["PRIVATE_BEFORE: notes nobody else sees.", "", "## Workload", ""];
  let _tasks = 0;
  let nested = 0;
  let paragraphs = 0;
  let items = 0;
  const top = spec.tasks - spec.nestedTasks;
  // Root Tasks, some with nested Tasks, child paragraphs and items under them.
  for (let t = 0; t < top; t++) {
    const due = r() < 0.5 ? ` 📅 ${date(r)}` : "";
    lines.push(`- [${r() < 0.2 ? "x" : " "}] ${text(r, 30)}${due}`);
    _tasks++;
    if (paragraphs < spec.paragraphs && r() < 0.6) {
      lines.push(`  ${text(r, spec.paragraph)}`);
      paragraphs++;
    }
    let level = 1;
    while (nested < spec.nestedTasks && level < spec.depth && r() < 0.35) {
      const indent = "  ".repeat(level);
      lines.push(`${indent}- [ ] ${text(r, 25)}`);
      _tasks++;
      nested++;
      level++;
    }
    if (items < spec.items && r() < 0.25) {
      lines.push(`  - ${text(r, 20)}`);
      items++;
    }
    lines.push("");
  }
  // What the loop left: nested Tasks under one more root Task, then items and root paragraphs.
  while (nested < spec.nestedTasks) {
    lines.push(`- [ ] ${text(r, 30)}`, `  - [ ] ${text(r, 25)}`, "");
    _tasks += 2;
    nested++;
  }
  while (items < spec.items) {
    lines.push(`- ${text(r, 20)}`);
    items++;
  }
  lines.push("");
  while (paragraphs < spec.paragraphs) {
    lines.push(text(r, spec.paragraph), "");
    paragraphs++;
  }
  lines.push("## After", "", "PRIVATE_AFTER: not shared either.", "");
  return lines.join("\n");
}

/** The note's size facts: bytes and Unicode scalars (recorded with each run). */
export function noteFacts(note: string): {
  readonly bytes: number;
  readonly scalars: number;
  readonly lines: number;
} {
  return {
    bytes: new TextEncoder().encode(note).length,
    scalars: [...note].length,
    lines: note.split("\n").length,
  };
}
