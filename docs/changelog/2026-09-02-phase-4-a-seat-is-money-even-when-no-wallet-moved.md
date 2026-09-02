# Phase 4 of 6 - a seat is money even when no wallet moved

2026-09-02. Club Arena MTT payout audit, phase 4 of 6: do re-entries and
add-ons reach the prize pool they were paid into.

Everything below was read from production. Where a number is quoted it was
measured, and where something was reasoned about rather than executed that is
said in the sentence.

## Three of the four reconcile

**Rebuy fees reconcile to the cent.** Over three days, 7,679 `rebuy` debits
produced 7,679 `rake_records` rows with source `process_tournament_rebuy`;
3,859.60 chips charged, 3,859.60 booked, zero tournaments missing a rake row.
They cannot detach: the fee row, the pool credit and the wallet debit are all
written inside one transaction, under the row lock the function takes on
`tournaments`.

**Add-ons take no fee by design.** `v_ratio` is 0 for an add-on, so the whole
charge is prize money and there is no rake row to miss.

**Cancellation returns all three categories.** `atomic_cancel_tournament` sums
entries, rebuys and add-ons, nets off prior refunds, and credits the
difference. Across 225 cancelled events and 399 player-event pairs: 0.00 still
owed, 0.00 over-refunded.

That zero was not believed until the instrument was proved. The identical
arithmetic run against COMPLETED events - where a stake is legitimately not
returned - flags 1,085 of 1,085 pairs and 22,365.00 chips. The matcher
discriminates, so the cancelled zero means something.

## The fourth does not, and it is blind on both sides at once

A satellite seat is the one way money enters a tournament without a wallet
moving. `fn_award_satellite_seat` credits the target's `prize_pool` with the
target's buy-in and its `total_rake` with the target's fee, and pays the
satellite's winner in a seat rather than in chips.

`fn_tournament_conservation_delta` computed `money_in` from
`wallet_transactions` debits alone. So:

- **The target** looked like it "paid out money it never collected". The seat's
  prize contribution never entered `money_in`, while the seat's _fee_ did enter
  the rake term. "Sunday $200 Deep Stack" read **-4,780.00**.
- **The satellite** looked like it "retained money it never paid out", because
  a seat paid as a prize lives in `tournament_payouts` and nowhere the delta
  read.

The satellite side is the part that removes all doubt about the cause. Across
**all 11** satellites that have ever awarded a seat, the delta equals the seat
value paid **exactly, to the cent, 11 times out of 11**: 1000/1000, 1000/1000,
600/600, 400/400, 400/400, and 200/200 six times. Total 4,600.00 on that side;
23 seats x 200 = 4,600.00 on the target's.

The target's remaining -180.00 is fully explained too, so nothing is left
hand-waved: it is a single `Bubble protection: buy-in returned` credit. The
event decomposes to the cent as -4,600.00 (blind seats) + -180.00 (that
credit).

The money was always conserved. The check was blind, symmetrically, and the
two blindnesses were the same 4,600.00 seen from opposite ends.

## Why that was dangerous rather than untidy

Satellites were excluded from the scan altogether -
`variant NOT IN ('spin','satellite')` - so their +4,600.00 raised nothing, and
a satellite that genuinely failed to award or to pay would have raised nothing
either. That is the Phase 1 shape: a check that cannot see the thing it exists
for. Meanwhile the one target that receives seats carried a deficit that would
never clear, which is how a team learns to ignore a money alert.

Fixing the delta without also widening the scan would have corrected the
arithmetic and left the blindness in place.

## What shipped

`20260902160019_a_seat_is_money_even_when_no_wallet_moved.sql`

1. The delta learns both halves of a seat: `seat_income` on the target (found
   through `metadata->>'satellite_target_id'`, because the payout row belongs
   to the satellite that paid it) and `seat_paid_out` on the satellite.
2. Satellites enter the scan. `spin` stays out - its pool is funded by the
   Reserve Pool rather than by its own collections, and it has its own check.

**One witness, not three.** Phase 2 enumerated three witnesses because each had
a birthday. Here the opposite applies: a seat carries both a
`tournament_payouts` row and, when the target charges a fee, a `rake_records`
row, so reading both would double-count. `tournament_payouts` is canonical - it
is written in the same transaction as the seat, and Phase 2 back-filled the 23
seats awarded before that block existed, so it is complete for every seat this
platform has ever awarded.

**No new check.** The detector is the existing
`fn_tournament_money_conservation`, already registered in
`money_check_heartbeat` and already stamped by `GameServer.ts:3541`. Widening
the check that exists beat adding an eighth, and it meant no engine change and
no new failure surface.

## This cannot release a single additional chip

Established by reading the consumers, not by executing a money path (11.5 rule
5). Exactly three things read this delta. `fn_pay_backed_payout_shortfalls` and
`fn_hu_shortfall_candidates` pay only where the delta is **above +0.01**, and
both already exclude satellites explicitly. The only tournaments whose delta
_rises_ are satellite targets - one exists, and it moves to -180.00, still far
below the threshold. The only tournaments whose delta _falls_ are the 11
satellites, which both payers already skip, and a lower delta can only ever pay
less. The third reader is the scan, which pays nothing.

## Measured outcome

|                            | before                 | after                |
| -------------------------- | ---------------------- | -------------------- |
| satellites (all 28)        | 14 breaking, +4,490.50 | 3 breaking, -109.50  |
| satellites that paid seats | 11 breaking, +4,600.00 | **0 breaking, 0.00** |
| the satellite target       | -4,780.00              | -180.00              |

