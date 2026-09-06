# 2026-09-06 - Two writers of the same money take their locks in one order

Phase 2 of the chip-accounting programme, the deep dive Dan asked for before
phase 3: "verify that everything you've built in the previous phase is 100%
fully built, coded, wired in and tested ... I want hard coded fixes for
things that break ... fixed at the root cause and stopped from happening
again."

The dive started from three questions the H2 work had left open - why did
three winners' prize credits fail with "after 3 retries" at 12:47 and 12:52,
why did tournament fees need a sweep on 09-03 and 09-04, and why did nine spin
bookings die at the 12:50 and 15:00 thaws - and ended in the Postgres log.
All three had one answer.

## What the log said (24 hours to 15:15 UTC)

| symptom                                     | count |
| ------------------------------------------- | ----- |
| deadlocks                                   | 875   |
| statements cancelled by statement_timeout   | 2,916 |
| row-lock waits over one second              | 6,969 |
| waits over one second on advisory 918273645 | 2,731 |

The three prize credits were `fn_settle_tournament_obligation` returning
"canceling statement due to statement timeout" - queued behind the lock below.
The reconciler paid those winners 28 minutes later. That is the "reconciled,
not fixed" shape Dan named.

By class, from `parsed.detail` and `parsed.context`:

| deadlock pair                                                      | per day | cause                                                |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------- |
| `fn_sync_tournament_chips` vs itself                               | 247     | bulk UPDATE locks rows in join order                 |
| `fn_settle_tournament_rake` vs `atomic_distribute_rake`            | 249     | mirror-image lock order on club/union wallets        |
| `atomic_seat_cashout_locked` vs `UPDATE tournaments ... COMPLETED` | 131     | child-then-parent vs parent-then-child               |
| anything holding advisory 918273645 vs a row it needs              | ~30     | a global exclusive lock held to commit by every chip |
| `fn_seat_horse_in_seat_first_game` vs a `hand_history` INSERT      | 12      | rows-then-lock vs lock-then-rows (Daily Missions)    |
| a migration's bare `DROP TRIGGER` on a hot table                   | 14+3    | another agent's retry loop at 14:47; CLAUDE.md 2     |

## Five migrations, one lock order each, no chip moved

All applied to production 15:27-15:31 UTC, each proving the live definition
in a `DO` block that aborts if the order does not hold, all at byte parity.

**`20260906152215_the_reporting_rollup_shares_its_lock_instead_of_serialising_`**
`trg_ca_reporting_wallet_insert` (AFTER INSERT ON wallet_transactions) and
`trg_ca_reporting_rake_insert` (AFTER INSERT ON rake_records) took
`pg_advisory_xact_lock(918273645)` - one exclusive, transaction-scoped lock
for the entire platform, held from a transaction's first wallet row until it
committed. Every buy-in, prize, bounty, refund and rake row queued behind
every other one, and any transaction holding it while waiting for a row that
another held (while THAT one waited to write its own wallet row) was a
deadlock. The lock's purpose is to keep the incremental rollups from
interleaving with the two range rebuilds. That is readers-vs-writer: the
triggers now take `pg_advisory_xact_lock_shared(918273645)`; the rebuilds
keep the exclusive form. The tournament loops are ordered by `club_id`.

**`20260906152529_tournament_chips_are_synced_in_one_order`**
`SELECT ... ORDER BY tp.user_id FOR UPDATE OF tp` on exactly the rows the
bulk UPDATE will write, before it writes them.

**`20260906152700_tournament_rake_settles_in_the_same_lock_order_as_cash_rake`**
`atomic_distribute_rake` goes club_wallets -> union_wallets | clubs.
`fn_settle_tournament_rake` went the other way. It now takes the
club_wallets row first, and its tournaments lock drops to FOR NO KEY UPDATE
so a cash hand's `rake_records` FK check no longer waits behind a settlement.
This is the root of the 09-03/09-04 'sweep' fee settlements the escrow shadow
filed as "fee left in escrow".

**`20260906152756_a_seat_cashout_locks_the_game_before_the_seat`**
A seat change on a spin/SNG/heads-up fires
`trg_seat_change_syncs_seat_first_count`, which writes
`tournaments.current_players` (and, on the last seat, runs
`fn_spin_book_entry`) AFTER the seat row lock. The engine finishing that game
holds the game row and its trigger locks every seat. `atomic_seat_cashout_
locked` now takes the game row FOR NO KEY UPDATE before the seat. This is the
root of the nine `fn_spin_book_entry raised: deadlock detected` criticals.

