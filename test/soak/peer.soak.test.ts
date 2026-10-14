// @vitest-environment happy-dom
// A soak peer's process: connects to the controller (soak.mjs) at
// SOAK_CONTROL and runs its requests, one JSON line each, until "quit".
// Runs only under the controller (LFCP_SOAK_PEER set).

import { createConnection } from "node:net";
import { describe, it } from "vitest";
import { SoakPeer } from "./peer";

const NAME = process.env.LFCP_SOAK_PEER;

describe.skipIf(NAME === undefined)("soak peer", () => {
  it("serves the controller", { timeout: 24 * 3600_000 }, async () => {
    const [host, port] = (process.env.SOAK_CONTROL as string).split(":");
    const socket = createConnection({ host, port: Number(port) });
    await new Promise((ok) => socket.once("connect", ok));
    let peer: SoakPeer | null = null;
    const send = (o: unknown) => socket.write(`${JSON.stringify(o)}\n`);
    const run = async (op: string, a: Record<string, unknown>): Promise<unknown> => {
      if (op === "open") {
        peer = await SoakPeer.open(
          NAME as string,
          a.me as string,
          a.server as string,
          a.seed as number,
        );
        return { pid: process.pid };
      }
      const p = peer as SoakPeer | null;
      if (p === null) throw new Error("not open");
      switch (op) {
        case "share":
          return p.share(a.tasks as number, a.owners as string[]);
        case "invite":
          return p.invite(a.resource as string);
        case "join":
          return p.join(a.link as string, a.name as string);
        case "insert":
          return p.insert(a.resource as string);
        case "legacyCreate":
          return p.legacyCreate();
        case "legacyJoin":
          return p.legacyJoin(a.link as string);
        case "diag":
          return p.diag(a.resource as string);
        case "openEditor":
          p.openEditor();
          return null;
        case "edit":
          return p.edit();
        case "offline":
          p.offline(a.value as boolean);
          return null;
        case "reconnect":
          return p.reconnect(a.since as number, a.ms as number | undefined);
        case "outbound":
          return p.outbound();
        case "lastInbound":
          return p.lastInbound;
        case "model":
          return p.model();
        case "check":
          return {
            model: p.model(),
            noteVsModel: p.noteVsModel(),
            legacy: await p.legacyState(),
            sections: await p.sectionStates(),
          };
        case "sample":
          return p.sample();
        case "notices":
          return p.notices();
        case "principal": {
          const s = p.runtime.status;
          return s.kind === "ready" ? Buffer.from(s.principalId).toString("hex") : null;
        }
        case "revoke": {
          const { fromBase64url, fromHex } = await import("@openlfcp/core");
          const r = await p.runtime.revokeSectionAccess(
            fromBase64url(a.resource as string) as never,
            fromHex(a.principal as string) as never,
          );
          return { kind: r.kind };
        }
        case "note":
          return p.text(a.path as string);
        default:
          throw new Error(`unknown op ${op}`);
      }
    };
    let buffer = "";
    let quit: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      quit = r;
    });
    // One request at a time, in order: a person does one thing at a time.
    let chain = Promise.resolve();
    socket.on("data", (d) => {
      buffer += String(d);
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const req = JSON.parse(line) as { id: number; op: string; args?: Record<string, unknown> };
        if (req.op === "quit") {
          quit();
          continue;
        }
        chain = chain.then(async () => {
          try {
            send({ id: req.id, ok: true, result: await run(req.op, req.args ?? {}) });
          } catch (e) {
            send({ id: req.id, ok: false, error: e instanceof Error ? e.stack : String(e) });
          }
        });
      }
    });
    socket.on("close", () => quit());
    send({ hello: NAME, pid: process.pid });
    await done;
    await chain;
    await (peer as SoakPeer | null)?.vault.close().catch(() => undefined);
    socket.end();
  });
});
