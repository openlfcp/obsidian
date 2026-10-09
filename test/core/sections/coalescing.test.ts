// LFCP-02-025 in the plugin: typing in a section coalesces into one unit
// per burst through the SDK's TypingCoalescer, on the plugin's runtime,
// offline. A pass of Text edits waits and is replaced by the next; a pause
// (tick) commits it and the next pass moves the base by its receipt; a
// structural change commits at once; a restart while one waits replans the
// edit from the note, never loses or doubles it.

import { toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
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
  const port = new SdkSectionPort(
    {
      profile: (res) => r.sectionProfile(res),
      commit: (res, intents, o) => r.commitSection(res, intents, o),
      storage: r.storage as LfcpStorage,
      canWrite: (res) => r.canWriteSection(res),
    },
    { now: () => clock.now, onFlushed: () => undefined },
  );
  let n = 10;
  const engine = new SectionEngine({
    port,
    journal: new KeyValueSectionJournalStore(r.localState),
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
  return { r, R: R as Uint8Array, port, engine, note, pass, units, text, clock, device, local };
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
});
