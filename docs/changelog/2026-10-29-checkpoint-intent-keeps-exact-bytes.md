# Checkpoint intent keeps identical bytes through a non-acting refusal

The checkpoint helper wrote its durable intent with JSON's default spaces but returned a compact serialization to the shell. Its existing retirement branch compares the file with the returned bytes exactly. Consequently, even a qualifying non-acting refusal could not retire the intent that this invocation had just written.

Serialize the intent once and use that same serialization for the exclusive, fsynced file and the returned value. Keep the existing exact-byte comparison, exclusive creation, directory fsync, and all unknown-outcome and repeated-entry refusals. This change does not retire an existing production intent or retry a failed operation.

The retained regression executes the maintained writer and retirement blocks together, checks successful retirement of its own unchanged intent, and verifies that modified bytes remain refused and retained. The existing repeated-entry behavior remains pinned. The observed containing release's earlier checkpoint outcome still requires its own journal evidence; this source defect alone does not establish that incident's cause.
