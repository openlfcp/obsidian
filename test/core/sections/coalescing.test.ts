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
import { abandonOnce } from "../../../src/core/sections/journal";
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
  // sections-host reads the note first: its bookkeeping may come after passes.
  const late = { gate: Promise.resolve() };
  // One after the other, as sections-host runs them (port.exclusive).
  let chain = Promise.resolve();
  env.flushed.fn = (f) => {
    if (f.kind !== "failed") return;
    chain = chain.then(async () => {
      await late.gate;
      // As sections-host: a pass may have settled the operation already.
      if ((await abandonOnce(env.journal, f.operationId, "INVALID_INTENT")) === undefined) return;
      const ids = (f.intents as { intent: string; id?: string }[])
        .filter((i) => i.intent === "text.edit")
        .map((i) => i.id as string);
      await env.engine.drifted("projection", ids);
    });
    handled.push(chain);
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
  return { env, md, idle, late };
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

  // The owner's check of 0.4.0-beta.7: after the heal, edits typed into the
  // healed paragraph were replaced by older text, or landed at wrong places
  // ("日本本本"). The heal stored its base ("the note's Text at the model's
  // revision") before its pass, and a pass the user's typing abandoned left
  // it stored: later edits were planned on Text the model never had.
  it("a heal pass that is not written stores nothing; typing after it never lands wrong", async () => {
    const { env, md, idle } = await drifted();
    let cur = await env.pass(md);
    env.clock.now += 3000;
    await env.port.tick(env.clock.now);
    await idle();
    const before = env.text();
    // Two passes see the same Text: the second would heal; it is not written.
    cur = await env.pass(cur);
    const p = await env.engine.pass("L.md", cur, {
      caretLine: null,
      deletedIds: new Set(),
      origin: "other",
    });
    env.engine.abandoned(p);
    // The user types at the end of the paragraph meanwhile.
    for (const add of ["k", "a", "m", "i"]) {
      cur = cur.replace(/^(A paragraph.*)$/m, `$1${add}`);
      cur = await env.pass(cur);
      env.clock.now += 300;
      await env.port.tick(env.clock.now);
      await idle();
      // Nothing the user typed reached the model at a wrong place: it is held.
      expect(env.text()).toBe(before);
      expect(paragraph(cur)?.endsWith("kami".slice(0, "kami".indexOf(add) + 1))).toBe(true);
    }
    const healed = await settle(env, idle, cur, 4);
    expect(env.text()).toBe(before);
    expect(paragraph(healed)).toBe(before);
    // What the user typed is kept on this device.
    const kept = await env.journal.candidates("projection");
    expect(kept.some((c) => c.sourceText.includes(`${before}kami`))).toBe(true);
  });

  it("a drifted node the user keeps typing in is not overwritten while the Text changes", async () => {
    const { env, md, idle } = await drifted();
    let cur = await env.pass(md);
    env.clock.now += 3000;
    await env.port.tick(env.clock.now);
    await idle();
    for (let i = 1; i <= 5; i++) {
      cur = cur.replace(/^(A paragraph.*)$/m, `$1${i}`);
      const out = await env.pass(cur);
      // Each pass leaves the user's line as typed.
      expect(paragraph(out)).toBe(paragraph(cur));
      cur = out;
    }
  });

  // The owner's console on 0.4.0-beta.7: "operation … is already abandoned",
  // unhandled. One refused operation was reported failed twice: by the
  // timer's flush, and again when a pass had sent it once more (it waited
  // in the coalescer) and the next edit committed it first. The second
  // bookkeeping found it abandoned by the first. It is a no-op now.
  it("a refused operation reported failed twice is abandoned once, the second report does nothing", async () => {
    const { env, md, idle, late } = await drifted();
    const cur = await env.pass(md);
    let release: () => void = () => undefined;
    late.gate = new Promise<void>((r) => {
      release = r;
    });
    env.clock.now += 3000;
    await env.port.tick(env.clock.now);
    // Passes run before the bookkeeping of that flush: the first sends the
    // operation again (it waits in the coalescer), the next replaces it.
    const again = await env.pass(cur);
    env.clock.now += 50;
    await env.pass(again.replace(/^(A paragraph.*)$/m, "$1!"));
    release();
    await expect(idle()).resolves.toBeUndefined();
  });
});
