// LFCP-02-025 in the plugin: typing in a section coalesces into one unit
// per burst through the SDK's TypingCoalescer, on the plugin's runtime,
// offline. A pass of Text edits waits and is replaced by the next; a pause
// (tick) commits it and the next pass moves the base by its receipt; a
// structural change commits at once; a restart while one waits replans the
// edit from the note, never loses or doubles it.

import type { Flushed } from "@openlfcp/client";
import { toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
import { advance } from "../../../src/core/sections/journal";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SECTION = "0192e4a0-0000-7000-8000-000000000001";
const PARA = "0192e4a0-0000-7000-8000-000000000002";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function setup(device = new Device(), local = new FakeLocal(), existing?: Uint8Array) {
  const r = await LfcpRuntime.start(device.env(local));
  running.push(r);
  const status = r.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const me = status.principalId;
  let R = existing;
  if (R === undefined) {
    R = await r.createSectionResource({ name: "L", endpoints: [URL], coordinatorUrl: URL });
    await r.openSection(R as never);
    await r.commitSection(
      R as never,
      [
        { intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me },
        {
          intent: "paragraph.create",
          id: PARA,
          parent: SECTION,
          after: null,
          text: "",
          createdBy: me,
        },
      ],
      { operationId: "create" },
    );
  } else await r.openSection(R as never);
  const clock = { now: 0 };
  /** What the host does with a coalesced pass the timer committed or that failed (default: nothing). */
  const flushed: { fn: (f: Flushed) => void } = { fn: () => undefined };
  const journal = new KeyValueSectionJournalStore(r.localState);
  const port = new SdkSectionPort(
    {
      profile: (res) => r.sectionProfile(res),
      commit: (res, intents, o) => r.commitSection(res, intents, o),
      storage: r.storage as LfcpStorage,
      canWrite: (res) => r.canWriteSection(res),
    },
    { now: () => clock.now, onFlushed: (_r, f) => flushed.fn(f) },
  );
  let n = 10;
  const engine = new SectionEngine({
    port,
    journal,
    bases: new KeyValueSectionBaseStore(r.localState),
    newNodeId: () => `0192e4a0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
    newOperationId: () => `op-${++n}-${Math.random()}`,
    createdBy: me,
    newProjectionId: () => "projection",
    tasks: () => undefined,
    newTask: (line, id) => ({ id, title: line }),
  });
  const S = { resourceId: R, sectionId: SECTION };
  const note = (text: string) =>
    [
      "## Launch",
      formatBoundary("start", S as never),
      formatNodeMarker("paragraph", PARA),
      text,
      formatBoundary("end", S as never),
      "",
    ].join("\n");
  const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
  const pass = async (md: string) => {
    const p = await engine.pass("L.md", md, ctx);
    const out = applyChanges(md, p.changes);
    await engine.written(p, out);
    return out;
  };
  const units = async () =>
    ((await r.storage?.outbound.list(R as never)) ?? []).filter((i) => i.kind === "data-unit")
      .length;
  const text = () => port.snapshot(toBase64url(R as Uint8Array), SECTION)?.nodes[PARA]?.text;
  return {
    r,
    R: R as Uint8Array,
    port,
    engine,
    journal,
    flushed,
    note,
    pass,
    units,
    text,
    clock,
    device,
    local,
  };
}

describe("typing coalescing (025)", () => {
  it("twenty keystrokes are one unit after a pause, with the exact text", async () => {
    const env = await setup();
    await env.pass(env.note(""));
    const before = await env.units();
    const word = "Coalesced typing test";
    for (let i = 1; i <= word.length; i++) {
      env.clock.now += 50;
      await env.pass(env.note(word.slice(0, i)));
    }
    // Waiting: nothing committed yet.
    expect(await env.units()).toBe(before);
    expect(env.text()).toBe("");
    env.clock.now += 2000;
    await env.port.tick(env.clock.now);
    expect(await env.units()).toBe(before + 1);
    expect(env.text()).toBe(word);
    // The next pass moves the base by the receipt and has nothing to send.
    const md = env.note(word);
    expect(await env.pass(md)).toBe(md);
    expect(await env.units()).toBe(before + 1);
    env.clock.now += 5000;
    await env.port.tick(env.clock.now);
    expect(env.text()).toBe(word);
  });

  it("a structural change commits at once", async () => {
    const env = await setup();
    await env.pass(env.note(""));
    env.clock.now += 50;
    await env.pass(env.note("Draft"));
    const before = await env.units();
    // A new paragraph: committed in this pass (with the waiting Text before it).
    const out = await env.pass(env.note("Draft\n\nSecond paragraph"));
    expect(await env.units()).toBeGreaterThan(before);
    expect(out).toContain("<!-- lfcp-node: paragraph:");
    expect(env.text()).toBe("Draft");
  });

  it("a restart while a pass waits replans it from the note: nothing lost or doubled", async () => {
    const env = await setup();
    await env.pass(env.note(""));
    env.clock.now += 50;
    await env.pass(env.note("Typed before the crash"));
    expect(env.text()).toBe("");
    await env.r.stop();
    running.splice(0);
    const again = await setup(env.device, env.local, env.R);
    const md = again.note("Typed before the crash");
    await again.pass(md);
    again.clock.now += 5000;
    await again.port.tick(again.clock.now);
    expect(again.text()).toBe("Typed before the crash");
    expect(await again.pass(md)).toBe(md);
    again.clock.now += 5000;
    await again.port.tick(again.clock.now);
    expect(again.text()).toBe("Typed before the crash");
  });

  // The owner's IME check of 0.4.0-beta.6: a composed word waited in the
  // coalescer; Enter on a Task line made a structural pass, and the timer
  // committed the waiting word while that pass ran. The pass had decided to
  // replan the waiting word and sent it again: the peer showed it twice, the
  // note and the base drifted apart, and later edits were refused.
  it("the timer committing a waiting pass while the next pass runs sends nothing twice", async () => {
    const env = await setup();
    const P = "A paragraph for typing.";
    await env.pass(env.note(""));
    env.clock.now += 50;
    await env.pass(env.note(P));
    env.clock.now += 3000;
    await env.port.tick(env.clock.now);
    await env.pass(env.note(P));
    env.clock.now += 50;
    await env.pass(env.note(`${P}\u3000日本`));
    expect(env.text()).toBe(P);
    // The host's timer fires just after the next pass looked at what waits.
    let ticking: Promise<void> | null = null;
    const waiting = env.port.waiting.bind(env.port);
    env.port.waiting = (resource: string, key: string) => {
      const w = waiting(resource, key);
      if (w !== undefined && ticking === null) ticking = env.port.tick(env.clock.now + 3000);
      return w;
    };
    let md = await env.pass(env.note(`${P}\u3000日本\n\n仕事`));
    await ticking;
    for (let k = 0; k < 3; k++) {
      env.clock.now += 3000;
      await env.port.tick(env.clock.now);
      md = await env.pass(md);
    }
    expect(env.text()).toBe(`${P}\u3000日本`);
    expect(md.split("\n").filter((l) => l.includes("日本"))).toEqual([`${P}\u3000日本`]);
    expect(md).toContain("仕事");
  });
});

const P = "A paragraph for typing.";

/**
 * A vault in the state 0.4.0-beta.6 left after the race above (the lock
 * off): the model holds the composed word twice, the projection's base three
 * times. The host's handling of a failed coalesced pass is set as
 * sections-host does it: the operation abandoned, its Text nodes drifted.
 */
async function drifted() {
  const env = await setup();
  const handled: Promise<void>[] = [];
  env.flushed.fn = (f) => {
    if (f.kind !== "failed") return;
    handled.push(
      (async () => {
        const e = await env.journal.get(f.operationId);
        if (e !== undefined)
          await env.journal.put(advance(e, "abandoned", { reason: "INVALID_INTENT" }));
        const ids = (f.intents as { intent: string; id?: string }[])
          .filter((i) => i.intent === "text.edit")
          .map((i) => i.id as string);
        await env.engine.drifted("projection", ids);
      })(),
    );
  };
  await env.pass(env.note(""));
  env.clock.now += 50;
  await env.pass(env.note(P));
  env.clock.now += 3000;
  await env.port.tick(env.clock.now);
  await env.pass(env.note(P));
  env.clock.now += 50;
  await env.pass(env.note(`${P}\u3000日本`));
  const exclusive = env.port.exclusive;
  env.port.exclusive = <T>(_r: string, fn: () => Promise<T>) => fn();
  let ticking: Promise<void> | null = null;
  const waiting = env.port.waiting.bind(env.port);
  env.port.waiting = (resource: string, key: string) => {
    const w = waiting(resource, key);
    if (w !== undefined && ticking === null) ticking = env.port.tick(env.clock.now + 3000);
    return w;
  };
  const md = await env.pass(env.note(`${P}\u3000日本\n\n仕事`));
  await ticking;
  env.port.exclusive = exclusive;
  env.port.waiting = waiting;
  expect(env.text()).toBe(`${P}\u3000日本\u3000日本`);
  /** The host's handling of what the timer flushed is done (it starts the next pass). */
  const idle = async () => {
    while (handled.length > 0) await handled.shift();
  };
  return { env, md, idle };
}

/** Passes and timer ticks until the note settles (as the host's passes and timer do). */
async function settle(
  env: Awaited<ReturnType<typeof setup>>,
  idle: () => Promise<void>,
  md: string,
  rounds = 4,
) {
  let out = md;
  for (let k = 0; k < rounds; k++) {
    out = await env.pass(out);
    env.clock.now += 3000;
    await env.port.tick(env.clock.now);
    await idle();
  }
  return out;
}

const paragraph = (md: string) => md.split("\n").find((l) => l.startsWith("A paragraph"));

describe("a base that drifted from the model heals (owner's IME check of 0.4.0-beta.6)", () => {
  it("the model's Text is shown, nothing is sent or deleted, and the next edit syncs", async () => {
    const { env, md, idle } = await drifted();
    const units = await env.units();
    const healed = await settle(env, idle, md);
    expect(env.text()).toBe(`${P}\u3000日本\u3000日本`);
    expect(paragraph(healed)).toBe(`${P}\u3000日本\u3000日本`);
    expect(await env.units()).toBe(units);
    const typed = healed.replace(/^(A paragraph.*)$/m, "$1 more");
    const after = await settle(env, idle, typed);
    expect(env.text()).toBe(`${P}\u3000日本\u3000日本 more`);
    expect(paragraph(after)).toBe(`${P}\u3000日本\u3000日本 more`);
  });

  it("C's state: the note lost the word, the model has it twice, kept copies: the note shows the model", async () => {
    const { env, md, idle } = await drifted();
    for (let i = 0; i < 7; i++)
      await env.journal.putCandidate({
        candidateId: `beta6-${i}`,
        projectionId: "projection",
        reason: "rejected",
        sourceText: `## Launch\n${P} \n`,
      });
    const lost = md.replace(/^(A paragraph.*)$/m, `${P} `);
    const units = await env.units();
    const healed = await settle(env, idle, lost, 5);
    // Nothing deleted in the shared model: the peer keeps both words.
    expect(env.text()).toBe(`${P}\u3000日本\u3000日本`);
    expect(paragraph(healed)).toBe(`${P}\u3000日本\u3000日本`);
    expect(await env.units()).toBe(units);
    // The kept copies stay listed, not applied.
    const kept = await env.journal.candidates("projection");
    expect(kept.filter((c) => c.candidateId.startsWith("beta6-"))).toHaveLength(7);
    // A pass now finds nothing to send or to heal.
    const p = await env.engine.pass("L.md", healed, {
      caretLine: null,
      deletedIds: new Set(),
      origin: "other",
    });
    expect(p.changes).toEqual([]);
    expect(p.sections[0]?.local?.kind ?? "nothing").toBe("nothing");
  });
});
