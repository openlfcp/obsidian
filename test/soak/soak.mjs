#!/usr/bin/env node
// The soak of a Shared Tasks candidate, headless: three peers (each the real
// plugin in its own process, test/soak/peer.ts) on one shared section and
// two 0.1 shared tasks, on a local reference server, for hours.
//
//   LFCP_SERVER_BIN=<lfcp-server> node test/soak/soak.mjs --minutes 240 --out <dir>
//
// Peers edit as people do (a save every few seconds: titles, completion,
// new and deleted Tasks, cut and paste, nesting), each its own Tasks; every
// 15–30 min one goes offline for a few minutes; the server restarts twice;
// once a member is removed and invited again as a new identity. Every 10
// min the edits pause until everything is sent, and a checkpoint records
// convergence, queues, memory, storage and pass times (samples.jsonl).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const MINUTES = Number(arg("minutes", "240"));
const TASKS = Number(arg("tasks", "150"));
const SEED = Number(arg("seed", "1"));
const CHECK_MIN = Number(arg("check", "10"));
const OUT = resolve(arg("out", `soak-${Date.now()}`));
// One event kind at a time, to isolate a finding: --no offline,restart,removal.
const OFF = new Set(String(arg("no", "")).split(",").filter(Boolean));
// The window's "online" when a peer's network comes back, as the OS gives it (the plugin connects at once).
const ONLINE_EVENT = process.argv.includes("--online-event");
const BIN = process.env.LFCP_SERVER_BIN;
const ROOT = resolve(import.meta.dirname, "../..");
if (BIN === undefined) throw new Error("LFCP_SERVER_BIN is required");
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const min = () => ((Date.now() - t0) / 60_000).toFixed(1);
const log = (line) => {
  const l = `[${new Date().toISOString()} +${min()}m] ${line}`;
  console.log(l);
  appendFileSync(join(OUT, "soak.log"), `${l}\n`);
};
const event = (o) =>
  appendFileSync(
    join(OUT, "events.jsonl"),
    `${JSON.stringify({ t: Date.now(), m: +min(), ...o })}\n`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = SEED;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });

// Every child goes when the controller does, however it ends.
const children = new Set();
const track = (child) => {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
};
process.on("exit", () => {
  for (const c of children)
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      c.kill("SIGKILL");
    }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});

// ---- the server ----

