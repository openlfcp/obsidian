// LFCP-02-067/068, the plugin's headless side: the section paths of the
// plugin, measured on a real runtime (the real SDK, IndexedDB storage, the
// section engine as the plugin runs it), offline. Run on purpose only:
//
//   LFCP_PERF=1 LFCP_PERF_OUT=<file.json> pnpm perf [-- -t W200]
//
// One process, one workload at a time. For each workload: warm-up runs,
// then samples of
//   - durable local update: one paragraph edited in the note, the engine
//     pass until its commit's durable receipt (no coalescing wait);
//   - remote projection: a model change committed as another writer would,
//     the pass that writes it into the note;
//   - cached open: a restart on the same storage, until the section is open
//     and its note passes cleanly;
//   - card: the details card's facts from the cached model;
// and the longest event-loop delay during the edits (the main-thread
// blocking proxy), the heap, the note and checkpoint sizes. Native metrics
// (key to paint, render, memory of the app) are not measured here.

import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, describe, expect, it } from "vitest";
import { parseSections } from "../../src/core/sections/parser";
import { preflight, proposeRange } from "../../src/core/sections/share";
import { sectionCard } from "../../src/core/status/card";
import { statusView } from "../../src/core/status/reducer";
import { Device, FakeLocal } from "../support/lfcp-env";
import { PATH, vault } from "./harness";
import { noteFacts, WORKLOADS, type WorkloadSpec, workloadNote } from "./workloads";

const RUN = process.env.LFCP_PERF === "1";
const OUT = process.env.LFCP_PERF_OUT;
const results: Record<string, unknown> = {};

afterAll(() => {
  if (OUT !== undefined && Object.keys(results).length > 0)
    writeFileSync(
      OUT,
      `${JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2)}\n`,
    );
});

/** p50, p95 and max of samples (ms), and their count. */
function stats(samples: readonly number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] as number;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1) as number) };
}

