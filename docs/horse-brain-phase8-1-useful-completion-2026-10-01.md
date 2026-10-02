# Horse Brain Phase 8.1: Useful Completion Within Unchanged Work, October 1, 2026

Horse Brain only. This record covers P8.1 of the [maintained completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md): reproduce useful completion on current source with the actual compiled worker, optimize only a reproduced redundant operation without changing any result, and report the outcome by named refusal. It uses the maintained gate vocabulary (verified for named evidence, implemented but unverified, defective, unavailable dependency, historical only, not applicable with reason). Counts only; no percentage summary. P8.2 (strength evidence) and P8.3 (qualified authority) are separate lanes and are not claimed here.

## What Was Built

- `server/scripts/phase8-useful-completion.mjs`: builds a frozen population, then runs it through the compiled `HorseDecisionWorkerRuntime` (the class the production worker thread runs) with the runtime's own envelope and canonical-state validation, its own RNG derivation and the live Phase 8 safety latch. It reports per decision: eligible, fired, completed, the named refusal when not completed, the Phase 8 latency, simulation and policy times, the continuation work counters and the worker wall time. `digest` and `compare` modes provide the equivalence proof and paired work-demand timing. No limit is changed or passed in: the 4 ms work, 5 ms wall and 2 ms policy limits, 16 then 32 outcome samples and 128 future ICM trials are read from compiled source and recorded in every result.
- `server/src/engine/HorsePhase8ReplayFixture.ts`: the four captured production public lines and their reconstructed field, moved out of `HorsePhase8Replay.test.ts` unchanged so the suite and the diagnostic read one reconstruction.
- `server/src/engine/HorsePhase8UsefulCompletion.ts` and `.test.ts`: the equivalence digest (complete decision, every Phase 7 and Phase 8 candidate distribution and utility moment, continuation work counters and receipts; timing fields excluded) and a self-contained regression that computes the digest of all 182 decisions twice in one process, forward and in reverse with the clock frozen at 0, and requires identical rows. It cannot depend on machine speed. The digest recorded on this Mac is evidence for this machine only: hosted Linux CI computed a different row for decision 177, so a digest recorded on one machine is not asserted on another.
- Evidence: [`evidence/phase8/phase8-useful-completion.md`](evidence/phase8/phase8-useful-completion.md) with the population, cold and warm results, all repetitions and the exact commands.

## Measurements (Engine Source `4948e0ff`, This Mac)

Population: 182 decisions, sha256 `a9732fd8…f317d` (4 captured replay lines; league seed 8101101, 4 pairs per objective: MTT 19, SNG 51, Spin 71, satellite 7, PKO 15, mystery 15). 181 eligible; 1 `phase7_choice_retained`.

| Pass | Completed of 181 eligible (three fresh processes) | Named refusals per run                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| cold | 137, 138, 141                                     | `continuation_operation_budget` 42, 41, 38; `continuation_sample_calibration` 2, 2, 2 |
| warm | 151, 157, 152                                     | `continuation_operation_budget` 28, 22, 27; `continuation_sample_calibration` 2, 2, 2 |

No fired decision failed a final gate in these runs, so `fired` equals `completed` here; that equality is a measured result for this population and host load, not a relabeling of the `fired` sentinel. Every non-completion is a cooperative stop inside the 4 ms work deadline before firing (cold 1: future rollout 26, ICM 10, sample 6). Eligible latency p99 stayed between 4.119 ms and 4.247 ms and max between 4.153 ms and 4.48 ms; policy overhead max 0.415 ms cold and 0.075 ms warm. The historical MTT 14/29 cold and 25/29 warm figures remain historical only and are not compared with these.

Under heavy host contention from other agents (1-minute load near 48 on 28 logical CPUs), the final-gate refusal `budget_exhausted` appeared (16 to 22 per cold process) and three fresh processes latched `repeated_budget_breach` after 5, 27 and 41 eligible decisions. Those runs are retained, not discarded; they show the existing latency-breach gate refusing as specified.

## Hot Spots (Full-Work Profile, Clock Frozen at 0, 182 Decisions)

