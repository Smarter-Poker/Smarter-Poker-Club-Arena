# Horse Brain Phase 13, P13-A: the bounded joint response tree, October 6, 2026

Horse Brain only. This record covers package P13-A of the [maintained completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md#phase-13--joint-response-and-economic-depth): extend the expressly limited joint response model with one bounded legal opponent raise, hero's answer to it, and a bounded turn to river continuation, version the response pack, keep the one-response model as a named comparison identity, fix explicit work and branch limits, and never return a partially ranked action set. It uses the maintained gate vocabulary (verified now / implemented but unverified / defective / unavailable external input / not applicable with reason). Nothing is averaged into a percentage.

**Everything stays shadow and offline.** No protected release selection changed, the live worker still refuses a caller's `phase13Joint: 'candidate'`, and no live decision can be changed by this package. The response pack is an explicit heuristic (`calibratedConfidence: null`). Nothing here claims calibration, a solver input or strength.

## Delivery and exact source

| Item           | Identity                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch         | `agent/claude-horse-brain/phase13-b-20261006`, based on `origin/main` `22efa996`. Not pushed                                                                                                                                                                                                                             |
| Owners changed | `multiway/JointActionModel.ts` (pack identities, dispatch, round 1 kept intact), new `multiway/JointActionShared.ts` (round 1 helpers moved unchanged), new `multiway/JointStreetBetting.ts` (street state replica and the one bounded wager), new `multiway/JointResponseTree.ts` (the round 2 tree)                    |
| Tests          | new `JointStreetBetting.test.ts`, new `JointResponseTree.test.ts`, extended `JointActionModel.test.ts` and `JointHorseLogic.test.ts`                                                                                                                                                                                     |
| Not touched    | `JointLivePolicy.ts`, `JointSampleAcquisition.ts` (`JOINT_LIVE_DOMAIN` stays `joint-multiway-round1-v3`; the v4 bump belongs to P13.1), `JointRangeSampler.ts`, `JointPotDistribution.ts`, `JointDeductions.ts`, `HorseLogic.ts`, `HandController.ts`, every worker, witness, review, validation, client and ledger file |
| Checks run     | `tsc --noEmit -p .` in `server/` (exit 0); prettier and eslint on every changed file (clean); the suites listed under Tests                                                                                                                                                                                              |

## The model

`JOINT_ACTION_PACK.version` is `joint-action-response-round2-v1`. The one-response model is exported unchanged as `JOINT_ACTION_PACK_ROUND1` (`joint-action-response-round1-v2`) and is callable as `evaluateJointActions(hero, state, baseline, evidence, withinBudget, { responseModel: 'round1' })`. The exported signature is otherwise unchanged; the options argument is optional and last.

**Streets.** The tree runs on turn and river decisions (`raiseStreets`). Preflop and flop decisions keep the one-response-then-showdown computation under the round 2 version, with `responseModel: 'one_response_then_showdown'` and `responseTree: null` on every row, and are identical in every number to the comparison identity. A preflop or flop full-game solution is not implied.

**Initial responses.** For each candidate and each joint sample, opponents respond clockwise from hero exactly as in round 1 (the same seats, the same `jointCallProbability`, the same contestable pot through `calculateContestablePot`). Each responder facing a price folds, calls (all in when the call covers its stack) or makes the one bounded raise.

**The one raise.** Its size comes from the horses' own candidate builder (`buildTournamentActionCandidates`) over the responder's authoritative menu: a pot-sized raise under the structure's cap in no limit and pot limit, the fixed increment in fixed limit, and the builder's canonical all in when the stack is short of that. Its probability is `jointCallProbability x jointRaiseShare`, where `jointRaiseShare` reads present-board strength, the price and the public line only, capped at 0.6. It is a declared, uncalibrated heuristic.

**Branch weighting.** The raise branch is enumerated with its exact probability weight. Fold versus call on the no-raise path keeps round 1's deterministic local draw, now conditioned on not raising, so a responder with no raise option behaves exactly as in round 1. Within one sample the branch weights sum to one; the code throws `joint_response_branch_mass` otherwise.

**After the raise.** Every seat still owing chips answers once, clockwise from the raiser: later responders, then hero, then earlier responders. Nobody raises again (`raisesPerTree: 1`). Opponents answer with `jointCallProbability` at the new price and a separate local draw. Hero answers by a declared rule: call (all in when the call covers its stack) when its heads-up showdown share against the raiser, weighted by that raiser's raise probability over the same joint samples, covers the pot odds against the contestable pot. That share is one value shared by every sample, so a sample's own runout never decides its own branch. On the river every card is known, so this is present equity; on the turn it is the joint samples' equity over river cards.

**Reopening.** A full raise reopens raise rights to a seat that already acted; a short all-in does not. Players who already acted still answer a short all-in once (fold or call), as the controller requires. Fixed limit counts wagers to the four-wager cap. These rules come from `JointStreetBetting.ts`, which replicates `HandController.buildBettingState`, `canReopenBetting`, `clampToStructure`, `getAvailableActions`, `getAuthoritativeActionState` and the `performAction` mutation. The controller methods are private, so the module is a replica; its parity test drives a real `HandController` and requires the replica's menu, bounds and reopening right to equal the controller's at every post-flop decision.

**Turn to river.** On a turn decision every terminal branch with two or more players able to bet continues into one river round. The river cards are the ones already dealt in the same physical joint sample. The first live player, clockwise from the button, whose river strength reaches 0.31 makes one pot-sized bet (the big bet in fixed limit) through the same builder; every other seat still owing answers once, calling when its strength reaches `0.1 + 0.6 x price share`. River strength reads only the player's own made-hand category and low qualification on the river boards as they then exist. Bomb hands keep the existing joint layout: one physical deal supplies every board.

**Settlement.** Every terminal branch settles through `prepareJointPots`, `settleJointScores` and `applyJointDeductions` and must conserve chips (`joint_action_conservation` otherwise). Expected net chips are the probability-weighted mean over all terminal branches; the standard error is taken over per-sample expectations; variance, board means, covariance, rake and jackpot expectations are probability weighted; the minimum and maximum run over every reachable terminal branch.

**Limits.** `maxRaiseBranchOpponents: 1` (the raise slot goes to the first responder, clockwise from hero, with a positive raise probability and a legal bounded raise; later positive-probability responders are counted as `raiseLimitedResponders`), `maxTerminalBranchesPerCandidate: 32` (16 live samples times two), one river round. A folded hero gets no raise branch, because its result cannot depend on one. A candidate needing more terminal branches throws `joint_response_branch_unavailable`; the deadline falling anywhere in the tree returns null, which the wrapper already reports as `work_budget`. Samples are never reduced.

**Result fields.** Each row keeps every round 1 field. `responseCounts` gains `raiseProbability`, `meanRaiseShare`, `facedRaise` and `calledRaise`. A new `responseTree` carries `street`, `terminalBranches`, `raiseBranches`, `raiseProbability`, `heroCallsRaiseProbability`, `heroFoldsToRaiseProbability`, `heroRaiseEquity`, `raiseTo`, `raiseIsFull`, `raiseLimitedResponders`, `riverRoundProbability`, `riverBetProbability` and `heroFacedRiverBetProbability`. The result carries `responseModel`.

## Gates

| Gate                                                           | State                      | Evidence                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STEP 1 river, single contested pot, NLH and PLO4               | verified now               | Hand-built expected chips equal the model to nine decimals (NLH pot-sized raise to 80; PLO4 full all-in raise to 50)                                                                                                                  |
| STEP 2 side pots, split games, fixed limit, remaining variants | verified now               | Hand-built three-way side pot with an independent pot reference; PLO8 high/low split; fixed-limit increment and cap; all nine variants, turn and river, one to three boards, cash and tournament units, conserved with forced raisers |
| STEP 3 turn to river continuation                              | verified now               | Turn responses are identical when only river scores change; the river round checks down on weak river boards and bets and is called on strong ones, with hand-computed chips                                                          |
| STEP 4 explicit work limits                                    | verified now               | Limit pinned; a 32-sample pool throws `joint_response_branch_unavailable`; deadline interruption at every third check point returns null                                                                                              |
| Four-millisecond wrapper at maximum table sizes                | unavailable external input | Measured below on this shared container, where round 1 alone already exceeds the budget for most variants. Qualification on the engine host is P13-C                                                                                  |
| Authoritative raise semantics                                  | verified now               | Controller parity on 600 generated post-flop hands across NLH, PLO4, FLH, FLO8 and Short Deck                                                                                                                                         |
| Calibrated response distribution                               | not applicable with reason | The pack is a declared heuristic; calibration is not part of P13-A                                                                                                                                                                    |
| Live selection                                                 | not applicable with reason | Phase 13 stays shadow; nothing here selects                                                                                                                                                                                           |

## Defect found and fixed during the build

The first `jointOneWager` accepted the builder's `jam` whenever it appeared. On a capped fixed-limit street the controller's menu still lists `all_in`, but executes it as a call, so the tree modeled a "raise" to the standing bet. The fixed-limit cap test failed on that source with `raiseBranches: 16`, `raiseTo: { p1: [16] }`, `raiseIsFull: { p1: false }` for hero's capping raise. The jam is now accepted only when the clamped all-in actually wagers, and the parity test now also requires every bounded wager to be recorded by the controller as a bet, raise or all-in above the standing bet. Reinstating the defect fails the cap test and both fixed-limit parity tests.

## Tests

`JointStreetBetting.test.ts` (5), `JointResponseTree.test.ts` (23), `JointActionModel.test.ts` (25, one new), `JointHorseLogic.test.ts` (25, eight new). The whole `multiway/` directory passes 219 tests in 12 files. Direct consumers pass unchanged: `horseDecision/responseValidation.test.ts`, `horseDecision/client.test.ts` and `services/horseDecisionJournal/review.test.ts` (362), `horseDecision/workerRuntime.test.ts` (246) and `benchmark/JointPolicyLeague.test.ts` (58, all 57 profiles conserved, legal and deterministic).

The retained round 1 identity was checked against `origin/main`'s `JointActionModel.ts` on 216 states (nine variants, four streets, one to three boards, both units): identical results with `responseModel: 'round1'`, and identical numbers from the round 2 default on preflop and flop. That one-off comparison is not kept as a file because it needs the old source; the kept test pins round 2 against round 1 on preflop and flop.

Mutation checks, each applied alone and reverted:

| Mutation                                        | Failing tests                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| No raise branch (raise probability forced to 0) | 20, including every hand-built settlement, reopening, cap, ring order and HorseLogic |
| Reopening always granted                        | 6: full versus short raise and all five controller parity tests                      |
| A full raise never reopens an acted seat        | 7: full versus short, the fixed-limit cap and all five parity tests                  |
| Fixed-limit cap ignored                         | 3: the cap test and both fixed-limit parity tests                                    |
| Hero always folds to the raise                  | 5: the four hand-built settlements and the joint downside test                       |
| River round removed                             | 1: the continuation test                                                             |
| No deadline check inside raise branches         | 1: the no-partial-ranking test                                                       |
| A capped all-in counted as a raise              | 3: the cap test and both fixed-limit parity tests                                    |

## Timing at maximum table sizes

Measured October 6 on this shared two-CPU container under `tsx`, other agents running suites concurrently, 20 timed repetitions after 10 warm-up runs, cash, one to three boards, turn and river. "Natural" uses the sampler's own scores; "forced raisers" sets every responder's present-board strength to 0.96 so every sample has a raise branch. The wrapper column runs `evaluateJointLivePolicy` with the real clock.

| Variant    | Seats | Sampling P50 (ms) | Round 1 accounting P50 | Round 2 accounting P50, natural | Round 2, forced raisers | Ratio natural (median) | Ratio forced (max) | Wrapper runs completed |
| ---------- | ----- | ----------------- | ---------------------- | ------------------------------- | ----------------------- | ---------------------- | ------------------ | ---------------------- |
| nlh        | 9     | 0.72 to 1.35      | 4.03 to 5.43           | 4.13 to 6.90                    | 8.81 to 13.22           | 1.28                   | 2.69               | 0 of 120               |
| plo4       | 8     | 1.49 to 2.75      | 2.52 to 3.03           | 3.62 to 5.79                    | 5.49 to 8.42            | 1.49                   | 3.29               | 0 of 120               |
| plo5       | 7     | 1.71 to 3.50      | 2.09 to 2.54           | 3.19 to 5.48                    | 4.56 to 7.48            | 1.93                   | 3.17               | 0 of 120               |
| plo6       | 6     | 2.01 to 4.17      | 1.82 to 2.18           | 2.41 to 3.80                    | 4.27 to 6.50            | 1.59                   | 3.32               | 0 of 120               |
| plo8       | 8     | 1.64 to 3.39      | 2.49 to 3.10           | 4.15 to 5.59                    | 5.69 to 9.18            | 1.73                   | 3.16               | 0 of 120               |
| flo8       | 8     | 1.56 to 5.22      | 0.79 to 1.41           | 1.37 to 2.09                    | 1.39 to 3.31            | 1.67                   | 4.21               | 29 of 120              |
| flh        | 9     | 0.72 to 1.13      | 0.85 to 1.72           | 0.92 to 1.44                    | 1.60 to 6.89            | 1.47                   | 4.00               | 112 of 120             |
| pineapple  | 9     | 2.59 to 6.66      | 3.93 to 6.47           | 5.49 to 15.55                   | 8.19 to 12.28           | 1.31                   | 2.91               | 0 of 120               |
| short_deck | 9     | 0.71 to 1.19      | 3.80 to 4.66           | 5.00 to 6.18                    | 7.99 to 12.57           | 1.36                   | 2.79               | 0 of 120               |

Wrapper runs that did not complete ended as `work_budget` or the sampler's existing `insufficient_joint_samples` refusal, never as a partial ranking. On this container round 1 alone (sampling plus round 1 accounting) already exceeds four milliseconds for every variant except the two fixed-limit games, so these numbers cannot qualify either model; the round 1 record reports its own real-clock probe firing inside the budget on its measurement host. The measured cost of round 2 relative to round 1 is a median of 1.3 to 1.9 on natural samples and at most 4.2 when every sample carries a raise branch and a river round. The single raise slot was chosen from these measurements: two slots measured 2.9 times round 1 at four seats and 2.7 times at nine with forced raisers, against 1.8 with one slot at nine. Expect more `work_budget` refusals than round 1 at maximum tables until P13-C measures and qualifies the tree on the engine host.

## What the receipt should copy (for P13.1)

`JointLivePolicy` already embeds the whole result as `receipt.actionModel`, so every new field reaches the receipt without code. For natural proof the receipt should also carry, as first-class fields: `actionModel.version` (the response identity), `actionModel.responseModel`, `JOINT_ACTION_PACK.limits`, and for the ranked first candidate `responseTree.terminalBranches`, `raiseBranches`, `raiseProbability`, `heroCallsRaiseProbability`, `heroFoldsToRaiseProbability`, `raiseLimitedResponders`, `riverRoundProbability` and `riverBetProbability`. The existing `catch` already turns the new named refusals into `receipt.reason` (`joint_response_branch_unavailable`, `joint_response_street_unavailable`, `joint_response_illegal_simulated_action`, `joint_response_branch_mass`, `joint_response_street_not_modeled`); worker response validation and the data ledger should admit them and the new `responseTree` and `responseCounts` fields.

## Left open

- Engine-host timing qualification under the live budgets: unavailable external input, P13-C.
- Fold versus call keeps a deterministic draw per sample; only the raise branch is exactly weighted.
- On the river, a hero check ends at showdown (opponents do not bet behind); on the turn, the check line gets the river round.
- One raise slot per sample: a later responder with a higher raise probability is counted, not modeled.
- The betting replica must follow any future controller change; the parity test fails if it does not.
- The cross-phase read slice (captured scoped response information) is not part of this package.
