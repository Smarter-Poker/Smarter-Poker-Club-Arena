# Phase 2 Poker Rules And Fairness Audit

Status: in progress. Club Arena only. This is the twelve-phase poker-room audit, not another accounting or Diamond Arena program. World Hub and Bots, Horses And Real-Time Assistance feature/policy work remain excluded.

## Baseline And Prior Closure

Source baseline: ba8804f916cc3b057d076e0c6a83a42d2ffca66d. Phase 1 closed after PR #3840 merged eeb5ced46bfe41396c0624c1960e133cfc5ceadf. Final CI34260688307 passed 7621 server tests/567 files plus 92 preliminary tests; six opt-in PostgreSQL cases passed separately. Five evidence/probe files exactly matched branch, merge and main. September 8 19:01 UTC frontends both served95b11188d7ce4e9b33b71bb0a218e3544724920c; engine6f11ed3f7337766543ed68e87de58e4f17e4f6c8 contained all Phase1 merges, its six production files exactly matched verified corrections, and 251/251 tables resumed with zero stalled tables. Normal deploy34264479798 confirmed actual image and independent engine_leader witness. Those facts close Phase1 only.

## Dated Benchmark

Reviewed September 8, 2026: https://www.pokertda.com/view-poker-tda-rules/ (published 2024 rules, rule47). No-limit/pot-limit reopening requires a full increment measured for each player; fixed-limit requires half a street bet. Tournament TDA guidance is a named comparator, not blanket certification of all cash house rules. Fixed-limit cap/completion conventions require their own review.

Also identified official Omaha rules: https://www.pokerstars.com/poker/games/omaha/ and /poker/games/omaha/5-card/ and /poker/games/omaha/6-card/. The two-hole/three-board requirement is the evaluator benchmark. Evaluator certification has not been completed.

## Confirmed Correction: C03 / BX03 Fixed-limit Reopening

HandController.canReopenBetting excluded fixed-limit from wager-faced reopening, treating every below-full increment as non-reopening. New real-controller regression cases failed at and above half a small bet for both flh and flo8 (4 failed,14 passed before correction). The shared function now derives the threshold from half the fixed street bet for limit, retaining full-increment thresholds for no-limit/pot-limit. Both TURN_CHANGE action menus and performAction enforcement call this function. No new route, database writer or feature flag is involved.

After correction:64 tests passed across HandController.reopening.test.ts and FixedLimit.test.ts; server TypeScript passed. Fourteen new cases cover below/at/above half a small bet, below/at/above half a big turn bet, unacted players, and intervening callers who must not inherit another player's rights, for flh and flo8. Existing no-limit and capped-limit tests remain passing. Broader push gates, automated merge and deployment remain separate obligations. This is not a completed C03 audit of every limit completion/cap interaction.

## Open Review Findings

- Omaha high evaluator has a fewer-than-four-hole-card fallback that invokes Holdem evaluation. Trace all callers and define malformed-state handling before changing; valid 4/5/6-card evaluations need an independent oracle.
- Fixed-limit partial wager completion and how partial wagers count toward the house cap need separate boundary fixtures. Do not equate the reopening correction with full cap/completion coverage.
- Independent RNG/evaluator certification evidence has not yet been located. Ordinary unit tests and random statistical samples are not external certification.

## Requirement Register

All entries below remain pending full review; partial evidence above must not become an overall pass.

| ID   | Requirement                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W08  | Handle partial antes/blinds without negative stacks or lost pot eligibility. Test several differently short stacks together.                                                          |
| C01  | Validate legal actions and acting player on the server with hand/action versions. Reject stale, duplicated and out-of-turn actions.                                                   |
| C02  | Certify Holdem and each Omaha hand evaluator against an independent oracle, including exactly two Omaha hole cards.                                                                   |
| C03  | Certify minimum raises, cumulative short-all-in reopening and unacted players. Cover no-limit, pot-limit and fixed-limit separately.                                                  |
| C04  | Compute pot-limit maximum from the pot, outstanding bets and call. Compare server acceptance with displayed maximum.                                                                  |
| C05  | Return unmatched bets before rake and award calculations. Uncalled chips never become contributed rake or a side pot.                                                                 |
| C06  | Construct main/side pots from contribution caps, retaining folded dead money but excluding folded players from winning.                                                               |
| C07  | Apply exact tie/odd-chip rules independently to each pot. Test three-way ties, fractional splits and heads-up transitions.                                                            |
| C08  | Define show/muck order and winning-hand display. All shown best-five cards must match the evaluator and hand record.                                                                  |
| C09  | Apply the correct dealer/blind convention after departures and heads-up transition. Verify it is the published cash rule.                                                             |
| C10  | Separate showdown evaluation from payout presentation. A cancelled browser animation cannot cancel or repeat a financial award.                                                       |
| G01  | Protect deck entropy, RNG state and unrevealed cards from clients, observers, staff tools and logs. Test recipient-level payloads.                                                    |
| G02  | Validate shuffle uniformity and unpredictability with appropriate independent testing. Never use predictable game-outcome randomness.                                                 |
| BX01 | Hand fixture A100, B250, C400 folded, D500 creates pots 400/450/300 and a 100 uncalled return; if A wins then B, awards are A400/B450/D300 before deductions.                         |
| BX03 | Test short all-ins below, at and above reopening thresholds separately for previously acted and unacted seats.                                                                        |
| BX04 | Run multiple boards with several side pots and indivisible units: fixed eligibility, deterministic residuals and exact contribution conservation.                                     |
| BX05 | Late RIT consent cannot change the run count after any additional card is disclosed.                                                                                                  |
| CX11 | Map test/certification evidence to exact deployed RNG, evaluator, payout, platform and client versions; fairness-affecting changes receive required external review where applicable. |