const serverPort = await freePort();
const serverDir = join(OUT, "server");
mkdirSync(serverDir, { recursive: true });
const URL_ = `ws://127.0.0.1:${serverPort}/v1/ws`;
writeFileSync(
  join(serverDir, "server.toml"),
  [
    `bind = "127.0.0.1:${serverPort}"`,
    `state_dir = ${JSON.stringify(join(serverDir, "state"))}`,
    `public_urls = [${JSON.stringify(URL_)}]`,
    "heartbeat_ms = 5000",
    "",
  ].join("\n"),
);
let server = null;
async function startServer() {
  const child = track(
    spawn(BIN, ["--config", join(serverDir, "server.toml")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "info" },
    }),
  );
  const out = join(serverDir, "server.log");
  child.stdout.on("data", (d) => appendFileSync(out, d));
  child.stderr.on("data", (d) => appendFileSync(out, d));
  for (const deadline = Date.now() + 20_000; ; ) {
    if (child.exitCode !== null) throw new Error("the server exited");
    try {
      if ((await fetch(`http://127.0.0.1:${serverPort}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("the server did not become healthy");
    await sleep(100);
  }
  server = child;
  return Date.now();
}
async function stopServer() {
  const child = server;
  server = null;
  if (child === null || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}
const du = (dir) => {
  let n = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    n += name.isDirectory() ? du(p) : statSync(p).size;
  }
  return n;
};

// ---- the peers ----

const control = createServer();
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const CONTROL = `127.0.0.1:${control.address().port}`;
const waiting = new Map();
control.on("connection", (socket) => {
  let buffer = "";
  socket.on("data", (d) => {
    buffer += String(d);
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (msg.hello !== undefined) waiting.get(msg.hello)?.(socket);
      else socket.emit("reply", msg);
    }
  });
});

class Peer {
  #socket;
  #id = 0;
  #pending = new Map();
  constructor(name, me) {
    this.name = name;
    this.me = me;
    this.paused = false;
    this.offline = false;
    this.edits = 0;
    this.gone = false;
  }
  async start(seed) {
    const connected = new Promise((r) => waiting.set(this.name, r));
    this.proc = track(
      spawn(
        join(ROOT, "node_modules/.bin/vitest"),
        ["run", "--config", "vitest.soak.config.ts", "test/soak/peer.soak.test.ts"],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, LFCP_SOAK_PEER: this.name, SOAK_CONTROL: CONTROL },
          // Its own group: vitest's worker goes with it.
          detached: true,
        },
      ),
    );
    const out = join(OUT, `peer-${this.name}.log`);
    this.proc.stdout.on("data", (d) => appendFileSync(out, d));
    this.proc.stderr.on("data", (d) => appendFileSync(out, d));
    this.#socket = await connected;
    this.#socket.on("reply", (msg) => {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.ok) p?.ok(msg.result);
      else p?.fail(new Error(`${this.name}: ${msg.error}`));
    });
    await this.call("open", { me: this.me, server: URL_, seed }, 120_000);
  }
  call(op, args = {}, ms = 300_000) {
    const id = ++this.#id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        fail(new Error(`${this.name}: ${op} timed out after ${ms} ms`));
      }, ms);
      this.#pending.set(id, {
        ok: (v) => {
          clearTimeout(timer);
          ok(v);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.#socket.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }
  async quit() {
    this.gone = true;
    this.#socket?.write(`${JSON.stringify({ op: "quit" })}\n`);
    await new Promise((r) => (this.proc.exitCode !== null ? r() : this.proc.once("exit", r)));
  }
}

// ---- setup ----

const setupStart = Date.now();
await startServer();
log(`server ${URL_} (${BIN})`);
const A = new Peer("A", "a");
const B = new Peer("B", "b");
let C = new Peer("C", "c");
await Promise.all([A.start(SEED * 10 + 1), B.start(SEED * 10 + 2), C.start(SEED * 10 + 3)]);
log("peers up");
const { resource } = await A.call("share", { tasks: TASKS, owners: ["a", "b", "c"] });
log(`A shared the section (${TASKS} tasks)`);
await A.call("openEditor");
const legacy = await A.call("legacyCreate");
log("A shared two 0.1 tasks");
async function admit(p) {
  const link = await A.call("invite", { resource });
  log(`${p.name} joins: ${(await p.call("join", { link, name: "Soak" })).slice(0, 80)}`);
  try {
    await p.call("insert", { resource }, 660_000);
  } catch (e) {
    const diag = {
      [p.name]: await p.call("diag", { resource }),
      A: await A.call("diag", { resource }),
    };
    log(`INSERT FAILED ${String(e.message).slice(0, 300)}\n${JSON.stringify(diag, null, 1)}`);
    event({ kind: "insert-failed", peer: p.name, error: String(e.message), diag });
    throw e;
  }
  log(`${p.name} inserted the section`);
  await p.call("openEditor");
  const legacyLink = await A.call("invite", { resource: legacy });
  await p.call("legacyJoin", { link: legacyLink });
  log(`${p.name} joined the 0.1 tasks`);
}
await admit(B);
await admit(C);
event({ kind: "setup", ms: Date.now() - setupStart });

// ---- edits ----

let running = true;
const peers = () => [A, B, C].filter((p) => !p.gone);
function editLoop(p) {
  return (async () => {
    while (running && !p.gone) {
      if (p.paused) {
        await sleep(200);
        continue;
      }
      p.busy = true;
      try {
        const what = await p.call("edit");
        p.edits++;
        if (p.edits % 100 === 0) log(`${p.name}: ${p.edits} edits (last: ${what})`);
      } catch (e) {
        if (!p.gone) log(`EDIT ERROR ${e.message.slice(0, 2000)}`);
        event({ kind: "edit-error", peer: p.name, error: String(e.message).slice(0, 4000) });
      } finally {
        p.busy = false;
      }
      await sleep(2000 + rnd() * 4000);
    }
  })();
}
const loops = new Map();
for (const p of [A, B, C]) loops.set(p, editLoop(p));

async function pause(ps) {
  for (const p of ps) p.paused = true;
  while (ps.some((p) => p.busy)) await sleep(50);
}
const resume = (ps) => {
  for (const p of ps) p.paused = false;
};

// ---- checkpoint ----

let checkpoint = 0;
async function check() {
  const ps = peers();
  await pause(ps);
  const start = Date.now();
  // Quiet: nothing waits to be sent, the models are the same, every note shows its model.
  let checks = [];
  let settled = false;
  while (Date.now() - start < 300_000) {
    const out = await Promise.all(ps.map((p) => p.call("outbound")));
    checks = await Promise.all(ps.map((p) => p.call("check")));
    const c0 = checks[0];
    if (
      out.every((n) => n === 0) &&
      checks.every((c) => c.sections.every((s) => s.conditions.length === 0 && s.pending === 0)) &&
      checks.every(
        (c) =>
          c.model !== null &&
          c.model.canon === c0.model?.canon &&
          c.model.revision === c0.model?.revision &&
          c.noteVsModel.length === 0 &&
          c.legacy.canon === c0.legacy.canon &&
          c.legacy.mismatch.length === 0,
      )
    ) {
      settled = true;
      break;
    }
    await sleep(1000);
  }
  const settleMs = Date.now() - start;
  const samples = await Promise.all(ps.map((p) => p.call("sample")));
  const notices = await Promise.all(ps.map((p) => p.call("notices")));
  const canon = checks.map((c) => c.model?.canon);
  const legacyCanon = checks.map((c) => c.legacy.canon);
  const problems = [];
  if (!settled) problems.push(`not settled after ${settleMs} ms`);
  if (canon.some((c) => c !== canon[0])) problems.push("models differ");
  if (legacyCanon.some((c) => c !== legacyCanon[0])) problems.push("legacy models differ");
  ps.forEach((p, i) => {
    for (const d of checks[i].noteVsModel) problems.push(`${p.name} note≠model: ${d}`);
    for (const d of checks[i].legacy.mismatch) problems.push(`${p.name} ${d}`);
    if (checks[i].model?.problems > 0)
      problems.push(`${p.name}: ${checks[i].model.problems} model problems`);
    for (const s of samples[i].sections)
      if (s.conditions.length > 0 || s.pending > 0)
        problems.push(
          `${p.name} section ${s.state}: ${s.conditions.join(",")} pending ${s.pending}`,
        );
  });
  const row = {
    checkpoint: ++checkpoint,
    m: +min(),
    settled,
    settleMs,
    tasks: checks[0].model?.tasks,
    serverBytes: du(join(serverDir, "state")),
    edits: Object.fromEntries(ps.map((p) => [p.name, p.edits])),
    peers: Object.fromEntries(ps.map((p, i) => [p.name, samples[i]])),
    notices: Object.fromEntries(ps.map((p, i) => [p.name, notices[i]])),
    problems,
  };
  appendFileSync(join(OUT, "samples.jsonl"), `${JSON.stringify(row)}\n`);
  log(
    `checkpoint ${row.checkpoint}: ${problems.length === 0 ? "converged" : `PROBLEMS ${problems.length}`} in ${settleMs} ms; tasks ${row.tasks}; ` +
      ps
        .map(
          (p, i) =>
            `${p.name} rss ${samples[i].rssMiB} heap ${samples[i].heapMiB} p95 ${samples[i].passP95?.toFixed(0)}`,
        )
        .join("; "),
  );
  if (problems.length > 0) {
    for (const x of problems.slice(0, 20)) log(`  ${x}`);
    const diag = Object.fromEntries(
      await Promise.all(ps.map(async (p) => [p.name, await p.call("diag", { resource })])),
    );
    row.diag = diag;
    event({ kind: "unsettled", checkpoint: row.checkpoint, problems, diag });
    log(`  diag ${JSON.stringify(diag)}`);
    for (const p of ps)
      writeFileSync(
        join(OUT, `note-${p.name}-cp${row.checkpoint}.md`),
        await p.call("note", { path: "Soak.md" }),
      );
  }
  resume(ps);
}

// ---- reconnects ----

async function reconnect(ps, since, why) {
  const out = await Promise.all(
    ps.map(async (p) => {
      let inbound = null;
      let drained = null;
      while (Date.now() - since < 180_000 && (inbound === null || drained === null)) {
        if (inbound === null) {
          const last = await p.call("lastInbound");
          if (last >= since) inbound = last - since;
        }
        if (inbound !== null && drained === null && (await p.call("outbound")) === 0)
          drained = Date.now() - since;
        await sleep(250);
      }
      return { peer: p.name, inbound, drained };
    }),
  );
  event({ kind: "reconnect", why, out });
  log(
    `reconnect after ${why}: ${out.map((o) => `${o.peer} ${o.inbound} ms (sent ${o.drained} ms)`).join(", ")}`,
  );
}

// ---- the timeline ----

const end = t0 + MINUTES * 60_000;
const at = (fraction) => t0 + fraction * MINUTES * 60_000;
const restarts = OFF.has("restart") ? [] : [at(1 / 3), at(2 / 3)];
let removal = OFF.has("removal") ? null : at(1 / 2);
let nextCheck = Date.now() + CHECK_MIN * 60_000;
let nextOffline = Date.now() + (15 + rnd() * 15) * 60_000 * Math.min(1, MINUTES / 240);
await check();
while (Date.now() < end) {
  const now = Date.now();
  if (now >= nextCheck) {
    await check();
    nextCheck = Date.now() + CHECK_MIN * 60_000;
  } else if (restarts.length > 0 && now >= restarts[0]) {
    restarts.shift();
    log("server restart");
    const down = Date.now();
    await stopServer();
    await sleep(10_000);
    const since = await startServer();
    event({ kind: "server-restart", downMs: since - down });
    await reconnect(peers(), since, "server restart");
  } else if (removal !== null && now >= removal) {
    removal = null;
    log("removing C and inviting a new identity");
    const ps = peers();
    await pause(ps);
    const principal = await C.call("principal");
    const r = await A.call("revoke", { resource, principal });
    log(`revoke: ${JSON.stringify(r)}`);
    resume([A, B]);
    // The removed member keeps editing for a while: refused, kept on its device.
    C.paused = false;
    await sleep(60_000);
    const cSample = await C.call("sample");
    const cNotices = await C.call("notices");
    event({ kind: "removed", sample: cSample, notices: cNotices });
    log(`C after removal: ${JSON.stringify(cSample.sections)} ${cNotices.slice(-3).join(" | ")}`);
    await pause([C]);
    await C.quit();
    const C2 = new Peer("C2", "c");
    await C2.start(SEED * 10 + 4);
    await pause([A, B]);
    try {
      await admit(C2);
      C = C2;
      loops.set(C2, editLoop(C2));
      event({ kind: "re-invited" });
    } catch (e) {
      // Recorded with its diagnostics (admit); the soak goes on with A and B.
      log(`C2 could not be admitted; going on with A and B: ${String(e.message).slice(0, 300)}`);
      await C2.quit();
    }
    resume([A, B]);
  } else if (now >= nextOffline && !OFF.has("offline")) {
    const ps = peers();
    const p = ps[Math.floor(rnd() * ps.length)];
    const ms = (2 + rnd() * 3) * 60_000 * Math.min(1, MINUTES / 240);
    log(`${p.name} offline for ${(ms / 60_000).toFixed(1)} min`);
    await p.call("offline", { value: true });
    await sleep(ms);
    const since = Date.now();
    await p.call("offline", { value: false });
    if (ONLINE_EVENT) await p.call("onlineEvent");
    await reconnect([p], since, `${p.name} offline ${(ms / 60_000).toFixed(1)} min`);
    nextOffline = Date.now() + (15 + rnd() * 15) * 60_000 * Math.min(1, MINUTES / 240);
  } else await sleep(1000);
}
await check();
running = false;
await Promise.all(loops.values());
for (const p of peers()) await p.quit();
await stopServer();
control.close();
log("done");
process.exit(0);
