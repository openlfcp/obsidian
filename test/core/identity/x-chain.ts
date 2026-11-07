// Resource X of LFCP-IDENTITY-TEST-VECTORS-01 (spec mvp-0.4-baseline.1):
// a real chain with devices of two people, a revocation, a cascade and a
// service device, validated by the SDK, at any of its heads. Test-only.

import { readFileSync } from "node:fs";
import { fromHex } from "@openlfcp/core";
import { type ControlState, validateControlChain } from "@openlfcp/wire";

interface Fixture {
  readonly principals: Readonly<Record<string, string>>;
  readonly records: readonly { readonly case: string; readonly cose_sign1: string }[];
  readonly rootOf: Readonly<
    Record<
      string,
      {
        readonly records: number;
        readonly expected: Readonly<
          Record<
            string,
            { readonly rootOf: string; readonly bound: boolean; readonly active: boolean }
          >
        >;
      }
    >
  >;
  readonly assignees: {
    readonly records: number;
    readonly set: readonly string[];
    readonly expected: {
      readonly display_humans: readonly string[];
      readonly merged: Readonly<Record<string, readonly string[]>>;
    };
  };
}

export const X: Fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/identity/resource-x-chain.json", import.meta.url), "utf8"),
) as Fixture;

/** The fixture Principal `label` (OWNER, BOB, DEV_B, ...) as hex. */
export const P = (label: string): string => {
  const hex = X.principals[label];
  if (hex === undefined) throw new Error(`no fixture Principal ${label}`);
  return hex;
};

/** The validated Control state of X after its first `records` records (all by default). */
export function stateOfX(records = X.records.length): ControlState {
  const chain = validateControlChain(X.records.slice(0, records).map((r) => fromHex(r.cose_sign1)));
  if (chain.kind !== "linear") throw new Error(`fixture chain is ${chain.kind}`);
  return chain.state;
}
