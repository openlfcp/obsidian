// Review conflicts beyond placement (coverage gap 7), live: two members, B
// and C, make concurrent changes offline (A owns the section and stays
// online); back online, the conflict is in both models; one, the other, or
// both resolve it through Review conflicts (applyRecovery, as the host
// does), in each order. Afterwards both notes show the model, nothing is
// left to review, nothing waits to be sent, and a further pass changes
// nothing. Reference server at LFCP_SERVER_BIN; skipped without one.

import type { WebSocketFactory } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import type { RecoveryChoice, RecoveryItem } from "../../../src/core/sections/recovery";
import { type Peer, peer, waitFor } from "../../native/peer/main";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
/**
 * One server per test: the reference server lets one IP host 10 Resources
 * a day by default (hosts_per_ip_per_day), and every test hosts one.
 */
let server: LiveServer | undefined;
/** One member's network, switchable (as in live-stale-epoch.test.ts). */
function networkSwitch() {
  const open = new Set<WebSocket>();
  let offline = false;
  const factory: WebSocketFactory = (url, protocols) => {
    const ws = new WebSocket(offline ? "ws://127.0.0.1:9/v1/ws" : url, [...protocols]);
    open.add(ws);
    ws.addEventListener("close", () => open.delete(ws));
    return ws as unknown as ReturnType<WebSocketFactory>;
  };
  return {
    factory,
    off: () => {
      offline = true;
      for (const ws of open) ws.close();
    },
    on: () => {
      offline = false;
    },
  };
}

const stopping: Peer[] = [];
afterEach(async () => {
  for (const p of stopping.splice(0)) await p.stop();
  await server?.stop();
  server = undefined;
});

interface Member {
  readonly p: Peer;
  readonly path: string;
  readonly net: ReturnType<typeof networkSwitch>;
}

