# The money behind the drift board (2026-09-09)

Second half of the drift-board work (see
`2026-09-09-the-drift-board-was-98-percent-one-bug.md`, which cleared the
3,330 amplified incidents). With the noise gone, the real findings were
legible for the first time. Dan delegated every decision here, including the
one the 09-07 changelog had reserved for him.

## Every unpaid tournament obligation, settled or written down

Seven obligations claimed money for players. **Six of the six affected events
had paid out their prize pool to the cent** - `sum(tournament_payouts) =
prize_pool` exactly, in all six.

### Two winners were genuinely short: 360.00 paid

`fn_tournament_payout_reconcile` was right about the two Sunday $200 Deep
Stacks. The structure promises 100.0000% of the pool to the ranked places AND
bubble protection promises the bubble finisher their buy-in back **out of the
same pool**. Both were advertised; the pool can pay one. Because the winner is
always the last place paid, the winner absorbs the entire difference - a tax on
first place that appears in no published structure.

Verified row by row on `a449e853`: places 2-12 each received their exact
structure percentage of the full pool, the bubble finisher received the full
180.00, and place 1 received 8,102.69 where the structure promises 8,282.69.
Place 1 was the only player on the sheet who got less than advertised.

**Decision (10.9): the house funds bubble protection, from the rake the same
event collected.** Migration
`20260909060341_bubble_protection_is_funded_by_the_house_not_the_winner` pays
Zoe77 180.00 and MamaGia 180.00 through `fn_settle_tournament_obligation` with
an approved `fn_ca_adjustment_under_10_9` row each. Both now hold exactly their
advertised prize; both obligations read `still_owed 0.00`.

Rejected: taking bubble protection off the top (silently reduces every _other_
advertised prize) and retiring bubble protection (removes a player promise).

### Five were phantoms, and the reconciler was the cause

`fn_tournament_payout_reconcile` distributes the whole `prize_pool` across the
ranked places and never looks at payouts made **outside** that structure -
rows with `position IS NULL`. So it believes the pool still owes money it has
already paid.

| event                                     | claimed | truth                                                                                                                               |
| ----------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| PLO4 Heads-Up 25                          |   71.25 | the whole pool was paid by a **final-table deal**: 47.50 to the very player the obligation says was "paid 0.00", 23.75 to the other |
| Breakfast Turbo                           |   19.07 | paid **six** places summing to exactly 180.00 while `payout_structure` stores a stale **four**-place structure                      |
| Daily Big Mini p1/p4, Deep Stack Daily p2 |    0.32 | pools paid to the cent                                                                                                              |

Its dry run wanted to top the deal-winner up by another 23.75 - the loser's
share - out of a pool with nothing left. Only the escrow cap stopped it.

`20260909060539_a_pool_that_is_fully_paid_owes_nobody_a_top_up` adds two
guards before any expectation is computed: a **final-table deal is the
settlement** (the ranked structure does not describe that event), and **a pool
that has paid out its whole self owes nothing more** - a remaining per-place gap
is an over-promise for the house to fund, not an unpaid pool. Both are asserted
live in the migration. The five obligations are written down to what was paid;
their `amount_owed` was arithmetically impossible.

**Zero unpaid tournament obligations remain.**

## 1,919.00 released from 22 frozen satellites

22 heads-up satellites sat in COMPLETING for up to 27 hours, each with a clean
winner, holding their whole pool. A structural deadlock:
`fn_settle_satellite_finish_atomic` needs a `tournament_entry_close_receipts`
row; 21 had none; and `fn_close_tournament_entry_window`, its only writer,
refuses once the tournament leaves RUNNING. These are 2-player SNGs that finish
in minutes, so the entry close never fires before the finish.

`20260909061222_a_finished_satellite_must_be_able_to_settle` backfills the
receipt from frozen state (pool finalized, one seat, 100% to place 1 - the
exact shape of the one satellite that had one) and drives settlement. Ten
settled immediately.