Sampled time under `evaluateTournamentPostflop`: 598.7 ms in all (8,742 ticks at about 68 microseconds). Inclusive: `simulateTournamentFutureHands` 250.3 ms, `settleSample` 183.1 ms, `simulateTournamentContinuation` 117.9 ms, `calculatePots` 76.2 ms, `calculateContestablePot` 63.2 ms, action ICM `estimate` 55.5 ms, `prepareJointPots` 49.9 ms. No single line holds more than 283 ticks. The hottest lines: the `JSON.stringify` equality in the `calculatePots` merge (283 ticks), its investment `Set` and sort (276), the rollout cache lookup with its per-sample key string (207), the continuation's seat copy and sort (182) and its per-street strength validation array (165).

## Optimization Outcome: None Shipped

One reproduced set of redundant allocations inside the owned continuation helpers was implemented and measured: allocation-free strength validation, the sort skipped for copies already in seat order, counted rather than filtered live seats, indexed future streets with one fact lookup per seat, and the rollout key's level prefix formatted once per candidate. It was exact on this Mac: all 182 rows matched the digest recorded on unchanged source, and all 182 matched again across 1,820 paired in-process calls per side.

It did not improve useful completion. Interleaved fresh processes (cold before, cold after, warm after, warm before, three repetitions, load 19 to 29): cold completed 146, 142, 146 before and 145, 144, 140 after; warm 154, 159, 158 before and 158, 159, 156 after. Separate-process full-work passes gave after/before wall ratios of 0.947, 0.989, 1.028, 0.782, 0.944 and 0.907 per A-B-B-A block; in-process paired timing was dominated by load order (whichever tree loaded first was faster). Following the plan, it was not shipped; the diff is retained in the evidence archive, `horse-brain-phase8-20261001/p8-1/held-micro-optimizations.diff`.

The two largest single redundant allocations are in `PokerEngine.calculatePots`, the canonical pot partition that real settlement uses. It belongs to the financial owner, outside this lane; changing it for a Horse timing gain was not attempted. With work spread across necessary rollouts, settlement and ICM, the measured result is that no safe optimization in the owned continuation path raises useful completion within the unchanged 4 ms budget. `HorsePhase8Safety.ts` is unchanged: no measured useful-completion requirement called for an extension, and `fired` is not relabeled.

## Gate Ledger for P8.1

| Gate               | Status                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | verified for named evidence: the frozen 182-decision population (NLH tournament flop 75, turn 60, river 47; MTT, SNG, Spin, satellite, PKO and mystery objectives; 2 to 9 local seats, field 2 to 18), with the one ineligible decision refused by name. Not a production-derived matrix (S1 owns that). |
| G2 Inputs          | verified for named evidence: every request passed the compiled worker's canonical snapshot and Phase 6 validation (0 of 182 rejected); population hashed and checked before every run; normalizations declared in the manifest.                                                                          |
| G3 Calculation     | verified for named evidence: per-decision continuation work counters and full candidate distributions in the digest; contrasting objectives and stack geometries exercise the actual computation.                                                                                                        |
| G4 Authority       | not applicable with reason: P8.1 changes no authority; shadow remains the default and the worker still rejects caller `candidate` (P8.3 owns authority).                                                                                                                                                 |
| G5 Actual use      | verified for named evidence at the compiled worker boundary (FAST path through `HorseDecisionWorkerRuntime`); controller acceptance and natural use are not applicable with reason here, because no runtime source changed and the policy remains shadow.                                                |
| G6 Outcomes        | verified for named evidence: in all six final runs eligible equals completed plus named refusals; no unknown reason; final-gate refusals 0 at moderate load and `budget_exhausted` plus the latch reported by name under contention.                                                                     |
| G7 Correctness     | verified for named evidence: 9 suites, 114 tests passed (Phase 8 tournament 64, league 13, future hand 13, ICM 12, replay 4, worker preparation 3, bounty continuation 2, equivalence 2, future preparation 1); type check and lint clean on changed files.                                              |
| G8 Work and replay | verified for named evidence on this Mac: frozen inputs, request-derived seeds, unchanged limits and sample counts, cold and warm fresh processes; not fleet latency.                                                                                                                                     |
| G9 Promotion       | not applicable with reason: P8.2 owns strength evidence; nothing here can promote.                                                                                                                                                                                                                       |
| G10 Publication    | not applicable with reason for the engine: no runtime source changed, so no engine release follows. The diagnostic, regression and evidence ship through the protected PR and merge.                                                                                                                     |

## Statement

