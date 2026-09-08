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

## Database Amount Boundary Review (in progress)

Source reviewed: atomic_seat_cashout_locked in 20260906152756, lines 83-169. It reads a nullable stack using COALESCE(..., 0), does not reject negative, non-finite or fractional-cent cash values, and can credit/exit before a caller rejects the receipt. Planned correction: refuse invalid cash amounts before every financial write; refuse a missing table context. Preserve the existing advisory -> game -> seat lock order and all journal/session writes in one transaction. No new repair process.

A socket-only PostgreSQL probe also reproduced a distinct occupancy retry defect against function MD5 0b4260da309101634851da9c63df5180: cash out 25, legitimately rejoin seat 2 with 40, replay the old three-argument request; the second occupancy was closed and credited 40. Conservation alone did not detect this wrong-session operation. That issue remains OPEN. Browser, engine and six installed SQL callers require a coordinated occupancy/request contract and legacy-path retirement. No production balances were changed by these probes.

Amount-boundary verification: eight new PostgreSQL expectations failed before the correction; all fifteen transaction/permission tests now pass. The complete migration, not only its function body, is applied twice in the disposable database. It preserves the signature and existing authenticated/service-role grants, denies anonymous execution, and aborts if the installed definition is neither the reviewed baseline nor this exact correction. Expected installed function MD5: 9dba1ae69cb2c842c449ba90682dc3bc.

The browser also refuses a missing table-context row before choosing a cash or tournament path; its new behavior test failed before the change. Ninety-one client tests across four files pass, and both client/server TypeScript checks pass. PR #3867 merged as 49ad56452a5d6efd708b0c57d475bc0543ebfeca. Amount-boundary publication and live-definition verification are tracked separately; phase 2 remains incomplete.

Live verification: the amount-boundary migration was applied as 20260908212101 (reserved source filename 20260908211251). Installed function MD5 is 9dba1ae69cb2c842c449ba90682dc3bc, matching the isolated tested definition. Anonymous EXECUTE is false; authenticated and service_role EXECUTE remain true. A read-only predeployment aggregate found zero active cash seats with null, nonfinite, negative or sub-cent stacks. No historical balance was edited.

The browser receipt correction was observed at the public build-info endpoint with ca_sha 49ad56452a5d6efd708b0c57d475bc0543ebfeca, built_at 2026-09-08T21:18:51Z, successful Hetzner publisher run 34279659263. The amount/context branch is PR #3872. This is release evidence for the named changes only, not phase completion.

After resolving the add/add conflict caused by the earlier receipt branch's squash merge, the combined tree passed 7,731 server tests in 577 files. Fifteen database tests skipped by the ordinary suite passed separately against the complete migration in isolated PostgreSQL. Ninety-one focused client tests and both TypeScript checks also passed. New main-branch poker-rule changes were preserved. This merge verification does not resolve the documented occupancy-identity or wrapper lock-order findings.

## Seat-expiry Wrapper Lock Order (in progress)

Installed player_leave_table(uuid,uuid), MD5 0d16681a00b7515c40cbb053760af51e, takes table_seats FOR UPDATE before calling atomic_seat_cashout_locked. The canonical operation then waits for the per-user table_cap advisory lock, reversing the buy-in/cashout order. Planned correction: acquire the same user lock, then the tournament parent lock when applicable, before the existing seat lock. Preserve the wrapper's service-role-only EXECUTE grant, invoker security, no-seat behavior and ledger declaration. A concurrent-connection test must prove that a caller waiting on the user lock does not already hold the seat.

The cash lock-order test failed against the installed wrapper because a third connection could not acquire the seat NOWAIT while expiry waited on the user advisory lock. The corrected wrapper passes that case and a separate tournament-parent contention case. All 18 isolated PostgreSQL cases pass, including rollback, lost response, malformed amounts, and both functions' grants. Both complete migrations are applied twice in the disposable database; server TypeScript passes. Expected player_leave_table MD5 is cbab2d426b0ec091b5b09f3e76eec640.

This closes the proved lock inversion in player_leave_table only. Closing-table/cluster wrapper ordering and occupancy-bound retry identity remain open. Of six SQL definitions mentioning atomic_seat_cashout_locked, five invoke it and remove_horse only contains a retirement error; it is not an active cashout path.