The remaining eleven hit `FOUR TABLE LIMIT`: the winner is already in four
games, so no seat can be booked.
`20260909061414_a_seat_the_winner_cannot_take_is_paid_as_cash` adds that as a
**fifth** cash fallback beside the four `fn_deliver_satellite_ticket_exact`
already has (`target_missing`, `target_not_open`, `target_economics_changed`,
`seat_already_held_elsewhere`). The cap itself is untouched - 10.5 requires it
to bind horses exactly as humans. Only a `check_violation` whose message is the
cap converts; every other one still aborts, because those mean the money did
not add up.

**All 22 are COMPLETED, escrow 0.00, 1,919.00 paid - 6 as real seats into
still-registering targets, the rest as cash.**

## Two cron jobs restored

`home-trending-refresh` (every 15 min) and `pnm-locations-refresh` (every 30
min) had failed on every run since 2026-09-08 17:37, when a `DROP EXTENSION
postgis CASCADE` run from an **ad-hoc Supavisor session with no migration**
took 723 functions, 2 matviews and 6 indexes. The recovery rebuilt the matviews
and not their unique indexes, so `REFRESH ... CONCURRENTLY` became impossible.
Only one of the two broken jobs ever raised an incident. Indexes restored,
uniqueness proved first, both verified refreshing concurrently.

## What turned out to be measurement, not money

Each verified to the cent rather than assumed: the 9,981,736.92 club-treasury
drift (a missing opening balance; the last two nightly runs reconcile to
0.00), 851,409 diamonds (three definitional changes between two samples), the
chip-supply "leak" (tournament liability status-filtered on one side of the
equation only; correlation 0.771 with post-completion prize flow), 70,795.11 of
BBJ (pre-payout-table history, already baselined 09-07; the live trigger is
3.15 of rounding dust against a fixed tolerance of 1.00), and 19 spin alerts
(cancelled spins where every entrant was refunded - read per player).

**43,990.40 of rakeback across 653 periods and 457 players: nobody is owed.**
All 457 were paid in full on 2026-08-20 through `fn_pay_player_chips`; per-user
reconciliation is 457/457 exact, 0 under, 0 over, and the closing identity
balances: 285,190.49 + 43,990.40 = 329,180.89.

## A mistake worth writing down

Probing the first settlement **interactively** held a row lock on the host
club's treasury while the MCP client timed out. Every rake write queued behind
it, connections exhausted, and the database stopped accepting new ones
platform-wide for several minutes; `/api/health` reported `db: error`. It
cleared itself and nothing committed. Two lessons, both applied to every
migration above: a money settlement runs **server-side in one transaction**,
never held open across client round trips, and it carries `SET LOCAL
lock_timeout` so it aborts instead of queueing behind live play.

Second, smaller one: the bank debits produced auto-ledger twins into
`settlement_suspense`, because a bare balance UPDATE on a money path must first
declare `app.ledger_category` the way `fn_ca_apply_prize_guarantee_core` does.
`fn_ca_suspense_regression_check` caught it in twelve minutes - the detector
working exactly as designed - and
`20260909062134_close_the_suspense_the_bubble_backpay_opened` cancels the twins
forward, since the journal is append-only.

## Still open, deliberately

- **~400.00 of spin reserve** drawn for `a2e30c1f` and never returned as a
  `surplus_return`, with 262.00 in its escrow. House-side reserve bookkeeping;
  no player is owed (all three entrants refunded, one also paid 100.00).
- **`fn_settler_lag_check`** is unhealthy but _recovering_ on its own: 9.95h /
  58,742 rows to 8.96h / 49,641 within the hour, last save 2 minutes ago.
- The detector fixes named in the resolutions above (supply-meter status
  filter, BBJ epoch tolerance, a rakeback baseline row, certification-cleanup
  severity) are specified on their incidents and not yet shipped.