P8.1 is complete within its stated limits. Current source completes 137 to 141 of 181 eligible decisions cold and 151 to 157 warm on this Mac, every remaining decision refused by name before firing at the 4 ms work deadline, with no final-gate refusal after firing at moderate host load. The only reproduced redundancy in the owned continuation path was optimized exactly, measured, and held because it did not raise completion. No budget, gate or limit was changed.

## x86 Useful Completion, October 2, 2026

Horse Brain only. Why Phase 8 barely completed on x86 Linux, what was fixed, and what remains. Machines: league host C (Hetzner ccx23, 4 dedicated vCPU AMD EPYC-Milan, Linux 6.8.0 x86_64, Node v26.10.0, clocksource `kvm-clock`, idle, 1-minute load 0.3 to 0.8 in every run below) and this development Mac (Apple M3 Ultra, Node v26.3.0, shared with other agents at 1-minute load 15 to 35). Same population as above: 182 frozen decisions, sha256 `a9732fd8…f317d`, 181 eligible. Before is `03bdd28344` (its Horse code is byte-identical to league source `216a383f`); after is `9b4d7b3f78`. No limit, sample count, ICM method, trial count, strategy, gate or seed changed. Evidence: [`evidence/phase8/phase8-x86-completion-hostc.json`](evidence/phase8/phase8-x86-completion-hostc.json), [`-mac.json`](evidence/phase8/phase8-x86-completion-mac.json), [`-profile-hostc.json`](evidence/phase8/phase8-x86-completion-profile-hostc.json) and [`-digest-hostc.json`](evidence/phase8/phase8-x86-completion-digest-hostc.json).

### Host C Before and After (Three Interleaved Fresh Processes Each)

| Run                 | Completed of eligible     | Named refusals among eligible                                                        | Eligible p99 / max (ms)                     | Policy max (ms)     |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------- |
| before, first cold  | 79 of 181                 | `continuation_operation_budget` 100, `continuation_sample_calibration` 2             | 4.480 / 4.685                               | 0.640               |
| before, cold 1 to 3 | 0 of 32, 0 of 32, 0 of 32 | `continuation_operation_budget` 31, `continuation_sample_calibration` 1, each        | 4.538, 4.152, 4.123                         | 0.627, 0.625, 0.600 |
| before, warm 1 to 3 | 0 of 0, 0 of 0, 0 of 32   | latched before the measured pass in two; 31 and 1 as above in the third              | 4.620 (third)                               | 0.080 (third)       |
| after, cold 1 to 3  | 115, 111, 108 of 181      | `continuation_operation_budget` 64, 68, 71; `continuation_sample_calibration` 2 each | 4.223 / 4.577, 4.261 / 4.412, 4.477 / 4.495 | 0.654, 0.670, 0.602 |
| after, warm 1 to 3  | 146, 138, 132 of 181      | `continuation_operation_budget` 33, 41, 47; `continuation_sample_calibration` 2 each | 4.157 / 4.159, 4.147 / 4.161, 4.301 / 4.593 | 0.179, 0.212, 0.196 |

Before, every one of the six interleaved processes (and the first warm process) latched the live Phase 8 safety gate `eligible_but_silent`: the population's first 32 eligible decisions (the four replay lines, the 19 MTT decisions with 17 or 18 field players and the first nine SNG decisions) all stopped at the work deadline, so Phase 8 was refused for the rest of each process. The one first cold process that did not latch completed 79 because one MTT decision completed at index 22. After, no process latched. In every run eligible equals completed plus named refusals, no final-gate refusal occurred after firing, and the 5 ms wall and 2 ms policy limits held; every refusal is a cooperative stop at the 4 ms work deadline. Work stops after, cold 1: future rollout 37, ICM 9, sample 18.

Full-work demand on host C, clock frozen, median of five per decision in one process (Phase 8 cost is `decide` with Phase 8 minus `decide` with Phase 8 off): before sum 679.3 and 683.7 ms, p50 3.553 and 3.487 ms, 116 and 119 decisions at or under 4 ms; after sum 515.1 ms, p50 2.652 ms, 156 at or under 4 ms.

### Mac Same-Commit Comparison (Contended Host)

