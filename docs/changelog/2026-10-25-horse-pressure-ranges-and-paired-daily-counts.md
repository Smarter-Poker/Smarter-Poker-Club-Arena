# Omaha pressure ranges and paired daily counts

The October 24 set and naked-trips river reviews exposed a V40 sampling
defect: the declared 85% value arm stopped after four failed redraws and
accepted a weak final holding. On the recorded paired river, only 61.39% of
10,000 samples met the declared category. V56 draws directly from the existing
preflop percentile reservoir intersected with the public board requirement
and physically remaining cards. Its collision fallback samples uniformly
across supported combinations. It never conditions on future board cards. The candidate now applies only
to vulnerable sets or naked trips on a single-board Omaha-high river, and
only the tier-three aggressor receives this range. Other streets, passive
opponents, split-pot games and multiple boards retain their original sampling.

Both recorded river decisions fold on all 40 fixed replay seeds with V56;
the off arm retains the erroneous call or shove. This does not classify the
earlier turn call as a leak simply because the hand lost.

The initial 3 x 6,000-pair, 400bb cash exploration is retained in
`docs/qualification/horse-v56-20261025.json`. PLO4 pooled +6.8360 +/- 3.3910
standard error and PLO6 +8.0981 +/- 3.8740 clear the predeclared two-standard-
error gate; PLO5 +5.2849 +/- 3.4361 is inconclusive. All nine runs have zero
illegal actions and zero truncated streets, nonzero divergence and no
significantly negative seed. The original driver did not freeze the load governor or mood clock, so these
results do not qualify promotion. All variants remain opt-in until the
controlled replacement experiment resolves. The controlled broad candidate
then returned PLO4 +0.0810 +/- 3.1269, PLO5 +3.8001 +/- 3.4245, and
PLO6 +6.0387 +/- 3.6799 standard error across three fixed seeds each.
All were inconclusive; complete controlled inputs/results are retained in
`docs/qualification/horse-v56-controlled-broad-20261025.json`. The narrower
river candidate has a separately predeclared controlled experiment. No
positive result is inferred from the recorded-hand replays.
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
seat touches preserved. Lightning now uses that same private capture, keyed by its durable hand identity
and its separate stake bucket. Its legacy writer stands down only when the
settlement retains that identity; an older settlement dropping the payload
keeps the old writer. Legacy physical callers retain their existing path;
forced-only dealt hands count in both legacy denominators too. Explicit
rollup kill switches retain their old behavior.

The existing projector advertises its service-only capability on a null-hand
no-op, installed atomically with its count body. This prevents rolling
engines from handing counts to an older projector. Unknown or incompatible
capability responses retain the existing writer and report that decision.

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

The historical discrepancy was independently reconciled with all 947,434
normal hands carrying original Stats projection receipts, covering exactly
4,398,638 seat facts. The same 934 horse identities represented in the daily
rollups have 4,395,597 certified dealt-seat facts. Legacy play totals are
4,400,017 (4,420 high) and legacy net totals 4,398,245 (2,648 high):
1,772 = 4,420 - 2,648. These independent additive counters drifted; this is
not 1,772 missing hands. Historical Lightning hands are identified by durable
hand identity and excluded from this normal-hand completeness denominator.
The audit panel preserves canonical counts alongside explicitly labeled
legacy totals. Missing old batch identities and floor provenance prevent
reconstructing individual duplicate/lost batches; no historical rollup or
financial rows are rewritten.

The narrow river candidate passed the separately declared controlled
3 x 24,000-pair experiment per variant: PLO4 +1.7572 / 0.3785 SE,
PLO5 +2.0229 / 0.3412 SE, PLO6 +0.6501 / 0.3006 SE. All nine runs
have zero illegal/truncated actions and nonzero divergence; PLO6 clears
the two-SE gate narrowly and its last seed is unresolved negative. The full
inputs and outcomes are retained in horse-v56-river-controlled-20261025.json.
Enable the public-range correctness repair for this single-board Omaha-high
cash river set/trips domain; tournament behavior and the explicit off arm
remain unchanged. The evidence is the fixed400bb cash mirror card, not a
solver certificate or a measured claim at every depth.