async function measure(
  spec: WorkloadSpec,
  samples: { edit: number; other: number; warmup: number },
  /** W200-H: changes committed to the model before measuring, in batches of 10. */
  history = 0,
) {
  const device = new Device();
  const local = new FakeLocal();
  let v = await vault(device, local);
  const note = workloadNote(spec);
  v.files.set(PATH, note);
  const line = note.split("\n").indexOf("## Workload");
  const range = proposeRange(note, line);
  if (range === null) throw new Error("no range");
  const t0 = performance.now();
  const created = await v.creation.run(
    await v.creation.prepare(PATH, note, preflight(note, range)),
  );
  const createMs = performance.now() - t0;
  const R = fromBase64url(created.entry.resource) as ResourceId;
  const b64 = toBase64url(R);
  const sectionId = created.entry.sectionId;
  await v.pass(PATH);

  // History (W200-H): text edits, moves of root nodes (old placement slots
  // stay), deletions and restores, straight to the model as other writers'.
  let historyMs = 0;
  if (history > 0) {
    const h0 = performance.now();
    const rand = (() => {
      let x = spec.seed >>> 0;
      return () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 2 ** 32;
      };
    })();
    for (let done = 0; done < history; ) {
      const snap = v.port.snapshot(b64, sectionId);
      if (snap === undefined) throw new Error("no model");
      const active = Object.entries(snap.nodes).filter(([, n]) => n.lifecycle === "active");
      const deleted = Object.entries(snap.nodes).filter(([, n]) => n.lifecycle === "deleted");
      const roots = snap.order[sectionId] ?? [];
      const intents: unknown[] = [];
      const used = new Set<string>();
      while (intents.length < 10 && done + intents.length < history) {
        const k = (done + intents.length) % 4;
        const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
        if (k === 0) {
          const id = pick(active.filter(([i, n]) => n.kind === "paragraph" && !used.has(i)))?.[0];
          if (id === undefined) {
            intents.push({ intent: "section.set_title", title: `Workload ${done}` });
            continue;
          }
          used.add(id);
          intents.push({
            intent: "text.edit",
            id,
            edits: [{ index: 0, deleteCount: 0, insert: "h" }],
            base: snap.revision,
          });
        } else if (k === 1 && roots.length > 2) {
          const id = pick(roots.slice(1));
          if (used.has(id)) continue;
          used.add(id);
          intents.push({
            intent: "node.move",
            id,
            parent: sectionId,
            after: pick(roots.filter((r) => r !== id)),
          });
        } else if (k === 2) {
          const id = pick(active.filter(([i, n]) => n.kind === "item" && !used.has(i)))?.[0];
          if (id === undefined) {
            intents.push({ intent: "section.set_title", title: `Workload ${done}` });
            continue;
          }
          used.add(id);
          intents.push({ intent: "node.delete", id });
        } else if (deleted.length > 0) {
          const id = pick(deleted.filter(([i]) => !used.has(i)))?.[0];
          if (id === undefined) {
            intents.push({ intent: "section.set_title", title: `Workload ${done}` });
            continue;
          }
          used.add(id);
          intents.push({ intent: "node.restore", id });
        } else intents.push({ intent: "section.set_title", title: `Workload ${done}` });
      }
      await v.port.commit(b64, intents as never, { operationId: crypto.randomUUID() });
      done += intents.length;
      if (done % 1000 === 0) console.log(`HISTORY ${spec.name} ${done}/${history}`);
    }
    historyMs = performance.now() - h0;
    await v.pass(PATH);
  }

  // Paragraphs of the section in the note: the edit targets.
  const paragraphLines = () => {
    const md = v.files.get(PATH) as string;
    const s = parseSections(md).sections[0];
    if (s === undefined) throw new Error("no section");
    const lines = md.split("\n");
    // Each paragraph's last text line: not a marker comment, not empty.
    return s.nodes
      .filter((n) => n.kind === "paragraph")
      .map((n) => {
        for (let l = Math.min(n.lines.to, lines.length - 1); l >= n.lines.from; l--) {
          const t = (lines[l] ?? "").trim();
          if (t !== "" && !t.startsWith("<!--")) return l;
        }
        return -1;
      })
      .filter((l) => l >= 0);
  };

  // Durable local update: append a word to one paragraph, pass until the durable receipt.
  const lag = monitorEventLoopDelay({ resolution: 5 });
  const editSamples: number[] = [];
  const targets = paragraphLines();
  for (let i = 0; i < samples.warmup + samples.edit; i++) {
    const at = targets[i % targets.length] as number;
    const lines = (v.files.get(PATH) as string).split("\n");
    lines[at] = `${lines[at]} e${i}`;
    v.files.set(PATH, lines.join("\n"));
    if (i === samples.warmup) lag.enable();
    const s = performance.now();
    const p = await v.pass(PATH, at);
    const ms = performance.now() - s;
    if (p.sections[0]?.local?.kind !== "committed")
      throw new Error(
        `edit ${i}: ${JSON.stringify({ local: p.sections[0]?.local?.kind, skipped: p.sections[0]?.skipped, lost: p.sections[0]?.lost.length, held: p.sections[0]?.held.length, n: p.sections.length })}`,
      );
    if (i >= samples.warmup) editSamples.push(ms);
  }
  lag.disable();

  // Remote projection: another writer's text edit, committed to the model; the pass that projects it.
  const remoteSamples: number[] = [];
  for (let i = 0; i < samples.warmup + samples.other; i++) {
    const snap = v.port.snapshot(b64, sectionId);
    const id = Object.entries(snap?.nodes ?? {}).find(
      ([, n]) => n.kind === "paragraph" && n.lifecycle === "active",
    )?.[0];
    const node = id === undefined ? undefined : { id };
    if (snap === undefined || node === undefined) throw new Error("no paragraph");
    await v.port.commit(
      b64,
      [
        {
          intent: "text.edit",
          id: node.id,
          edits: [{ index: 0, deleteCount: 0, insert: "R" }],
          base: snap.revision,
        },
      ],
      { operationId: crypto.randomUUID() },
    );
    const s = performance.now();
    const p = await v.pass(PATH);
    const ms = performance.now() - s;
    if (p.changes.length === 0) throw new Error(`remote ${i}: nothing projected`);
    if (i >= samples.warmup) remoteSamples.push(ms);
  }

  // Card: the details card's facts from the cached model.
  const cardSamples: number[] = [];
  for (let i = 0; i < samples.warmup + samples.other; i++) {
    const s = performance.now();
    const snap = v.port.snapshot(b64, sectionId);
    const nodes = Object.values(snap?.nodes ?? {}).filter((n) => n.lifecycle === "active");
    const count = (kind: string) => nodes.filter((n) => n.kind === kind).length;
    const view = statusView({
      session: "s",
      revision: 1,
      replica: "loaded",
      access: "writer",
      pendingControl: [],
      connection: "offline",
      catchUp: "current-at-checkpoint",
      problems: [],
      batches: [],
      acceptanceEvidence: "available",
      projections: [],
    });
    sectionCard({
      title: "Workload",
      view,
      resource: b64,
      sectionId,
      counts: { tasks: count("task"), paragraphs: count("paragraph"), items: count("item") },
    });
    const ms = performance.now() - s;
    if (i >= samples.warmup) cardSamples.push(ms);
  }

  const storage = v.runtime.storage as LfcpStorage;
  const units = (await storage.outbound.list(R)).filter((i) => i.kind === "data-unit");
  await v.runtime.stop();
  let checkpointBytes: number | null = null;

  // Cached open: restart on the same storage; open the section; the note passes with nothing to do.
  const openSamples: number[] = [];
  const openRuns = Math.max(3, Math.min(samples.other, 10));
  const files = v.files;
  for (let i = 0; i < 2 + openRuns; i++) {
    const s = performance.now();
    v = await vault(device, local);
    for (const [k, x] of files) v.files.set(k, x);
    await v.runtime.openSection(R);
    const p = await v.pass(PATH);
    const ms = performance.now() - s;
    if (p.changes.length !== 0) throw new Error(`open ${i}: the note changed on open`);
    if (i === 0)
      checkpointBytes = (await v.runtime.storage?.profileState.checkpoint(R))?.state.length ?? null;
    if (i >= 2) openSamples.push(ms);
    await v.runtime.stop();
  }

  const heap = process.memoryUsage();
  return {
    historyChanges: history,
    historyMs: Math.round(historyMs),
    spec,
    note: noteFacts(note),
    createMs: Math.round(createMs),
    durableLocalUpdate: stats(editSamples),
    remoteProjection: stats(remoteSamples),
    cachedOpen: stats(openSamples),
    card: stats(cardSamples),
    longestEventLoopDelayMs: Math.round(lag.max / 1e6),
    eventLoopDelayP99Ms: Math.round(lag.percentile(99) / 1e6),
    heapUsedMiB: Math.round(heap.heapUsed / 2 ** 20),
    rssMiB: Math.round(heap.rss / 2 ** 20),
    queuedUnits: units.length,
    checkpointBytes,
  };
}