| Run                 | Completed of eligible                                                                    | Named refusals among eligible (`continuation_operation_budget`; `budget_exhausted`) |
| ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| before, cold 1 to 3 | 114, 89, 121 of 181                                                                      | 63, 86, 54; 2, 4, 4                                                                 |
| after, cold 1 to 3  | 140, 137, 121 of 181                                                                     | 37, 36, 41; 2, 6, 17                                                                |
| before, warm 1 to 3 | 121, 140 of 181; third latched `repeated_budget_breach` after 68 eligible (36 completed) | 54, 39, 16; 4, 0, 15                                                                |
| after, warm 1 to 3  | 156, 167, 150 of 181                                                                     | 22, 12, 21; 1, 0, 8                                                                 |

`continuation_sample_calibration` 2 in every complete run. The Mac's wall-clock overruns (`budget_exhausted`) track its load from other agents (1-minute load 15 to 35 during these runs).

### Profile Finding

Phase 8 sampled time under `evaluateTournamentPostflop` on host C, all 182 decisions at full work (clock frozen, `--cpu-prof` at 50 microseconds): 926.1 ms before, 711.4 ms after. Before, inclusive: `simulateTournamentFutureHands` 411.8, `settleSample` 255.4, `simulateTournamentContinuation` 191.3, `calculatePots` 118.1, `calculateContestablePot` 102.4, the action ICM `estimate` wrapper 87.2, `prepareJointPots` 63.0, `IcmModel.estimate` 26.0. Suspects, ruled in or out by measurement:

- Ruled out: per-rollout hashing or RNG derivation. `createHash` is 5.7 ms in all, once per decision for the evidence receipt; the synthetic deal RNG is precomputed before readiness.
- Ruled out: the Plackett-Luce ICM recomputed per estimate. The 128-trial clocks are built once per action; per-vector estimates total 26.0 ms of 926.1.
- Ruled out: clock cost. `performance.now()` costs 51 to 54 ns on host C (vDSO `kvm-clock`) against 24 to 26 ns on the Mac; `now` is 6.4 ms of 585.0 ms of Phase 8 in a real-clock cold run.
- Ruled out as platform-specific: deoptimization. `--trace-deopt` shows a `prepareJointPots` "wrong map" deoptimization loop (143 on host C, 142 on the Mac, per 182 decisions); it is identical on both platforms and costs both.
- Ruled out as a code pathology: the "2 to 3 rollouts in 4 ms" pattern. In the `216a383f` matrix runs' recorded diagnostics the median refused decision did 56 to 116 rollouts; those matrices ran four league processes at once on host C's four vCPU (`/root/schedule.sh`), and the production engine host is saturated. In the idle 4-pair league smoke on host C the median refused decision did 96 rollouts before and 127 after.
- Ruled in: per-thread speed. The same full-work digest takes 3.51 s on host C and 1.93 s on the Mac (Phase 8 full-work sums 679 and 414 ms). There is no 10x code gap on an idle x86 host; the x86 core is about half the Mac core's speed on this code.
- Ruled in: redundant per-rollout and per-street bookkeeping in the owned continuation path, which is where the 4 ms went around the necessary arithmetic: each future hand filtered, mapped and sorted its seats and built Maps for starts, strengths and draws; every street copied and re-sorted already seat-ordered seats, spread a validation array, filtered live seats twice and rotated with slice/concat; every rollout formatted a long cache key per blind level; every settlement rebuilt its evidence map and re-sorted the same response order; the joint pot helper built two Sets and a sorted copy to find the top two contributions.

### The Fix

`HorseTournamentFutureHand.ts`, `HorseTournamentContinuation.ts`, `HorseTournamentUtility.ts` and `multiway/JointPotDistribution.ts` now do each of those once or read it in place, with the same values in the same order: seat order is read in place only when it already is the stable sort's result; one fact lookup per seat per hand; action order by index; one live pass per street with each seat's street strength; rollouts cached by settled local stacks, then by sample index and blind-level identity (equal level fields share one identity, as their formatted key did); one action-wide settlement plan (hero seat, response order, evidence map); and the joint pot helper finds the first-largest and next-largest contribution directly. `PokerEngine.calculatePots` (the canonical pot partition, financial owner) is unchanged.

### Exactness Proof

