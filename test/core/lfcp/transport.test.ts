// LFCP-03-005 (F-C06): what one session's transport did last, from the
// SDK's connection transitions only: connecting, ready, lost and failed as
// it reported them, a retry reading as the last outcome until READY, and
// the network's or the liveness probe's word as the cause.

import { describe, expect, it } from "vitest";
import { type TransportFact, TransportTracker } from "../../../src/core/lfcp/transport";

const t = (state: TransportFact["state"], cause: TransportFact["cause"] = null): TransportFact => ({
  state,
  cause,
});

describe("the transport's transitions (F-C06)", () => {
  it("connecting, ready, lost and failed only from what the SDK reported", () => {
    const tr = new TransportTracker();
    expect(tr.fact).toEqual(t("none"));
    tr.connection("CONNECTING");
    expect(tr.fact).toEqual(t("connecting"));
    tr.connection("NEGOTIATING");
    tr.connection("AUTHENTICATING");
    expect(tr.fact).toEqual(t("connecting"));
    // Before READY: the attempt failed.
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("failed"));
    // A retry reads as the failure until it ends: no flip on every backoff.
    tr.connection("CONNECTING");
    expect(tr.fact).toEqual(t("failed"));
    tr.connection("READY");
    expect(tr.fact).toEqual(t("ready"));
    // After READY: lost; the SDK's second DISCONNECTED (with its reason) changes nothing.
    tr.connection("DISCONNECTED");
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("lost"));
    tr.connection("CONNECTING");
    expect(tr.fact).toEqual(t("lost"));
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("failed"));
  });

  it("the network gone, or a connection that stopped answering, is the cause until READY", () => {
    const tr = new TransportTracker();
    tr.connection("CONNECTING");
    tr.connection("READY");
    tr.unresponsive();
    // Still READY: the probe's verdict is not a state until the session drops it.
    expect(tr.fact).toEqual(t("ready"));
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("lost", "not-responding"));
    tr.connection("CONNECTING");
    expect(tr.fact).toEqual(t("lost", "not-responding"));
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("failed", "not-responding"));
    tr.networkLost();
    expect(tr.fact).toEqual(t("failed", "network-offline"));
    tr.networkBack();
    expect(tr.fact).toEqual(t("failed", "not-responding"));
    tr.connection("CONNECTING");
    tr.connection("READY");
    tr.connection("DISCONNECTED");
    expect(tr.fact).toEqual(t("lost"));
  });
});
