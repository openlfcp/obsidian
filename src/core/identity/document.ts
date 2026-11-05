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
import type { PrincipalId, ResourceId } from "@openlfcp/core";
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
    receive: (plaintext, author) => {
      const r = replica.receive(plaintext, writer(author));
      return r.admitted.length + r.duplicates.length > 0;
    },
    initialized: () => replica.validate().usable && replica.heads().length > 0,
    roster: () => map(replica.validate().roster),
    devices: () => map(replica.validate().devices),
    requests: () => map(replica.validate().requests),
    origins: (table, key) => replica.origins(table, key),
  };
};
