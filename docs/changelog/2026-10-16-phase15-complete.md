# Horse Brain Phase 15: every component live and proven (2026-10-16)

Dan's requirement: all Phase 15 upgrades fully triggered, working and in use for all horses.
The audit of release 5780828e (report-fullbrain-phase15, 17:20Z) found five Phase 15 items
that were not: plan receipts lost under backlog, unexplained retired second looks, the
silence/OOD alarms and the daily reference-agreement report never built, exact replay never
run on a release since the packs went live, and the journal reader hard-coding
`replayVerified: false`. This change closes each of them. No hashed policy file is touched
(checked against the union of `HORSE_PHASE10/11/12/13_POLICY_SOURCE_FILES`, 44 files).

## 1. Durable receipts: the effect lane

**Root cause.** `COMMIT_DECISION_EFFECTS` is posted inside the dispatch barrier, whose insert
index is `queue.length` when the barrier opens, so the commit of an accepted wager queued
behind every unposted job; `RETIRE_DECISION_EFFECTS` took the plain tail. Both carried the
8-second decision deadline. Under backlog (worker FIFO 100 to 491 deep, oldest 1.7 to 6.8 s)
the commit expired before dispatch, the worker never saw it, and no durable receipt was
written; its `commit_unconfirmed` retirement then queued at the same tail and expired too.

Measured 2026-10-16 (`horse_brain_telemetry`): `phase15_plan_commit_posted` 262,544,
`phase15_plan_receipt_applied` 262,080 (464 posted commits without a receipt; the 17:20Z
audit counted 180 at that hour), `phase15_plan_refused_*` 0 (the worker refused none),
`phase15_plan_retirement_unconfirmed` 154; engine /health on 4c3509e5:
`lastExpiredRequestType: COMMIT_DECISION_EFFECTS`, `lastExpiredPhase: queued`.

**Fix** (`server/src/engine/horseDecision/client.ts`, `HORSE_EFFECT_LANE_TYPES`). Commit and
retirement queue in a front lane with the capture jobs, in arrival order, ahead of every
unposted job, and carry the observation deadline. A commit still precedes the TURN_CHANGE
work its own action enqueues (now also the older backlog); nothing older can read the
batch (effects are keyed by their own hand, no older job is that horse's next decision in
that hand, a second look reads its retained FAST view). The lane is bounded by the worker's
128-entry issued-batch bound.

**Pinned** (`client.test.ts`, describe "the effect lane"): a commit enqueued behind a
40-decision backlog is posted next and survives past the old 1 s decision deadline; a
`commit_unconfirmed` retirement queues ahead of the backlog and is confirmed. Both new
tests, and the three re-baselined ordering tests, fail on the previous client.

Natural check in the private journal copy (18:50Z to 19:04:49Z, below): 1,968 of 1,969
accepted exact wagers with a nonempty batch have their durable receipt; the one without
was accepted in the copy's last 60 seconds.

## 2. Execution witness: why a witness was retired

`HorseExecutionWitness.countFinal` now also fires
`phase15_<lane>_execution_retired_<reason>` for every `not_executed` witness.

The 96% of deep second looks "never executed" is design, not a defect. In the journal copy,
902 deep witnesses: 879 `not_executed` with reason `second_look_unchanged` (the deeper read
agreed with the fast answer, so the fast decision executed), 23 `intended` (the deeper read
flipped the action and executed), none `response_fence`, `caller_settled` or
`brain_exception`. On the fast lane: 30,230 `intended`, 24 `second_look_replaced` (the
mirror of the 23 flips plus one in flight), 5 `turn_abandoned`, 1 `coerced`.

## 3. Silence and out-of-domain alarms, and the daily reference-agreement report

`server/src/engine/HorsePolicyLedgerObserver.ts` reads every validated live FAST decision on
the main thread (once; a deep second look re-decides the same turn) and counts:

- `poker_horse_policy_decisions_total{variant,outcome}`: the registry's reconciled outcome
  (`reference`, `disabled`, `computed`, `outside_domain`, `unavailable`) or `unregistered`;
- `poker_horse_reference_agreement_total{variant,format,agreement}`: the final policy action
  against the action the graph's `reference` node produced (`exact`, `action` for same action
  other amount, `differ`, `unrecorded` for no sealed graph);
- the same agreement, and the first graph node that moved a divergent decision, into the daily
  brain telemetry (`phase15_reference_agreement_*`, `phase15_reference_divergence_*`).

Both series are always-on and zero-seeded over closed label sets (unknown variants count as
`other`), so a rule has a series before the first decision.

**Alarms** (`infra/monitoring/alert-rules.yml`, group `horse-brain-phase15`, runbook
`docs/runbooks/horse-brain-phase15.md`, all `severity: warning`): `HorseBrainPolicyLedgerSilent`,
`HorseBrainVariantSilent`, `HorseBrainOutsideDomainSurge`, `HorseBrainPolicyUnavailableSurge`,
`HorseBrainPolicyUnregistered`, `HorseBrainPolicyGraphUnrecorded`. The series are new, so
each threshold is derived from the same counts where they already existed and the
measurement is written beside the rule: eight days of `phase15_policy_*` (highest daily
out-of-domain share 17.98% short_deck, highest daily unavailable share 0.75% flo8, nlh 0),
5-minute buckets of the journal copy (highest out-of-domain 19.7% pineapple, highest
unavailable 1.85% plo8), and 7 days of `poker_actions_fleet_total{audience="horse"}` at a
1-minute step outside breaks (p0.1 13.8/min, p1 94, median 3,301; under 30 in 11 of 10,080
minutes). Every expression was evaluated by the live Prometheus query API (parses; empty
until the series exist). `check-monitoring-drift.mjs` passes. A rule is live only after
`bash infra/monitoring/deploy.sh` on the box (CLAUDE.md 10.84); not done here.

**Daily report** (product job, `supabase/migrations/20261016192158_*.sql`):
`horse_reference_agreement_daily`, one row per UTC day, written by
`fn_run_horse_reference_agreement(p_day)` from that day's telemetry: per (variant, format)
agreement, divergence by graph node, the registered pack outcomes with out-of-domain and
unavailable shares, deep second-look retirement reasons, and findings against the trailing
seven complete days (agreement drop over 2 points, any unrecorded graph, out-of-domain share
up over 5 points, unavailable share over 1% and doubled, no input). The engine job
`HorseReferenceAgreementReport` runs it for yesterday in the 07:00 to 10:00 UTC window under
the `horse_job_runs` claim contract (`reference_agreement`), exactly as the daily audit does.
Read with `ca_horse_reference_agreement(days)` (service role). The migration was applied twice
to a throwaway local PostgreSQL 17 and exercised with eight synthetic days: every finding
rule fired on its case, anon was refused.

Live reference agreement measured from the journal copy (FAST decisions, final against
reference action and amount): nlh cash 99.15%, nlh tournament 99.12%, plo4 cash 97.76% /
tournament 98.11%, plo5 97.19% / 96.64%, plo6 97.41% / 97.09%, plo8 cash 96.66%, flh cash
96.98%, flo8 cash 99.76%, pineapple cash 98.72%, short_deck cash 99.57%. The most frequent
first divergent node is `reference_legality` (nlh 131, plo4 104, plo5 99, plo6 39): the
reference's action is not the legal action the graph executes about 1% of the time; then
`variant_policy` (the qualified packs: plo8 20, plo4 14, plo6 14, plo5 12, flh 10). The
`reference_legality` share is reported, not changed (the reference is in HorseLogic, hashed).

## 4. Exact replay on the live release

