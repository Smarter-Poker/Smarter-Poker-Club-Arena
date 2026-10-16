# The Packs Do Their Declared Work, And FLO8 Stops Defending The Big Blind

**Date:** 2026-10-16

Two changes to hashed Horse Brain files, landed together so they cost one combined requalification
(the opponent-exploitation change on `claude/horse-opponent-exploit-20261016` moves the same
digests).

## 1. No Clock Decides A Pack Decision

### What Was Wrong

The strength matrices of every qualified pack run on a fixed clock with the equity governor off,
so they price the full work of every decision. Live, a wall clock could cut that work and replace
the measured proposal by the reference brain:

| Owner                                                                        | Wall-clock cut-off that stood                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLO4 (Phase 10), `Plo4LivePolicy.ts`                                         | `PLO4_POLICY_PACK.liveBudgetMs` 4 ms: proposal replaced by the reference, reason `work_budget`                                                            |
| PLO5/PLO6/PLO8 (Phase 11), `OmahaVariantLivePolicy.ts`                       | `liveBudgetMs` 4 ms (`work_budget`), sampler deadline 3 ms, river net-action pass 1 ms (`OMAHA_VARIANT_NET_ACTION_BUDGET_MS`)                             |
| FLH, FLO8, Short Deck, Pineapple (Phase 12), `RemainingVariantLivePolicy.ts` | `liveBudgetMs` 4 ms (`work_budget`), `samplingDeadlineMs` 2.5 ms, `netActionBudgetMs` 1 ms                                                                |
| Phase 8 tournament postflop, `HorseTournamentPostflop.ts`                    | `workBudgetMs` 4 ms (continuation stopped part way, `continuation_operation_budget`), `budgetMs` 5 ms wall and `policyBudgetMs` 2 ms (`budget_exhausted`) |

So a live decision could differ from the decision the matrix measured, and which one a horse made
depended on how loaded the engine host was. The full-brain report measured 48 of 2,913 candidate
cash decisions (1.6%) cut this way on 5780828e. In the Phase 8 league itself 8,661 to 18,151 of
about 20,500 eligible Spin decisions per seed were cut (docs/evidence/phase8/strength-2026-10-08).

### What Changed

The Phase 13 precedent (`docs/changelog/2026-10-11-phase13-live-work-is-the-measured-work.md`),
applied to every other pack: the clock is read only to measure (`latencyMs`, `analysisMs`,
`simulationMs`, `policyMs`), never to decide. The work is the declared work the matrices already
price. No new ceiling was needed; these are deterministic counts:

- PLO4: the dealt census (at most `domain.maxSeats` 8), the public action line and the range
  capture. The policy samples nothing itself.
- PLO5/PLO6/PLO8 and the Phase 12 packs: the full 32-sample request, at most three prior draws per
  dealt opponent per sample (the declared uniform escape on the third), and on a fired river node
  the net-action pass over those same showdowns (fold, call and at most two priced wager sizes in
  pot limit; the fixed-limit lines in FLH/FLO8).
- Phase 8: at most `maxCandidates` 16 candidates, `maxFutureOutcomeSamples` 16 outcome samples (32
  only on a calibration retry), one future hand per branch, `maxFutureIcmTrials` 128, and
  `maxFutureHandSeats` 3, a bound fixed from public seat state before any work. Its refusal
  `future_hand_seats_outside_work_budget` was already deterministic and is unchanged.

Removed: `liveBudgetMs` from `PLO4_POLICY_PACK`, `OMAHA_VARIANT_DOMAIN` and
`REMAINING_VARIANT_DOMAIN`; `samplingDeadlineMs` and `netActionBudgetMs`; the exported
`OMAHA_VARIANT_NET_ACTION_BUDGET_MS`; `PHASE8_POLICY.workBudgetMs` and `policyBudgetMs`. The
samplers' and net-action passes' optional `withinBudget` hooks remain for offline callers; no live
call passes one. A supplied sample's non-finite `analysisMs` now adds nothing to `latencyMs` (the
evidence check already refuses such a sample wherever it would be consumed). Receipt reasons
`work_budget`, `budget_exhausted` and the completion definitions' `workBudget` and
`samplerBudgetExhausted` counts stay, to classify receipts of earlier releases.

### The Leagues And Contracts Evaluate The Same Work