**`20260906152850_seating_a_horse_takes_the_missions_lock_before_the_game_row`**
`fn_lock_daily_mission_user(p_user_id)` as the first lock, the order the
hand_history path already uses.

## Engine hardening found by the deep dive

`server/src/engine/ServerTableEngineSettlement.ts`: with the bomb guard
attached, a bomb hand that produced winners but an empty per-pot award array
would be refused twenty times by the retry queue and lost - hand, rake link,
facts and all. The winners list is the same money (966 of 966 bomb hands over
six hours: sum(winners) == distributable to the cent), so it is now the
fallback source of units; the `bomb_award_units_empty` report is unchanged.
Pinned in `TheBombBreakdownTravelsWithTheHand.law.test.ts`.

Everything else in phase 1 read as wired: the atomic RPC path, the retry
queue carrying units, `wroteAwardUnits` set by the write, the drain refusing
to park a table mid-settlement, and the deferred guard - 0 gaps on every
bomb hand since the 12:58 restart, every unit sharing its hand's `xmin`.

## Verification

Measured after apply (see the report for the numbers): deadlocks and
lock-waits per hour from the same log query, the incident board, and the
bomb-gap query. The law
`tests/two-writers-of-the-same-money-take-their-locks-in-one-order.law.test.ts`
pins the five orders in the migration text.

## What this does not touch

Another agent's migration at 14:47 ran a bare `DROP TRIGGER IF EXISTS ... ON
public.clubs` in a retry loop and deadlocked 14 live table updates. That is
CLAUDE.md section 2 (production DDL policy) and the guarded-DDL pattern in
`20260906143315`; it is not a code path this changes.

## Found by watching the fix: one seat-first repair at a time

`20260906154248_one_seat_first_repair_runs_at_a_time`, applied 15:44 UTC.

Three of the four deadlocks in the twelve minutes after `20260906152850`
landed were a different cycle it had exposed, and one this function has had
all along: `fn_repair_seat_first_games` loops over up to 25 games and seats
several horses in each, and PostgREST runs the whole function in ONE
transaction - so the locks from game 1 are still held while game 12 is being
seated. Two concurrent passes visit games and horses in different orders and
cycle (15:35:22, 15:37:49, 15:38:50, on `tournaments` tuples 18598,8 and
18648,11). Before the M5 change the same function was deadlocking on the same
shape against `atomic_deduct_wallet_and_log` and the old global reporting
lock: the lock it cycles on changed, the loop did not.

Ordering the loop does not fix it - the pass takes locks on two axes (the
game row and the per-player advisory lock) and rebuilds its horse pool per
club from live registrations, so two passes seconds apart do not see the same
pool. Any total order over one axis leaves the other free to cycle. So the
second pass does not run: `pg_try_advisory_xact_lock`, and a caller who
cannot have it returns `skipped` immediately. Not the blocking form - a pass
that waits is a pass that can deadlock on the wait.
`TournamentRecurringService` calls this on a tick and reads only `repaired` /
`horses_seated`, so a skipped pass is invisible and the next tick does the
work.

**The first draft of that migration aborted itself, correctly.** Its verify
block held the lock and called the function expecting a skip; it did not
skip, because a Postgres advisory lock is RE-ENTRANT within its own session -
`pg_try_advisory_xact_lock` returns true to the holder. A single transaction
can therefore never observe its own guard declining, and a probe that
appeared to would have been testing nothing. The block now proves what it
can (the guard is first, non-blocking, and returns zero work) and says in
words that the cross-session skip is measured by the deadlock rate instead.

## Also stated: who may execute the three replaced functions

`20260906153725_the_three_lock_order_functions_state_who_may_execute_them`.
`check-definer-authorization` blocked the push, correctly: three of the
migrations replace SECURITY DEFINER writers and say nothing about who may
call them, so a replay onto a database where the function does not yet exist
would create them with EXECUTE held by PUBLIC. Production is not open - all
three read `{postgres, service_role}` - but only because CREATE OR REPLACE
preserves an existing ACL and because an `[autorevoke]` event trigger strips
PUBLIC/anon here, and neither of those is in the repo. The migration states
the grants explicitly and asserts them.