describe.skipIf(!RUN)("section performance, headless (LFCP-02-067/068)", () => {
  for (const name of ["W20", "W100", "W200"])
    it(name, async () => {
      const r = await measure(WORKLOADS[name] as WorkloadSpec, { edit: 200, other: 30, warmup: 5 });
      results[name] = r;
      console.log(`PERF ${JSON.stringify({ name, ...r, spec: undefined })}`);
      expect(r.durableLocalUpdate.n).toBe(200);
    }, 900_000);

  // Once each: W200-H (history growth) and W2000 (exploratory: safe, not fast).
  it("W200-H", async () => {
    const r = await measure(
      WORKLOADS.W200 as WorkloadSpec,
      { edit: 50, other: 10, warmup: 3 },
      10_000,
    );
    results["W200-H"] = r;
    console.log(`PERF ${JSON.stringify({ name: "W200-H", ...r, spec: undefined })}`);
    expect(r.durableLocalUpdate.n).toBe(50);
  }, 3_600_000);

  it("W2000", async () => {
    const r = await measure(WORKLOADS.W2000 as WorkloadSpec, { edit: 10, other: 3, warmup: 2 });
    results.W2000 = r;
    console.log(`PERF ${JSON.stringify({ name: "W2000", ...r, spec: undefined })}`);
    expect(r.durableLocalUpdate.n).toBe(10);
  }, 3_600_000);
});