## C07 / BX04: High-low Splits Must Use The Hand's Chip Unit

The high/low split was performed in cents before distributePot divided each half into whole tournament chips. Odd whole-chip pots therefore became two fractional halves. This was distinct from the earlier tie-split correction and survived it. Fourteen direct evaluator/award cases reproduced12 failures and2 cash passes before correction. The high/low partition now uses the same chip unit as tied-winner distribution, giving the odd unit to high and preserving any pre-existing legacy sub-unit residue without creation or loss. Cash remains cent-based.

Dated comparator: Poker TDA2024 rules20(C) and21, checked September8,2026 at https://www.pokertda.com/view-poker-tda-rules/ . High receives the odd unit; each side pot is split separately. This is a scoped comparison, not certification.

After correction,90 tests passed across high/low awards, tournament indivisibility, fixed-limit, run-it-twice parity and showdown rules. Two additional complete HandController cases then passed (16/16 in the new test file), driving plo8/flo8 from blinds through checked river. A nine-chip pot is awarded high1=2,high2=3,low=4; emitted awards match applied stacks, starting300 chips remain300, and exactly one HAND_COMPLETE emits. Server TypeScript passed. Production HandController passes the tournament unit through normal, multiple-board and recovery calls to determineWinners. No client animation or database mutation controls the calculation.

The preceding fixed-limit correction merged as PR#3868,7dc9863f615d884759381343021e1bf80aef769c; normal push gates passed3014 related tests/235 files (six opt-in DB tests skipped). Its deployed runtime is still a separate check. This high/low correction needs its own normal push,CI,merge and runtime proof. Phase2 remains incomplete; no remaining requirement is silently marked done.

## C02 / BX01: Independent Differential And Exact Contribution Fixtures

Phase2EvaluatorOracle.test.ts adds an independently constructed rank-count/bitmask oracle, with no production evaluator/rank table/shuffle/combination helper used to calculate expected results. A deterministic test-only card corpus compares2500 high hands across Holdem,Short Deck and4/5/6-card Omaha (1250 head-to-head comparisons), plus1000 Omaha eight-or-better low hands. It checks selected best-five cards, ranking category, winner order, Omaha two-hole-card use, low qualification and ace-low ordering. All6 test groups passed,server TypeScript passed. This is internal differential sample evidence, not exhaustive or external certification. Fixed-limit Holdem shares the Holdem evaluator; plo8/flo8 share the four-card Omaha high/low routines. Pineapple must resolve its discard before the two-card evaluator applies; that routing remains separately reviewed.

Phase2SidePotFixture.test.ts drives the exact originalBX01 requirement through real legal HandController actions: D raises100,A all-in100,B all-in250,C raises400,D all-in500,C folds. The engine returns100 once before runout, constructs400/450/300 pots with correct eligibility, and a fixed legal board awardsA400/B450/D300 before deductions. A second return attempt changes nothing. Final stacks400/450/200/400 preserve starting1450; one return and one hand-complete event emit. The test and server TypeScript passed. No database or live wallet was touched.

High/low correction PR#3869 mergedb0dff82dd768e3c80c4dade7e24e327c15f8944e onSeptember8 at21:20:42UTC. Fixed-limit PR#3868 merged7dc9863f615d884759381343021e1bf80aef769c. Engine adoption of both remains a pending normal-release gate. New oracle/fixture evidence needs its own normal push/CI/merge. The18 Phase2 requirements remain a full coverage obligation; these passing cases do not certify the whole phase.

## C01: Bind HTTP actions to the displayed decision

Source review found that `handlers/action.ts` forwarded only user, action and amount; `ServerTableEngineTurns.handlePlayerAction` checked the current seat but not the decision the request originated from. The 60-second idempotency cache cannot identify a first delayed delivery or a replay after eviction. Both TablePage and MultiTablePage currently send no hand/turn context.

Correction in progress: publish an opaque controller-incarnation and action-state context on the discrete turn event and reconciliation snapshot. Carry that exact displayed context through each HTTP retry and compare it synchronously before action side effects. Internal engine actions keep their existing trusted call path. Missing context from an old browser must be rejected with an explicit reload instruction rather than silently applied to whichever hand is current. This is a request rejection, not a table or wallet lock. Deployment skew must be tested and reported.

C01 regression: the initial real-hand dispatch tests produced 2 failures and 1 pass because obsolete/missing contexts still applied raises. After correction, 12 decision-context tests plus 29 existing HTTP/idempotency tests pass. Client retry and mapper coverage passed 51 tests before the final legacy-envelope case. Both TypeScript projects passed. The Vite compilation completed, but the build provenance gate correctly rejected a branch three commits behind main; refresh/rebase and a complete rebuild remain required before publication.

The normal HTTP route now passes null explicitly for missing context, which the engine rejects before mutation; internal in-process calls remain distinct. Legacy clients parse only HTTP 200, so the reload rejection uses HTTP 200 with success:false. Current clients also preserve structured HTTP 400 rejection details. A late optimistic rollback cannot overwrite a different hand/decision. Discrete turn delivery is fenced before and after asynchronous broadcast so an old event cannot acquire the new decision's token. No live wallet/browser action has been performed as a test. Full C01 acceptance and Phase 2 closure remain pending production and broader audit evidence.

Earlier batches verified through GitHub Actions: #3868 CI34278919871 success; #3869 CI34279750557 success; evaluator/side-pot #3873 CI34280732337 success and automatic merge September8 21:31:23UTC. Fresh 21:35UTC frontend origin and routed stamps agreed on 07adeabfc4556def907ef2e6a54fb8ec3180d3e3. This is not proof that the current engine contains these changes.