The Phase 10/11/12 leagues already ran on a fixed clock (`phaseNNEvidenceMode`, `now = 0`), so
they priced exactly this work; nothing in them changes. What changed is the text the contracts
keep about live play:

- `OmahaVariantStrengthContract.ts` and `RemainingVariantStrengthContract.ts` (v2):
  `liveConditions.differences.policy_clock` now states that live and harness do the same declared
  work (handling `design: ...`). Phase 11 contract digest 5b93ae20... to
  `0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05`. Every other field, seed,
  shard count and margin is unchanged.
- The PLO4 contract has no clock text and is unchanged (83ab185b...).
- FLH's contract v1 is frozen bytes (fafbba8d...) and cannot move. Its `policy_clock.live` text
  describes the live clock before this change; its harness condition (fixed clock, full work) is
  unchanged and is now also the live condition.
- Phase 8's league ran on the real clock and now does the declared work too. Its latency gate
  (`latencyMs.p99 <= PHASE8_POLICY.budgetMs`, 5 ms) is unchanged; see "Phase 8 cost" below.

### Cost Of The Declared Work

Measured through `HorseLogic.decide` on the real clock with each pack in shadow, over random
holdings and boards, every dealt-seat count from 2 to the cash seat cap and every street, after a
warm-up pass. `latencyMs` is exactly the quantity the old 4 ms budget was compared with. Script:
`measure-packs.mts` (agent scratch, not committed).

Development Mac (Apple M3 Ultra, Node 22.23.3, load average 11 to 14 from other agents), 40
decisions per cell:

| Pack       | Eligible | p50 ms | p90 ms | p99 ms | max ms | > 4 ms | River net-action p99 / max ms |
| ---------- | -------- | ------ | ------ | ------ | ------ | ------ | ----------------------------- |
| PLO4       | 1,120    | 0.11   | 0.19   | 0.45   | 4.50   | 1      | -                             |
| PLO5       | 960      | 0.44   | 0.70   | 0.98   | 1.57   | 0      | 0.93 / 1.30                   |
| PLO6       | 800      | 0.45   | 0.75   | 1.08   | 1.33   | 0      | 0.93 / 1.09                   |
| PLO8       | 1,120    | 0.45   | 0.80   | 1.14   | 1.43   | 0      | 1.11 / 2.32                   |
| FLH        | 1,280    | 0.16   | 0.25   | 0.53   | 0.72   | 0      | 0.63 / 0.68                   |
| FLO8       | 1,120    | 0.51   | 0.87   | 1.07   | 1.29   | 0      | 0.72 / 0.84                   |
| Short Deck | 1,280    | 0.13   | 0.22   | 0.41   | 0.60   | 0      | -                             |
| Pineapple  | 1,280    | 0.25   | 0.47   | 0.72   | 0.87   | 0      | -                             |

x64 Linux (Intel Xeon 2.1 GHz, 2 vCPU, Node 22.22.0, idle), 20 decisions per cell:

| Pack       | Eligible | p50 ms | p99 ms | max ms | > 4 ms |
| ---------- | -------- | ------ | ------ | ------ | ------ |
| PLO4       | 560      | 0.23   | 1.07   | 42.25  | 0.5%   |
| PLO5       | 480      | 0.80   | 2.12   | 7.17   | 0.4%   |
| PLO6       | 400      | 0.79   | 2.10   | 4.31   | 0.3%   |
| PLO8       | 560      | 0.95   | 2.47   | 4.15   | 0.4%   |
| FLH        | 640      | 0.40   | 1.00   | 1.37   | 0      |
| FLO8       | 560      | 0.93   | 2.67   | 5.52   | 0.5%   |
| Short Deck | 640      | 0.33   | 0.99   | 1.30   | 0      |
| Pineapple  | 640      | 0.51   | 1.15   | 3.18   | 0      |

The 42 ms PLO4 maximum is one heads-up decision (p99 of the same cell 1.07 ms everywhere else), a
garbage-collection or compilation pause, not policy work. Every postflop decision on both machines
drew all 32 samples. The engine host is slower x64; the Phase 13 measurement put it at 2.4 to 3.2
times the Mac. At 3.2 times, host p99 is at most about 3.7 ms and the largest policy decision about
14 ms (PLO4) or 7.5 ms (all others); the x64 runner's own figures agree (p99 at most 2.7 ms).

