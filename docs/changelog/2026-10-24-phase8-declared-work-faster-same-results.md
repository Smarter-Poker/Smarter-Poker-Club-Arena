# Phase 8 Declared Work, Faster, Same Results

**Date:** 2026-10-24

The Phase 8 tournament postflop continuation (`HorseTournamentPostflop.ts`) is shadow only. Its own
comment says it cannot pass the tournament league's latency gate (`latencyMs.p99 <=
PHASE8_POLICY.budgetMs`, 5 ms, `HorseTournamentLeague.tournamentRunCanPromote` and
`tournamentBaselineRunVerified`) "until its declared work or the gate is resized by a reviewed
change". This change does neither. The gate, `PHASE8_POLICY`, `CONTINUATION_POLICY`,
`FUTURE_HAND_POLICY`, every candidate, sample, rollout, ICM trial and receipt field are unchanged. It
makes the same declared work cheaper, and every decision's output is bit for bit the one before.

## Where The Time Went

CPU profile of the continuation (`continuePostflop`) replaying 1,038 eligible Spin decisions
captured from the league (four seeds, 12 pairs each, the full declared work, real clock):

| Share | Owner                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 37 %  | `settleSample`: settle every candidate x sample branch (`prepareJointPots`, `settleJointScores`, `calculatePots`, the responders' `calculateContestablePot`) |
| 32 %  | `simulateTournamentFutureHands`: one funded future hand per branch and blind-level bound (about 180 per decision; 184,320 over the corpus)                   |
| 13 %  | `simulateTournamentContinuation` inside both of the above                                                                                                    |
| 9 %   | `buildHorseTournamentUtilityEvidence`: the canonical input hash of the receipt                                                                               |
| 15 %  | garbage collection (process-wide), mostly per-branch seat copies and closures                                                                                |

Under `tsx` (how the league and its workflow run, `npx tsx src/scripts/horseTournamentEvaluate.ts`)
a further 15 % was esbuild's `keepNames` wrapper (`__name`) re-running for every per-call named
closure: `settleJointScores`' `award`/`order`, `settleSample`'s `commit`/`award`/`seatById`,
`optionValue`'s three pool helpers and `calculatePots`' `getInvestment`.

## What Changed

1. **A future hand nobody's stack bounded is replayed, not re-dealt**
   (`HorseTournamentFutureHand.ts`, `FutureHandTrace`). Of the corpus' 184,320 rollouts, 3,586
   (1.9 %) had any amount capped by a stack; the rest posted, opened, called, wagered, refunded and
   settled exactly the amounts the rules asked for. Such a hand's chip flows do not depend on the stacks
   it started from (pots, settlement, the response prices and every choice read contributions and
   the synthetic facts, never stacks). The first time such a hand is played for a (sample, button,
   level, seats) it records its operations and, per seat, the deepest stack any rule read; a later
   rollout of the same hand whose every seat is strictly deeper repeats the recorded additions and
   subtractions in the same order, so the result is the same bits. Anything else, any bound, any
   all-in, any bust, any optional deadline, plays the hand in full as before. On the corpus 143,063
   rollouts (78 %) were replayed, 39,325 were first plays of their hand and 1,932 failed the depth
   check and were played in full. The cache is
   decision-local (one per `evaluateWithWorkspace` call, beside the existing `futureDraws`).
   `simulateTournamentContinuation` gained an optional read-only `observeOwed` callback that reports
   the uncapped amount each seat is asked for; it changes nothing it observes.
2. **No per-call named closures on the settlement path**: the closures above became module
   functions with the same bodies (`commitBranchChips`, `awardBranchChips`, `branchSeatsById`,
   `branchStartOf`, `optionCostPct`/`optionPayoutAtPool`/`optionPayoutErrorAtPool`,
   `awardJointUnits`/`orderJointWinners`, `potInvestment`, `contestableCents`). Arithmetic and order
   are unchanged; `awardJointUnits` iterates the ordered winners with an index loop in place of
   `forEach`.

## Equivalence Proof

- **Corpus replay, old code against new.** 1,054 Phase 8 inputs (1,038 eligible) captured from
  `runTournamentLeague` Spin seeds 901791, 8101101, 8102203 and 8103307 (12 pairs each) were replayed
  through both builds: the Phase 7 utility result, the Phase 8 decision and the entire Phase 8
  ledger (everything but `latencyMs`, `simulationMs`, `policyMs`) hash to the same sha256 on both,
  for the reuse path (`continuePostflop`, the live path) and for a fresh evaluation:
  `f0b1fc8e...add33` (reuse, with the Phase 7 result) and `2425f7b1...24e7ab` (decision and ledger).
  An interleaved run comparing the two outputs decision by decision (below) found 0 differences.
- **Committed test**: `HorseTournamentFutureHandTrace.test.ts` runs more than 1,000 rollouts over
  two and three seats, both seat orders, every ante type, every button and random stacks from
  shorter than a blind to 300 big blinds, and requires the traced result to equal the full rollout
  bit for bit (`Object.is` on every number, key order included), that a trace is really replayed
  (more than 100 times), that a bounded hand is never recorded, and that no trace is used under an
  optional deadline.
- The existing Phase 7, Phase 8, future-hand, league, Phase 13 joint-settlement and policy-digest
  suites pass unchanged (38 files, 593 tests).

## Cost, Before And After

Hardware: cloud Linux VM, Intel Xeon @ 2.80 GHz, 2 vCPU, 8 GB, Node 22.23.4. The VM is shared with
other agents' work, so absolute wall times move with their load; each figure says what the load was.
Corpus: the 1,038 eligible captured decisions above, three timed passes after one warm-up (3,114
decisions per arm, 2,076 in the interleaved run).

| Run                                                    | Load avg  | Arm | p50 ms | p90 ms | p99 ms | max ms |
| ------------------------------------------------------ | --------- | --- | ------ | ------ | ------ | ------ |
| Compiled (`tsc` emit, as the engine image), sequential | about 2.5 | old | 3.81   | 6.18   | 9.71   | 63.1   |
|                                                        |           | new | 3.04   | 5.39   | 8.62   | 137.7  |
| `tsx` (as the league workflow runs), sequential        | about 2.5 | old | 6.41   | 11.89  | 23.47  | 174.9  |
|                                                        |           | new | 4.28   | 9.26   | 19.93  | 381.1  |
| Compiled, old and new interleaved per decision, CPU ms | about 12  | old | 3.96   | 6.63   | 10.22  | 50.3   |
|                                                        |           | new | 3.32   | 5.74   | 9.05   | (a)    |
| Same run, wall ms (`ledger.latencyMs`)                 | about 12  | old | 12.39  | 26.05  | 52.35  | 218.4  |
|                                                        |           | new | 11.15  | 23.10  | 51.19  | (a)    |

(a) One decision was descheduled for 13.7 s wall (2.9 s CPU) by the other load on the VM; the max of
that arm is not a property of the code.

So the same work costs about 15 to 20 % less CPU at the median and 10 to 15 % less at p99 on compiled
code, and about a third less at the median under `tsx`. That is real but not enough: on this
hardware p99 is still about 9 ms compiled and about 20 ms under `tsx`, against the 5 ms gate.

## Still Blocking Promotion

The gate is `latencyMs.p99 <= 5 ms` on a league run, and the declared work still takes longer than
that at the tail on this hardware (see above). More speed on the same work is possible (the receipt's
canonical input hash, about 9 %, is recomputed for every continuation; the per-branch seat copies in
`settleSample` dominate what is left), but speed is not the only blocker. Promotion
(`tournamentRunCanPromote`) also requires, per objective and promotion seed, a held-out 1,024-pair
run in `candidate` mode with a positive 99 % paired interval and `changed > 0`. Phase 8 has no
selection of its own beyond the Phase 7 utility's argmax under its own confidence rule, and no
tournament outcome model: every future-hand rollout is the declared one-wager-per-street population,
not a measured opponent model, and table-break and blind-transition probabilities are explicitly
`unavailable`. Tables of 5 to 9 seats stay refused by name (`future_hand_seats_outside_work_budget`,
`maxFutureHandSeats` 3). Phase 8 is not switched live by this change.

## Policy Digests

`HorseTournamentUtility.ts`, `PokerEngine.ts` and `multiway/JointPotDistribution.ts` are hashed into
the Phase 10 to 13 policy digests, so those digests move with these bytes. No pack is selected in
any phase today (every `*_PROTECTED_RELEASE_SELECTIONS` is null), so no live selection is affected;
a future qualification records the new digest. The Phase 8 digest (`horsePhase8PolicyDigest`, over
`PHASE8_POLICY` and `CONTINUATION_POLICY`) does not move.
