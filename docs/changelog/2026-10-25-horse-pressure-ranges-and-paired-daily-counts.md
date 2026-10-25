# Omaha pressure ranges and paired daily counts

The October 24 set and naked-trips river reviews exposed a V40 sampling
defect: the declared 85% value arm stopped after four failed redraws and
accepted a weak final holding. On the recorded paired river, only 61.39% of
10,000 samples met the declared category. V56 draws directly from the existing
preflop percentile reservoir intersected with the public board requirement
and physically remaining cards. Its collision fallback samples uniformly
across supported combinations. It never conditions on future board cards.

Both recorded river decisions fold on all 40 fixed replay seeds with V56;
the off arm retains the erroneous call or shove. This does not classify the
earlier turn call as a leak simply because the hand lost.

The frozen 3 x 6,000-pair, 400bb cash qualification is retained in
`docs/qualification/horse-v56-20261025.json`. PLO4 pooled +6.8360 +/- 3.3910
standard error and PLO6 +8.0981 +/- 3.8740 clear the predeclared two-standard-
error gate; PLO5 +5.2849 +/- 3.4361 is inconclusive. All nine runs have zero
illegal actions and zero truncated streets, nonzero divergence and no
significantly negative seed. PLO4/PLO6 default on; PLO5 remains opt-in.
Explicit false preserves the off arm. These are benchmark results, not live
results or a solver certificate. V55 remains off.

The daily count path also had independent, additive play and net batches:
a lost acknowledgment could replay either batch, and a crash could lose one.
Zero-action dealt hands were absent from play despite being counted in nets.
Normal protocol-2 hands now capture matched per-horse net/play rows in the
private immutable Stats payload. The original Stats projector inserts its
existing per-hand receipt and both daily aggregates in one transaction, only
on that receipt's first insertion. Duplicate, concurrent or restarted
projection cannot increment either denominator twice. Review publication
continues, with the old count writer bypassed for this captured payload and
seat touches preserved. Legacy/Lightning callers retain their existing path;
forced-only dealt hands count in both legacy denominators too. Explicit
rollup kill switches retain their old behavior.

The function-only migration pins the current projector preimage and preserves
its facts, transfers, permissions and source-hash conflict checks. Native
PostgreSQL qualification runs on existing accounting shard four and proves
lost-ACK replay, eight concurrent projectors, second-aggregate rollback and
recovery, invalid scopes and participant execution refusal. A connected
engine test checks private capture before acceptance and no legacy recount.

Historical reconciliation and production installation/engine adoption are
separate acceptance items. This change does not overwrite old rollup rows,
move chips, add a receipt store, timer or repair loop, or claim the original
1,772 discrepancy resolved merely by changing future writes.
