// A stand-in for a control Resource C (SERVICE-CONTROL-PROFILE-01) as one
// device's ServiceControlPort sees it: the state readers see, who created
// each entry, and the writes of root/personal applied at once. The bridge's
// side (`pairing`, `events`, `service`) is set by the test, with the writer
// class admission would have judged. Test only (E-023: the host's C is not
// merged yet).

import {
  OperationIdReusedError,
  type ServiceControlCommitOutcome,
  type ServiceControlCreator,
  type ServiceControlPort,
  type ServiceControlWriterClass,
} from "@openlfcp/client";
import type { PrincipalId, ResourceId } from "@openlfcp/core";

type Container = "approvals" | "pairing" | "requests" | "cancels";

export interface FakeControlState {
  approvals: Record<string, Record<string, unknown> & { revoked: boolean }>;
  requests: Record<string, { op: string; binding?: string; args: Record<string, unknown> }>;
  pairing: Record<string, { descriptor: string; principal: string; fp: string }>;
  cancels: Record<string, { reason: string }>;
  events: Record<string, { state: string }>;
  bindings: Record<string, unknown>;
  service?: Record<string, unknown>;
  status?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
}

export class FakeControl implements ServiceControlPort {
  readonly data: FakeControlState = {
    approvals: {},
    requests: {},
    pairing: {},
    cancels: {},
    events: {},
    bindings: {},
  };
  readonly creators = new Map<string, ServiceControlCreator[]>();
  /** Every committed batch, in order (with its operation). */
  readonly commits: { operation: string; intents: readonly Record<string, unknown>[] }[] = [];
  /**
   * What commit answers: "acknowledged" by default; "queued" keeps the receipt here
   * and leaves C unchanged (the ACK not received); "offline" fails before anything.
   */
  answer: "acknowledged" | "queued" | "offline" = "acknowledged";
  synchronised = true;

  constructor(
    readonly resource: ResourceId,
    /** The device writing through this port, and its class (root/personal). */
    readonly me: PrincipalId,
    readonly myClass: ServiceControlWriterClass = "root",
  ) {}

  state() {
    return this.synchronised ? (this.data as never) : undefined;
  }

  creatorsOf(container: Container, key: string): readonly ServiceControlCreator[] {
    return this.creators.get(`${container}/${key}`) ?? [];
  }

  requestHistory() {
    return Object.entries(this.data.requests).map(([rid, request]) => ({
      rid,
      request,
      present: true,
      creators: this.creatorsOf("requests", rid),
    }));
  }

  async acknowledged(container: Container, key: string): Promise<boolean> {
    return this.creatorsOf(container, key).length > 0;
  }

  /** Sets an entry as another writer (the bridge as `service`, or a forger). */
  put(
    container: Container | "events",
    key: string,
    value: never,
    by: { signer: PrincipalId; writerClass: ServiceControlWriterClass },
  ): void {
    (this.data[container] as Record<string, unknown>)[key] = value;
    if (container !== "events") this.creators.set(`${container}/${key}`, [by]);
  }

  /**
   * The local receipts, by operation, as SyncClient keeps them (§3.3): the same
   * operation with other intents throws OperationIdReusedError; with the same
   * ones it writes nothing new. A receipt is kept once the change is durable
   * here ("queued" too), before the server acknowledges it.
   */
  readonly receipts = new Map<string, string>();
  readonly #applied = new Set<string>();

  async commit(
    intents: readonly unknown[],
    operation: string,
  ): Promise<ServiceControlCommitOutcome> {
    const list = intents as readonly Record<string, unknown>[];
    const hash = JSON.stringify(list);
    const known = this.receipts.get(operation);
    if (known !== undefined && known !== hash) throw new OperationIdReusedError(operation);
    if (this.answer === "offline") throw new Error("C is not reachable");
    if (known === undefined) this.receipts.set(operation, hash);
    if (this.answer === "queued") return { kind: "queued" };
    if (this.#applied.has(operation)) return { kind: "acknowledged" };
    this.#applied.add(operation);
    this.commits.push({ operation, intents: list });
    const by = { signer: this.me, writerClass: this.myClass };
    for (const i of list) {
      if (i.intent === "request.create") {
        const rid = String(i.rid);
        if (this.data.requests[rid] !== undefined) return { kind: "rejected", code: "ONCE" };
        this.put("requests", rid, i.request as never, by);
      } else if (i.intent === "cancel.create") {
        this.put("cancels", String(i.rid), i.cancel as never, by);
      } else if (i.intent === "approval.revoke") {
        const a = this.data.approvals[String(i.principal)];
        if (a === undefined || a.revoked) return { kind: "rejected", code: "ONCE" };
        a.revoked = true;
        a.revokedAt = i.at;
      } else if (i.intent === "approval.create") {
        const a = i.approval as { principal: string };
        this.put("approvals", a.principal, { ...a, revoked: false } as never, by);
      }
    }
    return { kind: "acknowledged" };
  }
}
