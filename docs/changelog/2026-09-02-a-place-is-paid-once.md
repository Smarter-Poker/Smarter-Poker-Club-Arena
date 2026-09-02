# A place is paid once, no matter who holds it

2026-09-02, found by asking what was left after the frozen tournaments were
settled. The answer was 21,206.93 chips going out of the door on an hourly
schedule.

## What was measured

`fn_tournament_payout_reconcile` owes money PER PLACE and checked what had been
paid PER USER. Those two agree only while a finishing place never changes hands.

|                                    |                                                      |
| ---------------------------------- | ---------------------------------------------------- |
| places paid to two different users | **81**                                               |
| tournaments affected               | **49**                                               |
| excess paid                        | **21,206.93**                                        |
| when                               | every credit between 2026-08-31 13:37 and 2026-09-02 |

Worst single event, `Sunday $200 Deep Stack` (dfae9288): 44,640.00 pool,
62,841.60 paid. All nine paying places paid twice, structure to one player and
reconcile to another, the second exactly 2.1379x the first because the structure
had run against a 20,880.00 pool and the reconciler against the full one.
Place 1 went 6,264.00 to be61d864, then 13,392.00 to 2d48c8ed.

This was not historical. Cron job 189 runs
`fn_tournament_payout_sweep(7, true, 150000)` every hour at :52, and it is the
process that kept re-paying whenever anything restated a finishing order.

## The fix

A top-up is now capped by the GREATER of what the current holder was paid and
what the PLACE was paid to anybody. A place can never be paid more than the
structure says it is worth, whoever ends up holding it.

The case is reported rather than absorbed: a new issue,
`place_paid_to_a_different_player`, names both users and both amounts. Paying
the new holder anyway is sometimes the right answer, but that is a decision
under CLAUDE.md 10.9 taken with the earlier payment in view, never a side
effect of an hourly sweep. The issue joins `overpaid` and
`no_finisher_recorded` in the accepted set, so an event whose alert carries a
written resolution stays quiet instead of re-raising critical every hour.

## Verified

- `Sunday $200 Deep Stack` dry run: `total_top_up` went from wanting more money
  to **0.00**, with 17 issues naming the earlier recipients.
- Platform dry sweep, 60 days, 3,000 newest events: **`total_top_up` 0.00** -
  the cap suppresses nothing legitimate.
- Independently: across all 56,456 completed events with a prize pool, **zero
  are underpaid**. Nobody is owed anything. Only the overpay direction was
  broken.

## Not clawed back

The 21,206.93 already paid stays with the players who received it. CLAUDE.md
10.9 rule 3: nothing is taken back from a player for our defect. This stops the
bleed; it does not reopen what has been paid.

## Also recorded here

`20260902162954_settle_two_tournaments_frozen_by_the_engineless_table_defect.sql`,
applied earlier the same day, is committed alongside this one. Both were applied
through the Supabase MCP, which records SQL in the ledger but nothing of why.
