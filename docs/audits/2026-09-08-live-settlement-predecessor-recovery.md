# Live Settlement Predecessor Recovery

## Production Evidence

At 15:28 UTC, engine adf1a2c3 reported a 526,629 ms completion-to-deal gap;
525,954 ms was in await_post_hand_tasks. Its logs repeatedly reported
post-commit obligations refused (predecessor_pending), plus statement timeouts.
At 15:35 UTC Madness NLH 2/5 (58b2c844-9057-445e-ae0b-7850edcf9078)
had unfinished obligations for hands 8227964 (accepted 15:29:33) and 8228118
(accepted 15:31:02). The global projection outbox had about 2,400 rows.

The live dealer retried only its current hand. The database correctly refused
while an earlier accepted envelope was unfinished. Only the serial global
projection worker advanced that predecessor, coupling live play to unrelated
statistics work across the fleet. The observed statement timeouts are another
remaining source of delay; this change does not claim to eliminate those.

## Repair

processHandPostCommitObligations first tries the requested hand as before.
Only predecessor_pending triggers a scoped read of its table and up to sixteen
older incomplete envelopes, ordered by hand number. The helper completes those
through the existing fn_ca_process_hand_post_commit_obligations RPC, then asks
for the requested hand's receipt again. No direct receipt writes, projection
execution, new debit decisions, or changes to financial functions are added.

Concurrent consumers converge through the existing database lock/receipt.
Any predecessor refusal preserves the current hand's refusal. Read and RPC
errors propagate to the existing causal retry. A batch limit cannot grant
permission to deal: the final requested-hand RPC must still report success.

## Verification And Limits

26 focused tests across the helper, projection worker and settlement barrier
passed; server tsc --noEmit passed. Tests cover scope/order, failure, concurrent
completion, normal-path cost, and refusal after a predecessor succeeds.
No live financial mutations were run to test this change.

Publication and adoption must be verified separately. The normal announced
engine restart owns adoption; do not force a restart to validate this patch.
The iPad Home Screen connecting delay and purchase unknown-outcome handling
remain separate open work. The full hand-delay tail is not declared solved.
