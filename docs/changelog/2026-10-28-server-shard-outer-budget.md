# Preserve the server tests' existing execution allowance

PR #8372 run 40591864856, shard job 122518658540, reached the 15-minute job cap without a reported assertion failure. Setup and compilation consumed 1:13. Of its 403 assigned files, 402 completed; the remaining `HorseV54RiverBluff.test.ts` has an existing 900,000 ms per-test limit for its fixed 6,000-pair PLO6 regression. The outer job could therefore cancel work still inside its existing test allowance.

The server matrix outer cap becomes 25 minutes: the observed 7:25 setup/other-file envelope, the existing 15-minute test allowance, and 2:35 for remaining work/cleanup. This is bounded execution headroom, not evidence the interrupted test passed. Comparable successful shard-1 jobs 122473453067 and 122470015554 took 6:45 and 7:17; they do not establish completion of the interrupted candidate.

No test, pair count, seed, assertion, per-test deadline, matrix assignment, parallelism, command or required aggregate changes. Six active workflow byte/hash bindings are updated only for this reviewed scalar change; historical receipts and qualification states remain untouched. No runtime strategy or production change is included.