/** A owns "Plan" [Alpha, Beta, Gamma]; B and C are members, each with the section in a note. */
async function setup() {
  server = await startLiveServer();
  const url = server.url;
  const a = await peer(url);
  stopping.push(a);
  a.files.set("A.md", ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
  const { resource: R } = await a.share("A.md", "## Plan");
  const member = async (name: string): Promise<Member & { sectionId: string }> => {
    const net = networkSwitch();
    const p = await peer(url, undefined, { webSocket: net.factory });
    stopping.push(p);
    const path = `${name}.md`;
    p.files.set(path, [`# ${name}`, "", "Insert below.", ""].join("\n"));
    const link = (await a.collab.invite(R, "read-write")).link.reveal();
    const { sectionId } = await p.joinAndInsert(link, path, 3);
    return { p, path, net, sectionId };
  };
  const b = await member("B");
  const c = await member("C");
  await waitFor(async () => (taskLines(note(c)).length === 3 ? true : undefined), 20_000);
  return { a, b, c, R, sectionId: b.sectionId, r64: b.p.b64(R) };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const note = (m: Member) => m.p.files.get(m.path) as string;
const taskLines = (md: string) => md.split("\n").filter((l) => /^\s*- \[.\] /.test(l));
/** The member's note edited by `f`, then one pass (as the editor's pass after typing). */
const by = (f: (md: string) => string) => async (m: Member) => {
  m.p.files.set(m.path, f(note(m)));
  await m.p.pass(m.path);
};

const items = (s: Setup, m: Member): RecoveryItem[] => m.p.review(s.R as ResourceId, s.sectionId);

/**
 * The Task `title` deleted with its ref line, as the editor reports a
 * deletion (PassContext.deletedIds): one pass.
 */
const deleteTask = async (m: Member, title: string) => {
  const md = note(m);
  const found = new RegExp(
    `- \\[ \\] ${title}\\n\\s*<!-- lfcp-ref: [^#]*#task:([^ ]+) -->\\n`,
  ).exec(md);
  if (found === null) throw new Error(`no Task ${title}`);
  m.p.files.set(m.path, md.replace(found[0], ""));
  await m.p.pass(m.path, null, [found[1] as string]);
};

/** B and C offline, each makes its change, both back: the conflict is in both models. */
async function concurrently(
  s: Setup,
  onB: (m: Member) => Promise<void>,
  onC: (m: Member) => Promise<void>,
  kind: RecoveryItem["kind"],
) {
  for (const m of [s.b, s.c]) m.net.off();
  for (const m of [s.b, s.c])
    await waitFor(async () => (m.p.runtime.phase(s.R as ResourceId) !== "LIVE" ? true : undefined));
  await onB(s.b);
  await onC(s.c);
  for (const m of [s.b, s.c]) m.net.on();
  for (const m of [s.b, s.c])
    await waitFor(
      async () => (items(s, m).some((i) => i.kind === kind) ? true : undefined),
      45_000,
    );
  return items(s, s.b).find((i) => i.kind === kind) as RecoveryItem;
}

/** Review conflicts on member `m`: the item (as `m` lists it) and a choice. */
const resolve = (s: Setup, m: Member, key: string, choice: RecoveryChoice) =>
  m.p.resolve(s.R as ResourceId, s.sectionId, key, choice);

/** Nothing queued to send from `m`. */
const sent = async (s: Setup, m: Member) =>
  ((await m.p.runtime.storage?.outbound.list(s.R as ResourceId)) ?? []).length === 0;

/**
 * Settled: on both, nothing to review, no model problem, nothing to send;
 * the notes show the same Tasks; one more pass changes neither note.
 */
async function settled(s: Setup) {
  const both = [s.b, s.c];
  await waitFor(async () => {
    for (const m of both) {
      await m.p.pass(m.path);
      if (items(s, m).length > 0 || !(await sent(s, m))) return undefined;
    }
    return taskLines(note(s.b)).join("\n") === taskLines(note(s.c)).join("\n") ? true : undefined;
  }, 45_000).catch(() => undefined);
  for (const m of both) {
    expect(items(s, m)).toEqual([]);
    const problems = m.p.port.snapshot(s.r64, s.sectionId)?.problems ?? [];
    expect(problems).toEqual([]);
    expect(await sent(s, m)).toBe(true);
    const before = note(m);
    const again = await m.p.pass(m.path);
    expect(again.pass.changes).toEqual([]);
    expect(note(m)).toBe(before);
  }
  expect(taskLines(note(s.b))).toEqual(taskLines(note(s.c)));
}

/** The Task line of `title` in a note, without its ref. */
const line = (md: string, title: RegExp) => taskLines(md).find((l) => title.test(l));

describe.skipIf(skip !== null)("Review conflicts beyond placement, resolved by two members", () => {
  describe("a Task's title changed by both", () => {
    const conflict = (s: Setup) =>
      concurrently(
        s,
        by((md) => md.replace("- [ ] Beta", "- [ ] Beta by B")),
        by((md) => md.replace("- [ ] Beta", "- [ ] Beta by C")),
        "field",
      );

    it("B chooses, then C finds it resolved", async () => {
      const s = await setup();
      const item = await conflict(s);
      expect(item).toMatchObject({ kind: "field", field: "title" });
      expect((await resolve(s, s.b, item.key, { value: "Beta by C" })).applied).toBe(true);
      await waitFor(async () => (items(s, s.c).length === 0 ? true : undefined), 20_000);
      expect((await resolve(s, s.c, item.key, { value: "Beta by B" })).applied).toBe(false);
      await settled(s);
      expect(line(note(s.b), /Beta/)).toBe("- [ ] Beta by C");
    }, 180_000);

    it("C chooses, then B finds it resolved", async () => {
      const s = await setup();
      const item = await conflict(s);
      expect((await resolve(s, s.c, item.key, { value: "Beta by B" })).applied).toBe(true);
      await waitFor(async () => (items(s, s.b).length === 0 ? true : undefined), 20_000);
      await settled(s);
      expect(line(note(s.c), /Beta/)).toBe("- [ ] Beta by B");
    }, 180_000);

    it("both choose at once, differently: one value, the same in both notes", async () => {
      const s = await setup();
      const item = await conflict(s);
      for (const m of [s.b, s.c]) m.net.off();
      expect((await resolve(s, s.b, item.key, { value: "Beta by B" })).applied).toBe(true);
      expect((await resolve(s, s.c, item.key, { value: "Beta by C" })).applied).toBe(true);
      for (const m of [s.b, s.c]) m.net.on();
      // Both choices reach both: the two values conflict again, the same on both.
      await waitFor(async () => ((await sent(s, s.b)) && (await sent(s, s.c)) ? true : undefined));
      await new Promise((r) => setTimeout(r, 2000));
      const left = [s.b, s.c].map((m) => items(s, m).map((i) => i.key));
      expect(left[0]).toEqual(left[1]);
      const again = items(s, s.b).find((i) => i.kind === "field");
      expect(again).toMatchObject({ key: item.key, values: ["Beta by B", "Beta by C"] });
      expect((await resolve(s, s.b, item.key, { value: "Beta by B" })).applied).toBe(true);
      await settled(s);
      expect(line(note(s.b), /Beta/)).toMatch(/^- \[ \] Beta by [BC]$/);
    }, 180_000);
  });

  describe("a Task done by one, cancelled by the other", () => {
    const conflict = (s: Setup) =>
      concurrently(
        s,
        by((md) => md.replace("- [ ] Beta", "- [x] Beta")),
        by((md) => md.replace("- [ ] Beta", "- [-] Beta")),
        "field",
      );

    it("B chooses done, then C finds it resolved", async () => {
      const s = await setup();
      const item = await conflict(s);
      expect(item).toMatchObject({ kind: "field", field: "status" });
      const done = (item as Extract<RecoveryItem, { kind: "field" }>).values.find((v) =>
        /done/.test(v),
      ) as string;
      expect((await resolve(s, s.b, item.key, { value: done })).applied).toBe(true);
      await settled(s);
      expect(line(note(s.c), /Beta/)).toMatch(/^- \[x\] Beta/);
    }, 180_000);

    it("C chooses cancelled, then B finds it resolved", async () => {
      const s = await setup();
      const item = await conflict(s);
      const cancelled = (item as Extract<RecoveryItem, { kind: "field" }>).values.find((v) =>
        /cancel/.test(v),
      ) as string;
      expect((await resolve(s, s.c, item.key, { value: cancelled })).applied).toBe(true);
      await settled(s);
      expect(line(note(s.b), /Beta/)).toMatch(/^- \[-\] Beta/);
    }, 180_000);
  });

  describe("the section's title changed by both", () => {
    const conflict = (s: Setup) =>
      concurrently(
        s,
        by((md) => md.replace("## Plan", "## Plan by B")),
        by((md) => md.replace("## Plan", "## Plan by C")),
        "title",
      );

    for (const [first, second] of [
      ["b", "c"],
      ["c", "b"],
    ] as const)
      it(`${first.toUpperCase()} chooses, then ${second.toUpperCase()} finds it resolved`, async () => {
        const s = await setup();
        const item = await conflict(s);
        const value = first === "b" ? "Plan by C" : "Plan by B";
        expect((await resolve(s, s[first], item.key, { value })).applied).toBe(true);
        await waitFor(async () => (items(s, s[second]).length === 0 ? true : undefined), 20_000);
        await settled(s);
        for (const m of [s.b, s.c]) expect(note(m)).toContain(`## ${value}\n`);
      }, 180_000);
  });

  describe("a Task deleted by one, changed by the other", () => {
    const conflict = (s: Setup) =>
      concurrently(
        s,
        // B deletes Beta, with its ref line.
        (m: Member) => deleteTask(m, "Beta"),
        by((md) => md.replace("- [ ] Beta", "- [ ] Beta changed by C")),
        "retained",
      );

    for (const [who, keep] of [
      ["b", false],
      ["c", false],
      ["b", true],
      ["c", true],
    ] as const)
      it(`${who.toUpperCase()} chooses ${keep ? "Restore" : "Keep it deleted"}; the other finds it resolved`, async () => {
        const s = await setup();
        const item = await conflict(s);
        const choice: RecoveryChoice = keep ? { restore: true } : { keep: false };
        expect((await resolve(s, s[who], item.key, choice)).applied).toBe(true);
        await settled(s);
        for (const m of [s.b, s.c])
          if (keep) expect(line(note(m), /Beta/)).toBe("- [ ] Beta changed by C");
          else expect(line(note(m), /Beta/)).toBeUndefined();
      }, 180_000);
  });
});