Against the live turn budget this is small: a decision job is never given less than 2,000 ms
(`HORSE_DECISION_MIN_DEADLINE_MS`), the worker-integrity window is 8,000 ms, and the whole
`HorseLogic.decide` around the pack measured p99 at most 16.4 ms and max 22.9 ms on the x64 runner.
The added CPU is only the work the cut used to abandon: about 1.6% of candidate cash decisions,
each finishing a few milliseconds more.

### Phase 8 Cost

Phase 8 runs only on NLH tournament postflop decisions with at most three future-hand seats, in
shadow (no selection; every tournament objective is an unavailable dependency). Its full declared
work, measured by the tournament league (`horseTournamentEvaluate.ts`, fixture mode, 4 pairs, x64
runner above; the league requires the Linux launcher, so not on the Mac):

| Run          | Eligible | Completed | p50 ms | p95 ms | p99 ms | max ms |
| ------------ | -------- | --------- | ------ | ------ | ------ | ------ |
| spin 901791  | 84       | 84        | 4.36   | 13.74  | 15.36  | 15.36  |
| spin 8101101 | 58       | 58        | 5.15   | 15.70  | 25.37  | 25.37  |
| spin 8102203 | 95       | 94        | 4.83   | 14.21  | 22.24  | 22.24  |
| spin 8103307 | 123      | 122       | 4.60   | 11.45  | 17.92  | 26.31  |

No decision was stopped by a budget; the two not completed are named
`continuation_sample_calibration`. Well inside the turn budget, but above the league's own 5 ms
p99 gate, which is unchanged: Phase 8 cannot pass it until a reviewed change resizes either its
declared work or that gate. That decision belongs with the tournament outcome model Phase 8 still
lacks.

## 2. FLO8 Round 4: Its Own Rules, Without The Big Blind Defence

The contract v2 FLO8 matrix (run 38771868755 on 818b10c1) won, +1.06 [+0.72, +1.40] bb/100 with
no losing cell, but failed the trust check in `cash:profile:p12c-flo8-6max-2dealt-100bb` (Edgeworth
0.00145) and `cash:position:big_blind` (0.00571). The cause named in the round-2 handoff: the
big blind defence (`bigBlindDefendBelowCallBar` 0.15 on the fixed-limit rules) is a rare, large
change, and a handful of large paired differences among exact zeros is what the skewness check
measures.

- `REMAINING_VARIANT_FLO8_ROUND4`: the fixed-limit rules with `bigBlindDefendBelowCallBar: null`;
  open tightening, the heads-up open and the small blind steal are unchanged. Pack version
  `fixed-limit-omaha8-round4-v1`.
- FLH keeps `REMAINING_VARIANT_FIXED_LIMIT_ROUND3` byte for byte (pinned by
  `RemainingVariantFlo8Round4.test.ts`, which also shows FLH still defends exactly where the round-3
  condition holds and FLO8 now folds with the reference at the same node, including 8 of 10 hands
  round 3 defended).
- Contract v2 is built from the live pack versions, so it moves with FLO8's version and the
  policy_clock text: 6c50e717... to `0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2`
  (Short Deck, Pineapple, FLO8). Seeds, shard counts and margins are unchanged. FLO8 is re-run on
  its v2 held-out seeds, as every pack in this requalification re-runs its own; the seeds were
  dealt once already, to the round-3 pack.

Development-seed proof (seed 12101101, one shard per profile, 648 pairs, 640 at 8max; held-out
seeds never used), the round-3 source (origin/main) against this source, both on the fixed league
clock:

- FLH, all seven profiles: pair digest, both arms' nets, changed pairs, decisions and eligible
  decisions identical. FLH's decisions are unchanged.
- FLO8, six of seven profiles identical. 6max 2dealt 100bb: the reference arm is identical; changed
  pairs 3 to 1, candidate minus reference 400 to 40 chips: the two heads-up big blind defences are
  gone and nothing else moved. On these seeds the defence fired only heads-up.

## Records

Every change in section 1 and 2 is inside the Phase 10, 11, 12 and 13 policy digests, so every one
moves (Phase 13 policy digests too; the Phase 13 contract is unchanged). Computed on the committed
source:

