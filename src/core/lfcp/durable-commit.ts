// A section commit that is durable stays in the model (LFCP-03-033).
//
// The SDK's commit (sdk-ts 0.2.0, SyncClient#commit) adopts a staged batch
// in the profile state, stores its units, checkpoint and receipt in one
// transaction, calls `committed`, and then reports the batch and sends what
// waits. Anything that throws after the store reaches the same catch as a
// failed store and calls `revert`: the send on a connection that dropped
// during the queue read (ConnectionNotReady), or a status listener. The
// units stay stored and queued and go out with the next connection, while
// this device's model, and the note projected from it, lose the edit:
// the collaborator sees it, this device shows CURRENT without it, and every
// later change that builds on it waits here for good (the native acceptance
// run's C10, intermittently).
//
// StagedOperation's contract is that revert undoes apply when the commit
// did not happen. `keepDurable` holds the SDK to it: once `committed` has
// been called (the batch is durable), revert does nothing. The caller then
// gets the commit's error, or (LfcpRuntime.commitSection) the receipt.

import type { CommitBinding, StagedOperation } from "@openlfcp/client";

/** `binding` whose staged batches are never reverted once committed. */
export function keepDurable<T>(binding: CommitBinding<T>): CommitBinding<T> {
  const section = binding.section;
  return {
    codec: binding.codec,
    ...(section === undefined ? {} : { section: () => section.call(binding) }),
    stage: (intents) => {
      const staged = binding.stage(intents);
      return staged === null ? null : durable(staged);
    },
  };
}

function durable<T>(staged: StagedOperation<T>): StagedOperation<T> {
  let committed = false;
  return {
    values: staged.values,
    affectedNodeIds: staged.affectedNodeIds,
    modelRevision: staged.modelRevision,
    apply: () => staged.apply(),
    revert: () => {
      if (!committed) staged.revert();
    },
    writes: (units) => staged.writes(units),
    committed: (unitIds) => {
      // Durable from here on, even if what `committed` runs throws.
      committed = true;
      staged.committed(unitIds);
    },
  };
}
