// The liveness probe (owner check of 0.4.0-beta.6: with the Wi-Fi off and
// no "offline" event, a dead connection showed as synced for 70–80 s): a
// PING after the idle time, any message as its answer, and the connection
// taken for dead when the PING stays unanswered.

import type { WebSocketLike } from "@openlfcp/client";
import { decodeMessage } from "@openlfcp/wire";
import { describe, expect, it } from "vitest";
import { LivenessProbe } from "../../../src/core/lfcp/liveness";

/** A socket that records what is sent; `deliver` is a message from the server. */
function fakeSocket() {
  const sent: Uint8Array[] = [];
  const socket: WebSocketLike = {
    binaryType: "blob",
    protocol: "lfcp-1",
    send: (d) => sent.push(d),
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { socket, sent, deliver: () => socket.onmessage?.({ data: new Uint8Array([0]) }) };
}

function setup() {
  let now = 1000;
  const f = fakeSocket();
  const probe = new LivenessProbe(
    () => () => f.socket,
    () => now,
    { idleMs: 15_000, replyMs: 5_000 },
  );
  const sdk = probe.factory("wss://example.invalid/v1/ws", ["lfcp-1"]);
  const received: unknown[] = [];
  sdk.onmessage = (ev) => received.push(ev.data);
  return {
    probe,
    sdk,
    f,
    received,
    at: (ms: number) => {
      now = 1000 + ms;
      return now;
    },
  };
}

describe("the liveness probe (§38)", () => {
  it("a PING after 15 s without a message; an answer keeps the connection", () => {
    const { probe, f, at } = setup();
    expect(probe.tick(at(14_000), true)).toBe(true);
    expect(f.sent).toHaveLength(0);
    expect(probe.tick(at(15_000), true)).toBe(true);
    expect(f.sent).toHaveLength(1);
    expect(decodeMessage(f.sent[0] as Uint8Array).type).toBe("PING");
    at(16_000);
    f.deliver(); // PONG, or any message
    expect(probe.tick(at(25_000), true)).toBe(true);
    expect(f.sent).toHaveLength(1);
  });

  it("the SDK still receives every message, the bytes untouched", () => {
    const { sdk, f, received } = setup();
    f.deliver();
    expect(received).toEqual([new Uint8Array([0])]);
    sdk.binaryType = "arraybuffer";
    expect(f.socket.binaryType).toBe("arraybuffer");
  });

  it("an unanswered PING: dead 5 s later, at 20 s of silence, not 90", () => {
    const { probe, at } = setup();
    probe.tick(at(15_000), true);
    expect(probe.tick(at(19_000), true)).toBe(true);
    expect(probe.tick(at(20_000), true)).toBe(false);
  });

  it("nothing is probed before READY, and a new connection starts afresh", () => {
    const { probe, f, at } = setup();
    expect(probe.tick(at(60_000), false)).toBe(true);
    expect(f.sent).toHaveLength(0);
    probe.factory("wss://example.invalid/v1/ws", ["lfcp-1"]);
    expect(probe.tick(at(70_000), true)).toBe(true);
    expect(f.sent).toHaveLength(0);
  });
});