## The three that remain are real, and are not mine to close

- **-108.00** on a CANCELLED satellite that paid 108.00 in prizes and then
  refunded all 120.00 of entries. Real money, already gone. Dan's no-clawback
  ruling stands: the players keep it, the hosting club absorbed it. Recorded,
  not chased.
- **-1.00 and -0.50** on two completed satellites. Exact-cent allocation
  residue - that is **Phase 6**, deferred there deliberately.
- **-180.00** on the target. After this migration that alert is _true_ rather
  than false: 180.00 was paid that no collection funded. Bubble protection is
  written by the engine (no database function contains that string), two rows
  exist platform-wide totalling 189.00 chips, and nothing records the club
  funding it. Same class as the seat - money out with no money in - but it is
  engine-side promotional funding and belongs to whoever owns promotions. Named
  rather than guessed at.

## The fix broke two hourly money jobs, and this is the correction

**Found by the phase gate, an hour after claiming Phase 4 complete.** The
migration was correct and cost two jobs their next run.

`seat_income` filters on `metadata->>'satellite_target_id'`, and
`tournament_payouts` is indexed on `tournament_id`, `(tournament_id, position)`,
`(user_id, paid_at)` and `idempotency_key` - and on nothing that serves that
predicate. So the term seq-scanned all 85,331 payout rows **per tournament
evaluated**: 3,736 buffers a time, against an hourly job that evaluates 5,108
events. About 19.1 million buffer hits for one term.

Two jobs died on the first run after 16:00:19, both of them green all day:

| pg_cron job                             | before                        | after       |
| --------------------------------------- | ----------------------------- | ----------- |
| 144 `tourney_money_conservation_hourly` | 18.5s 17.6s 24.8s 22.7s 25.8s | **timeout** |
| 231 `ca-pay-backed-payout-shortfalls`   | 40s 46s 43s 86s               | **timeout** |

231 is the job that **pays players** a backed shortfall, so one hourly cycle of
back-pay did not happen. Nothing is permanently lost - the job is hourly and
idempotent and the next healthy run pays whatever is still owed - but it is a
missed cycle and it is written down as one rather than rounded off.

Job 229 (cash pot) also failed in that window and is **not** this: it failed at
15:34, half an hour _before_ the migration, inside a `hand_history` query, and
recovered by itself at 16:34. Not every red job in the window is yours.

Fixed by `20260902164610` - one partial expression index, 23 qualifying rows.
Measured on the same query and row: **3,736 buffers / 987.9 ms to 4 buffers /
0.24 ms**. Across 400 events of the real window the two seat terms now cost
about 5 buffers each per event, roughly a tenth of the delta's total cost,
where before the index they were seventy times the whole rest of the query.

### Two things this exposed that are not mine to close

**The heartbeat could not have caught it.** `money_check_heartbeat` is stamped
by the GameServer pass, which has never run - all seven rows still read
`run_count = 0`. But these checks are driven by **pg_cron**, jobs 144 and 231,
and they have been running hourly all along. So the Phase 1 conclusion that "no
money check runs automatically" is true only of the GameServer wire: a check can
be running hourly, and failing hourly, while its heartbeat says it has never
run. Recorded for the Phase 1 owner rather than widened here.

**I measured wall clock and nearly trusted it.** The extrapolation said ~69s
against a 120s cap, which looked fine and means nothing on this database.
Buffers are what settled it: +11% on the check's cost, not +170%.

## What went wrong on the way

**I nearly reported a 205,756.90-chip leak that does not exist.** The first
reconciliation compared cumulative charges against
`prize_pool + total_rake + bounty_pool` and found 8,688 events short. Then the
segmentation by status showed RUNNING and COMPLETING events at _zero_ shortfall
and COMPLETED events broken in **both** directions - the fingerprint of a value
mutated at settlement, not of a collection leak. `prize_pool` is a live
balance: `fn_apply_prize_guarantee` overwrites it outright, and cancel and
unregister decrement it. Comparing it to cumulative charges is meaningless. The
instrument was invalid, and the reading was an artifact of it.

Verify the instrument before believing the reading - including, and especially,
when the reading is alarming.

**A pin that could not fail.** `expect(DELTA).toMatch(/AS seat_income/)` also
matches `AS seat_income_renamed`. Negative control caught it; nothing else
would have. Both alias pins are anchored to end-of-line now, and all seven
mutations go red: gutting either term, the wrong metadata key, restoring the
exclusion, renaming either alias, and a newer migration appearing without the
pointer moving.

**Assertions match code forms, not bare words.** The word "satellite" appears
throughout this migration's own commentary, so the assertion that the scan no
longer skips them matches `NOT IN ('spin', 'satellite')`. Matching the bare
word would have made the migration refuse itself - the mistake this workstream
has now made three times.

## Left open, deliberately

`atomic_tournament_register` still moves money with no ledger row of any kind.
Unchanged here; it belongs to the `fn_union_law_check` workstream and is named
inside the Phase 2 check's own alert.

The `addon` wallet category is shared with cash-game table add-ons - 802 rows
in three days, described `Table add-on (club wallet)`, whose
`related_entity_id` is a **table**. Nothing is contaminated today, because a
table id never equals a tournament id, but a future query that filters on
category without joining `tournaments` will mix them.
