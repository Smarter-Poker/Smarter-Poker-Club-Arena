# Phase Two Cash Conservation And Rules

Status: in progress; no phase completion or deployment claim.

This is phase 2 of the user's 118-item, 12-phase execution mapping, not the older parallel programme's phase counter. Baseline: eeb5ced46bfe41396c0624c1960e133cfc5ceadf. Owner: Codex.

## Confirmed Amount Boundary Defect

The real HandController accepted 6.001, 6.005 and 6.009 as raise-to amounts, and accepted the string '6'. The shared validator also accepted fractional opening bets and numeric strings. Seven new cases failed before the correction; nine existing-valid/invalid expectations passed. Independent stack/pot snapshots require a rejected action to leave every monetary field and action count unchanged.

The shared validator now rejects nonnumeric, nonfinite, unsafe and genuine sub-cent bet/raise amounts before mutation. IEEE representation noise is tolerated at 1e-9 chips, far below one cent. No rounding repair, watcher or reconciler is introduced.

## Remaining Phase Scope

Departure ordering, occupancy-bound cashout identity, seat/escrow ownership, legal actions, short-all-in reopening, side pots, odd chips, blinds/position, every configured variant, RNG/card privacy, showdown/muck, bomb pots/runouts and decision timers still need their complete recorded acceptance evidence. Existing departure/PostgreSQL fixes on main are being reused and reverified, not counted as new work.

Rule comparison sources checked September 8, 2026: Poker TDA rule 47 and its cumulative-all-in examples (https://www.pokertda.com/view-poker-tda-rules/), and PokerStars' betting/side-pot rules (https://www.pokerstars.com/help/articles/poker-rules-master/217459/). These are rule benchmarks, not fairness certification. Preliminary reopening findings remain under behavioral verification.

## Reopening Corrections

Four behavioral cases failed before correction: a prior caller could bypass closed raising rights by choosing all-in; cumulative short all-ins did not reopen for a player facing a full increment; an intervening caller could also bypass the rule; and a short all-in expressed as raise was tagged as a full raise. The controller now enforces the same rule for the menu and execution, measures cumulative increments relative to each player's wager, and records full-raise status from the actual increment. Betting-round and fixed-limit wager counting consume that status consistently. Calls for the remaining stack stay legal in both no-limit and pot-limit.

After the first corrections, 101 focused tests passed, including the 11,000-hand randomized conservation corpus. Additional short-stack no-limit/pot-limit coverage and the full server suite remain part of the release gate. Fixed-limit half-bet policy, cashout occupancy identity and the other listed phase surfaces are not declared complete.

Full server verification: 569 test files passed; 7,646 tests passed. The six opt-in departure PostgreSQL cases were run separately using the socket-only disposable database. Server TypeScript passed. These results validate this correction batch, not completion of all phase 2 acceptance items.

## Browser Departure Follow-Up

Continuation baseline ba8804f91. PR #3853 merged as 6f11ed3f7337766543ed68e87de58e4f17e4f6c8; the observed running engine version ad6342df is a descendant. This verifies adoption of the first correction batch, not all phase scope.

Fifteen new browser-service cases failed before correction. The fallback ignored the cashout receipt's success and shape, returned and recorded the stale seat-read stack instead of the committed cashout amount, treated a seat already removed by the acknowledged engine as failure, and reported tournament sit-out chips as cashed out.

The browser now requires a successful, correctly typed, matching-seat cash receipt or explicit confirmed absence. It reports the locked transaction's amount. An engine-owned amount remains null/pending in activity records, and a tournament sit-out records zero cash returned. An acknowledged departure with no remaining active seat returns deferred success without another debit or credit. The server receipt boundary also rejects fractional-smallest-unit amounts. Live schema verification confirmed table_activity.chips_cashed_out is nullable.

The focused client set passed 78 tests; TypeScript passed. Server receipt and departure regressions are verified separately. Occupancy-bound request identity across seat reuse remains open and must not be mistaken for this receipt-validation fix.