Declared before reading (`docs/evidence/phase15/replay-declaration-4c3509e5-20261016.md`,
sha256 beside it, committed 18:45:55Z), with an addendum written before any replay: the
serving release changed inside the window (maintenance break 18:53:00Z to 19:00:53Z;
`098071833b4e` serving from then on, engine and replay code identical to `4c3509e5`). Copy
19:04:34Z to 19:04:49Z, read-only (`nice -n 19 ionice -c3`, tar over ssh) to the Mac's main
disk; 134,587 records; sha256 `6cbfff3f...`. Every child ran on the official Node v22.23.2
linux-x64 (V8 12.4.254.21-node.56, the engine's own) inside an x86_64 Debian 12 guest under
QEMU on the Mac Studio; no journal byte left Dan's machines.

| Batch (rule)                                                           | Source     | Replayed | Exact | Refused or different                                                              |
| ---------------------------------------------------------------------- | ---------- | -------- | ----- | --------------------------------------------------------------------------------- |
| A, predeclared (18:55:00Z to 18:56:30Z)                                |            | 0        |       | the window fell inside the maintenance break                                      |
| V, predeclared (newest 50 of each variant)                             | `09807183` | 450      | 432   | 16 `non_replayable:retained_fast_read_view`, 2 `non_replayable:wall_clock_budget` |
| Q, predeclared (newest 600 with a candidate admission or applied pack) | `09807183` | 600      | 598   | 2 `non_replayable:wall_clock_budget`                                              |
| P, supplementary (every applied pack decision in the window)           | `09807183` | 6        | 6     |                                                                                   |
| P, supplementary                                                       | `4c3509e5` | 10       | 8     | 2 `replayed_mismatch` at `decision.omahaVariantPolicy.equity.analysisMs`          |

842 distinct records (1,066 replays; a record selected by two batches gave the same outcome
both times): 822 `replayed_exact`. 1,066 fresh child processes, 0 child failures, 0 outbound
connection attempts; every record named runtime v22.23.2 / 12.4.254.21-node.56 / x64 (the
16 deep second looks name none). Acceptance join: every record joined its execution witness
(1,050 `intended`, 16 `not_executed` deep looks); every `applied` durable receipt (Q 83,
V 44, some records in both) bound exactly the batch the replay reproduced; none `failed`,
`absent`, `invalid` or `other_batch`.

Per variant (V, the predeclared every-variant batch, exact / refused): nlh 50/0, plo4 49/1,
plo5 46/4, plo6 49/1, plo8 48/2, flh 49/1, flo8 50/0, pineapple 45/5, short_deck 46/4.
Q by variant (exact / refused): nlh 246/0, plo4 82/0, plo5 53/0, plo6 48/0, plo8 44/1,
flh 22/1, flo8 29/0, pineapple 35/0, short_deck 39/0. 58 (format, variant, street) cells across cash,
mtt, spin and hu_sng; per-cell counts are in the per-run summaries under
`docs/evidence/phase15/replay-20261016/`.

Every non-exact record, by cause:

- **16 `non_replayable:retained_fast_read_view`** (pineapple 5, plo5 4, short_deck 4, plo4 1,
  plo6 1, plo8 1): `DECIDE_DEEP` second looks. The runtime accepts one only against the FAST
  read view it retained in memory; the replay does not fabricate that retention (by design
  since the replay was built; each joined a `not_executed` witness, the fast answer executed).
- **2 `non_replayable:wall_clock_budget`** (the same two records in V and Q: a plo8 cash river
  fold and an flh cash turn check, qualified packs admitted `candidate`): first difference
  `decision.policyOwnership.outcome`. The original pack ran past its 4 ms wall-clock work
  budget and fell back (`unavailable`, reason `work_budget`); the replay, clock frozen,
  finished inside it (`computed`). The action, amount and RNG were the same. How much work
  fitted is not in the record, so the exact replay refuses it by name instead of calling it
  exact or different. Cause: the packs bound work by wall clock (audit G6;
  `OmahaVariantLivePolicy.ts`, `RemainingVariantLivePolicy.ts`, hashed). 2 of 600 qualified
  decisions in Q.
- **2 `replayed_mismatch`** (P, `4c3509e5`: a plo8 river bet and a plo6 river bet whose
  qualified Omaha pack decided, `applied: true`): first difference
  `decision.omahaVariantPolicy.equity.analysisMs`, the wall-clock time the pack's equity
  analysis took, recorded in the receipt; the frozen-clock replay measures 0. Action,
  amount, RNG, effects and binding were equal. The comparator compared a measurement, not a
  decision field (packs went live after the replay was written; shadow receipts were never
  compared). Fixed on this branch: `analysisMs` joins the volatile measurement keys in
  `HorseDecisionReplay.ts` (a budget that bound is still named and refused, as above).
  Diagnostic, not replay evidence: both records re-run in fresh children on a copy of the
  `4c3509e5` checkout with only that comparator line changed replay `replayed_exact`
  (`replay-20261016/diag-P-4c3509e5.json`). Replays of a release that contains this fix will
  count them exact.

So qualified packs' live decisions do replay exactly: of the 16 pack-applied decisions in the
window, 14 exact and 2 equal in every decision field; of the 600 candidate-admitted ones, 598
exact and 2 refused by name for the unrecorded wall-clock budget.

## 5. `replayVerified` and `runtimePins`

- `replayVerified`: the hand reader cannot compute it (a record replays only in a fresh
  process on its own source and runtime; the reader runs on whatever opened the journal), so
  `HorseJournalHandReview.replayVerified` stays `false` and now says why. The real value is
  computed where it exists: `joinHorseJournalHandReplay` (CLI `horseJournalReview --replay
  <dir> <hand> <verdicts.json>`) sets it `true` only when every decision record of the hand
  has exactly one exact-replay verdict bound to that record (event id and, new, the record
  digest `recordSha256` the verdict now carries), made on the record's own source and
  runtime, with outcome `replayed_exact`. A hand with a deep second look is never verified.
- `runtimePins: 'incomplete'` stays, by fact: the journal record pins source, runtime,
  admissions, the Phase 8 sentinel, store identities, governor scale, RNG and read frame,
  but not whether a pack's wall-clock work budget would bind on another run. The live packs
  bound their work by wall clock (`OmahaVariantLivePolicy.ts`, `Plo4LivePolicy.ts`,
  `RemainingVariantLivePolicy.ts`, `HorseTournamentPostflop.ts`, all hashed); the record keeps
  the measured `analysisMs`, and the exact replay refuses a receipt whose budget bound as
  `non_replayable:wall_clock_budget`. Making the pins complete means replacing those budgets
  with fixed declared work (audit item G6), which re-opens qualification.

## Files

Not hashed (all): `server/src/engine/horseDecision/client.ts` (+test),
`server/src/engine/ServerTableEngineTurns.ts` (comment), `server/src/lightning/LightningHandHost.ts`
(comment), `server/src/engine/HorseExecutionWitness.ts` (+test),
`server/src/engine/HorsePolicyLedgerObserver.ts` (+test, new),
`server/src/observability/engineInstruments.ts`, `server/src/engine/HorseDataLedger.ts` (+test),
`server/src/services/HorseReferenceAgreementReport.ts` (+test, new), `server/src/index.ts`,
`server/src/benchmark/HorseLeague.ts` (claim evidence), `server/src/services/HorseAdaptiveJournalBootstrap.test.ts`,
`server/src/engine/horseDecision/replay/{HorseDecisionReplay,exactReplay}.ts` (+test),
`server/src/services/horseDecisionJournal/review.ts` (+`replayJoin.test.ts`),
`server/src/scripts/horseJournalReview.ts`, `infra/monitoring/alert-rules.yml`,
`docs/runbooks/horse-brain-phase15.md`, the migration, `docs/evidence/phase15/*`.
`workerRuntime.ts` and `lane.ts` are not touched.
