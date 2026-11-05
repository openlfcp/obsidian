// Installations of the plugin (real runtime, storage and DeviceService,
// with the SDK's own identity flows) around one in-memory coordinator
// with identity-01 (identity-coordinator.ts). Test only (LFCP-04-413).

import { type IdentityFlowOptions, loadControlChain } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { Collaboration } from "../../src/core/collab/service";
import { identityDocument } from "../../src/core/identity/document";
import { type IdentityFlows, SDK_IDENTITY_FLOWS } from "../../src/core/identity/flows";
import { DeviceService } from "../../src/core/identity/service";
import { LfcpRuntime } from "../../src/core/lfcp/runtime";
import { MemoryCoordinator } from "./identity-coordinator";
import { Device, FakeLocal, sleep } from "./lfcp-env";

export const WORLD_URL = "wss://identity.example";

export interface Installation {
  readonly runtime: LfcpRuntime;
  readonly collab: Collaboration;
  readonly service: DeviceService;
  /** A shared section of this installation, hosted on the coordinator. */
  section(name: string): Promise<ResourceId>;
}

export class DeviceWorld {
  readonly server = new MemoryCoordinator();
  readonly #running: LfcpRuntime[] = [];

  async installation(flows: Partial<IdentityFlows> = {}): Promise<Installation> {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    this.#running.push(runtime);
    const collab = new Collaboration(runtime, { sleep, connectTimeoutMs: 20, sections: true });
    const service = new DeviceService({
      runtime: () => runtime,
      context: () => runtime.collaborationContext(),
      collab: () => collab,
      defaultServer: () => WORLD_URL,
      platform: "desktop",
      sections: true,
      sleep,
      flows: { ...SDK_IDENTITY_FLOWS, connectionNetwork: () => this.server.network(), ...flows },
    });
    const server = this.server;
    return {
      runtime,
      collab,
      service,
      async section(name) {
        const R = await runtime.createSectionResource({
          name,
          endpoints: [WORLD_URL],
          coordinatorUrl: WORLD_URL,
        });
        await runtime.setLocalName(R, name);
        const ctx = runtime.collaborationContext();
        const chain = ctx === null ? undefined : await loadControlChain(ctx.storage, R);
        if (ctx === null || chain?.kind !== "linear") throw new Error("no chain");
        const channel = await server.network().connect(ctx.principal.signer, WORLD_URL);
        const answer = await channel.host(chain.records[0]?.signed.bytes as Uint8Array);
        if (answer.kind !== "ack") throw new Error(`not hosted: ${answer.code}`);
        return R;
      },
    };
  }

  /** The SDK's identity flow options of an installation, on this world's coordinator. */
  flowOf(i: Installation): IdentityFlowOptions {
    const ctx = i.runtime.collaborationContext();
    if (ctx === null) throw new Error("not ready");
    return {
      installation: { signer: ctx.principal.signer, agreement: ctx.principal.agreement },
      storage: ctx.storage,
      secrets: ctx.secrets,
      network: this.server.network(),
      now: () => Date.now(),
      document: identityDocument,
    };
  }

  async stop(): Promise<void> {
    for (const r of this.#running.splice(0)) await r.stop();
  }
}

/**
 * A pairs B as a personal device with `preset` (§5.3): the link, B's
 * request, A's approval, B's result. Returns B's request operation.
 */
export async function pair(
  a: Installation,
  b: Installation,
  preset: "full" | "edit" | "read" = "full",
): Promise<string> {
  const session = await a.service.startSession("Desk");
  if (session.kind !== "link" || session.result.kind !== "created")
    throw new Error(`no link: ${JSON.stringify(session)}`);
  const requested = await b.service.request(session.result.link, "Phone");
  if (requested.kind !== "requested") throw new Error(requested.message);
  const reviews = await a.service.requests(session.session);
  const review = Array.isArray(reviews) ? reviews[0] : undefined;
  if (review === undefined) throw new Error(`no request: ${JSON.stringify(reviews)}`);
  const approved = await a.service.approve(review, preset);
  if (approved.kind !== "done") throw new Error(approved.message);
  return requested.operation;
}
