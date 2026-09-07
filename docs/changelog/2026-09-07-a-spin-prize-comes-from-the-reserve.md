# A spin prize comes from the reserve, and an alarm that never clears is not an alarm

**2026-09-07** — branch `fix/a-spin-prize-comes-from-the-reserve-not-the-buy-ins`

A player was 4.80 chips short for a day. Finding out why turned up something
larger: **five of the six open critical "a player was not paid" alerts were
false**, one of them nearly caused a real double payment, and the check that
raised them had no way to close a single one.

## The player who was short

heat3rfi5h won a **20 Chip Spin PLO4** on 2026-09-06 and received **55.20** of
an advertised **60.00**. The missing 4.80 is exactly the 8% house rake.

A Spin & Go is not funded by its own buy-ins. `fn_spin_settle_game` pays the
buy-ins less the rake INTO the shared spin reserve, then draws the advertised
prize (buy-in × multiplier) back out. `spin_reserve_ledger` records both, at
the same microsecond:

```
contribution  +55.20   buy-ins less fixed rake
jackpot_draw  -60.00   prize pool
```

`tournament_escrow` carries those as `reserve_out` / `reserve_in`, and they
reach it from a trigger on `chip_ledger`. **For this one event those two
chip_ledger rows were never written as themselves.** In the same transaction
the auto-ledger wrote instead:

```
adjustment  spin_reserve        -> settlement_suspense  60.00  to_entity NULL
            "...delta -60.00 (category spin_pri..."
adjustment  settlement_suspense -> spin_reserve         55.20  to_entity NULL
            "...delta 55.20 (category spin_entr..."
```

The intended category survives only inside the description text. Healthy
neighbours seconds either side carry `spin_entry` / `spin_prize` with real
entity ids. So the escrow never learned that 60.00 had been drawn to fund a
60.00 prize, and `fn_settle_tournament_obligation` refused the winner's last
4.80 as `escrow_short` — correctly, on the numbers it had.

**How often: 1 in 18,318.** Escrow rows for events the reserve ledger knows
about: 18,318. Rows whose `reserve_in` disagrees with it: **0**. Rows missing
their legs entirely: **1**. This is not a broken pipe; it is one leg that fell
into suspense with nothing able to notice.

**The fix** (`20260907163416`): `fn_ca_escrow_apply` seeds the reserve legs at
first sight from `spin_reserve_ledger` — the record the pool balance itself
moved by, which cannot be absent while the money has moved — instead of from
`chip_ledger`, the derived record that went missing. That one event's legs were
corrected forward from the same source, and the 4.80 was then paid by
`fn_tournament_payout_reconcile` through `fn_settle_tournament_obligation`, the
platform's own idempotent path. No wallet row was hand-written. Escrow prize
bank now 0.00 against 60.00 credited; 18 alerts resolved with the full note.

It does **not** stop a leg landing in suspense. That belongs to whoever owns
`fn_ca_declare_ledger`, and saying so is better than claiming it (10.11).

## The migration I reverted within the hour

My first attempt (`20260907162426`) folded the reserve draw into `prize_in`
inside `fn_ca_tournament_escrow`. It read correctly on its own and was wrong
where it mattered: `fn_ca_escrow_apply` derives `gross_in` from that number at
first sight, so a Spin whose escrow row opened after its draw would have
recorded `gross_in` **64.80** for a 60.00 event and then counted the draw a
second time. Reverted deliberately, in the next migration, and the superseded
file says so rather than being deleted.

## The larger thing: five of six alerts were false

| alert                            |      pool |  credited | verdict                                          |
| -------------------------------- | --------: | --------: | ------------------------------------------------ |
| Sunday $200 Deep Stack 13,441.68 | 52,920.00 | 52,920.00 | paid in full at 04:10, **hours after the alert** |
| Sunday $200 Deep Stack 8,282.69  | 28,640.00 | 28,640.00 | same                                             |
| **20 Chip Spin PLO4 60.00**      | **60.00** | **55.20** | **real**                                         |
| PLO4 Heads-Up 25 23.75           |     71.25 |     71.25 | a `final_table_deal` replaced the structure      |
| Sunday Funday Main 0.07          | 14,850.00 | 14,850.00 | rounding                                         |
| DSS Tuesday $11 PLO5 0.06        |  1,350.00 |  1,350.00 | rounding                                         |

**The false ones nearly moved money.** On the Heads-Up event the reconciler
read the same signal and tried to top the winner up by 23.75 out of a pool that
was already fully distributed. The only thing that stopped a genuine double
payment was the empty escrow it would have come from.

And the true one — a player short since the previous afternoon — sat fifth in a
list of six that a reader has been taught to skim.

## The rule that fixes it

"A player was not paid" is a claim that **money is still there** and someone is
short. If the pool is fully distributed that claim is false whatever the
structure says: at worst a place is mislabelled, a deal replaced the structure,
or a cent landed next door. None of those is answered by paying somebody.

So (`20260907163820`) the critical alert now requires an **undistributed pool**,
and the rest are counted in the return payload rather than alarmed. Derived,
not guessed: over 7 days and **76,760 paid places** on fully distributed events
the median difference between the flat `pool × percentage` and what a place
actually received is **0.0000**; only 1,056 differ by more than 0.05, and 1,051
of those by more than 1.00 — so alarming on that band would raise a thousand
rows a week and silence itself in a day (10.84).

**And it clears itself.** The check had a `NOT EXISTS` guard so it never
duplicated an alert, and no path at all to close one — once raised, open for
ever. That is how a critical list reaches 233 rows. Every run now resolves any
open `earner_not_paid` whose condition no longer holds, with a note saying
which half stopped being true. 10.11 rule 5: the net stays and is expected to
find nothing.

Open `earner_not_paid` alerts after this shipped: **0**.

## What I did not settle, and why

Both **Sunday $200 Deep Stack** events show `tournament_obligations` owing the
winner exactly **180.00** more than the pool holds — the same absolute figure on
pools of 52,920 and 28,640, which is one buy-in's prize slice on a 180+20
event. The pools are distributed to the last chip, so paying it means the house
funds it.

I can read that the obligation exceeds the pool. I cannot yet state **why** —
whether a collected buy-in never reached the pool (the player is owed and the
house is holding it) or the obligation over-counted (the player is not owed).
10.9 condition 1 fails, so it goes to Dan as options rather than being settled
on a guess. The `fn_settle_tournament_obligation` alerts describing it stay
open, which is now the only class of alert describing that case.

## Files

- `supabase/migrations/20260907162426_a_spin_prize_comes_from_the_reserve_not_the_buy_ins.sql` (applied, superseded)
- `supabase/migrations/20260907163416_the_escrow_reads_the_reserve_ledger_not_a_side_effect.sql` (applied)
- `supabase/migrations/20260907163820_a_pool_that_is_fully_paid_has_nobody_left_to_pay.sql` (applied)
