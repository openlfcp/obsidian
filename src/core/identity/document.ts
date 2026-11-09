// The Identity Resource's document (IDENTITY-PROFILE-01 §§2–4) for the
// device flows (LFCP-04-413): @openlfcp/client's IdentityDocumentPort over
// @openlfcp/shared-objects' IdentityReplica, which owns admission and state
// validation. The flows produce intents and carry the plaintext; nothing in
// the document confers authority (§4 rule 5).

import type {
  IdentityAuthor,
  IdentityDocumentFactory,
  IdentityDocumentPort,
  IdentityIntent,
} from "@openlfcp/client";
import { LfcpError, type PrincipalId, type ResourceId } from "@openlfcp/core";
import { IdentityReplica, identityCodec } from "@openlfcp/shared-objects/identity";

/** A fresh document of Identity Resource `resource` owned by `root`, for one flow. */
export const identityDocument: IdentityDocumentFactory = (
  resource: ResourceId,
  root: PrincipalId,
): IdentityDocumentPort => {
  const replica = IdentityReplica.empty({ resource, root });
  const writer = (a: IdentityAuthor) => ({
    signer: a.signer,
    actorSeq: a.actorSeq,
    writerClass: a.writerClass,
  });
  const map = <T>(o: Readonly<Record<string, T>>) => new Map(Object.entries(o));
  return {
    write: (author, intents: readonly IdentityIntent[]) =>
      identityCodec.encode(replica.write(writer(author), intents)),
    // The port's contract: false when the unit is refused or held. A plaintext the profile
    // cannot read (bad framing, another actor's change) is refused, not thrown at the flow.
    receive: (plaintext, author) => {
      try {
        const r = replica.receive(plaintext, writer(author));
        return r.admitted.length + r.duplicates.length > 0;
      } catch (e) {
        if (e instanceof LfcpError) return false;
        throw e;
      }
    },
    initialized: () => replica.validate().usable && replica.heads().length > 0,
    roster: () => map(replica.validate().roster),
    devices: () => map(replica.validate().devices),
    requests: () => map(replica.validate().requests),
    origins: (table, key) => replica.origins(table, key),
    // §7.1 step 4, §8.2 (sdk-ts 0.5.0): a retired entry's flag field by field. Every
    // concurrent value of `revoked` is seen, and marking a device removed writes the flag
    // alone, so a concurrent rename of it stays a conflict instead of being resolved.
    retirement: {
      revokedValues: (key) => replica.fieldValues("devices", key, "revoked"),
      write: (author, intents, retire) =>
        identityCodec.encode(replica.write(writer(author), intents, { retire })),
    },
    // §7.1 step 3, AI5 (sdk-ts 0.5.2, design 419 (a)): this device's own missing_keys
    // hint, written field by field: never its label, so a concurrent rename stays a conflict.
    keyHints: {
      write: (author, hints) => identityCodec.encode(replica.write(writer(author), [], { hints })),
    },
  };
};