`phase8-useful-completion.mjs digest` (clock frozen at 0, every decision, distribution, utility moment, work counter and receipt): host C `7d1eb21d…c9fbf` before and after, 182 of 182 rows identical; Mac `e150e342…53012` before and after, 182 of 182 identical. The two machines differ from each other on row 177 alone, before and after alike (last-place floating differences in that decision's sample weights), so each machine is compared only with itself, as P8.1 already recorded for hosted CI. Suites: 14 files, 265 tests passed (Phase 8 tournament, replay, bounty continuation, future hand, future preparation, ICM, league, useful-completion equivalence, joint pot distribution, joint deductions, joint action model, joint live policy, responder pot, utility evidence); type check, eslint and prettier clean.

### League Smoke (Host C, MTT Seed 8101101, 4 Pairs, `--hydrate`)

| Tree   | Eligible | Fired | Completed | Refusals                           | p99 (ms) | Median refused work (rollouts; samples visited; candidates completed of 8) |
| ------ | -------- | ----- | --------- | ---------------------------------- | -------- | -------------------------------------------------------------------------- |
| before | 14       | 0     | 0         | `continuation_operation_budget` 14 | 4.316    | 96; 52; 3                                                                  |
| after  | 14       | 0     | 0         | `continuation_operation_budget` 14 | 4.915    | 127; 75; 4                                                                 |

### What Remains, and What It Would Take

The 17 and 18 player MTT decisions (eight to ten candidates, two blind-level bounds, 16 samples, 128-trial Plackett-Luce) still need more than 4 ms on host C: their full-work median is 3.675 ms after the fix, with 13 of 19 at or under 4 ms (before: 4.546 and 4.388 ms, 6 and 7 of 19), before any JIT-cold or real-clock overhead, and the league smoke's 14 decisions are JIT-cold in a fresh process. Measured options, none shipped:

- An allocation-light, digest-exact `PokerEngine.calculatePots` (element comparison instead of `JSON.stringify`, no Set) lowered the full-work sum from 515.1 to 477.6 ms (161 at or under 4 ms). It is the financial owner's canonical partition, outside this lane; the experiment lives only in the evidence archive.
- Everything else that would make those decisions complete changes results: fewer outcome samples, fewer ICM trials, a different ICM method or a larger work budget. None was done.

### Exact Commands

```text
# host C: ssh -o BatchMode=yes -i <hetzner_engine_key> root@5.161.232.126; trees at /root/p8x86/{base,fix}, each `npx tsc -p tsconfig.json` in server/
cd /root/p8x86/<tree>/server
node scripts/phase8-useful-completion.mjs run --population=../docs/evidence/phase8/phase8-useful-completion-population.json --pass=cold --revision=<sha> --out=<file>
node scripts/phase8-useful-completion.mjs run --population=../docs/evidence/phase8/phase8-useful-completion-population.json --pass=warm --revision=<sha> --out=<file>
node scripts/phase8-useful-completion.mjs digest --population=../docs/evidence/phase8/phase8-useful-completion-population.json --revision=<sha> --out=<file>
node --cpu-prof --cpu-prof-interval 50 scripts/phase8-useful-completion.mjs digest --population=../docs/evidence/phase8/phase8-useful-completion-population.json
node --trace-deopt scripts/phase8-useful-completion.mjs digest --population=../docs/evidence/phase8/phase8-useful-completion-population.json
/root/run-league.sh mtt 8101101 <outdir> --hydrate   # /opt/club-arena at 216a383f before, at 9b4d7b3f78 after, then restored to 216a383f
# Mac: the same run/digest commands from server/, before through P81_DIST=dist-before (the unchanged build) with node --preserve-symlinks
```

Interleaving on both machines per repetition: before cold, after cold, after warm, before warm. The full-work cost tool (`p8cost.mjs`), the clock-cost probe and the profile reducers are kept with the raw profiles in the evidence archive, `horse-brain-phase8-20261001/p8-x86/`.

### Gate Status for This Change

| Item                                  | Status                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Exact results (digest, both machines) | verified now                                                                                                                            |
| Host C useful completion and latch    | verified now on the frozen population: cold 108 to 115, warm 132 to 146 of 181, no latch (before: latched in every interleaved process) |
| League MTT completion on x86          | defective: 0 of 14 before and after in the 4-pair smoke; what it would take is stated above                                             |
| Production engine host completion     | implemented but unverified: this change reaches it only through an engine release, which the coordinator owns                           |
| P8.2 strength matrix                  | not applicable with reason: P8.2 owns strength evidence; the matrices need rerunning on one league process per host                     |