| Phase | Pack            | Policy digest                                                    |
| ----- | --------------- | ---------------------------------------------------------------- |
| 10    | PLO4            | 0089775cfc0c2d334fd34c8e3223d0535fce14be869c9169572e811911925875 |
| 11    | PLO5            | 02c955bd564bc1ca1ecbb74376cd685c55e3f69d0eb3732d288ed60f17053ca6 |
| 11    | PLO6            | 1a0bd93396e9a77405b865d40763cecd15721f3efcb8e08290eb2965ff8aca5d |
| 11    | PLO8            | 0c53baead46d25ae81f73b8b467bf5cf72b9b0956377eebd0d43fd927b8a1c0a |
| 12    | Short Deck      | a5fa0fb73b372453dce2afff90780b80119bb6401cae66960eee06d415535416 |
| 12    | Crazy Pineapple | 823f75ed5057385ee60020f66540671c495b67af833551916855f4fd29f89508 |
| 12    | FLH             | f3b3d2e72bbd12d7355dd9d055781e7dd318a39280c8db045ef2293651a75ca0 |
| 12    | FLO8            | 96f8bfc1e8f90c1c14111ffff525ad5348562d454c595a7044f182352b5d24fb |
| 8     | (one)           | 3eaf56053395fb046c8bce310e4175c0504d6399b04958900c5fd00e7661fd3a |

These are this branch alone; combined with the opponent-exploitation branch they move again and
must be recomputed on the combined source.
Superseded: the combined table is in
[2026-10-16-horses-read-each-opponent.md](2026-10-16-horses-read-each-opponent.md#combined-digests-this-change-with-the-declared-pack-work).

As in #6777 and #6886, the committed selections are null until requalification: PLO4 generation 2,
PLO5/PLO6/PLO8 generation 2 and FLH generation 3 are retained in
`HorsePreviousSelections.test-support.ts` (`RETIRED_2026_10_16_*`) and pinned as refused (policy
digest mismatch; the Phase 11 ones by the moved contract digest first). Their evidence stays
committed and shipped. Renewals are PLO4 generation 3, PLO5/PLO6/PLO8 generation 3 and FLH
generation 4. The worker and exact-replay tests return to the null-selection form #6886 used.

## Tests

- Determinism under any clock: `HorseDeclaredWork.test-support.ts` runs one decision under a fixed,
  a slow (5 ms per read) and a stalled (1,000 ms) clock from the same random state and compares
  everything but the measurements. Used in `Plo4LivePolicy.test.ts`,
  `Plo4RangeCaptureBudget.test.ts`, `OmahaVariantLivePolicy.test.ts` (each of PLO5/PLO6/PLO8, every
  postflop street: the full 32 samples whatever the clock), `RemainingVariantLivePolicy.test.ts`
  (all four packs, same), `RemainingVariantNetAction.test.ts`, `HorsePhase8Tournament.test.ts`,
  and the Phase 11/12 completion-share tests.
- Source pins: the net-action passes are called with no deadline and no `economicsStart`.
- The P12.3 completion reader (`server/src/scripts/phase12CompletionRecord.test.ts`, outside the
  engine suite, so the pre-push hook found it): its window built the one river work-budget fallback
  from a live decision on a 5 ms clock, which since this change does the declared work and counts
  complete (river 131 / 0 instead of 130 / 1). The fallback is now what it is, an EARLIER release's
  journaled receipt (`reason: 'work_budget'`), and the reader still counts it as `workBudget` and
  admission still refuses the record below the floor; the same test asserts a slow and a stalled
  clock now produce a `completed` receipt. `horsePhase12CompletionOutcome` is unchanged.
- `RemainingVariantFlo8Round4.test.ts`: section 2.
- Contract pins updated with the reasons above.
- Server engine suite (`src/engine src/services src/benchmark`): 862 files passed, 1 skipped;
  15,684 tests passed, 168 skipped. `tsc --noEmit -p server` clean.

## Not Verified

- No held-out matrix has run on this source; nothing here is selected.
- The engine host's own cost of the declared work is projected, not measured (the x64 runner is a
  stand-in).
- Phase 7's own tournament utility allowances in `HorseLogic.ts` (the multi-board
  `JOINT_SAMPLE_WORK_BUDGET_MS`, the 4 ms shadow-utility and Phase 13 tournament-utility clocks)
  still read the wall clock. They are outside the packs and tournament-only, and were left for their
  owner.
