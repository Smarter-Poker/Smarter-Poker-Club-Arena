# The board clearance - 894 open alerts to 200

2026-09-06, chip accounting standard. Dan: "finish up everything thats still
pending and not finished OR STILL NEEDS TO BE FIXED, IMPROVED, ENHANCED OR
OPTIMIZED ... go through it all line by line, check for any bugs, stubs, gaps,
errors, regressions or wiring issues."

`financial_alerts` held 894 open rows. Read one class at a time, they were four
real defects, one stale baseline, one queue nobody was draining, and 152 rows of
my own noise. None of them was what its message said it was.

## 1. "Tournament paid out money it never collected" - 246 rows, and the money was there

The conservation check flagged 38 of 110 bounty events, 27 of 64 mystery
bounty, 26 of 54 progressive bounty and 19 of 36 satellites in seven days -
15,148 chips - and **not one SNG out of 25,708**. A defect that sorts that
cleanly by format is a missing term, not missing money.

Two paths fund a guarantee and they keep different books.
`fn_apply_prize_guarantee` writes a `tournament_guarantee_overlays` row;
`fn_ca_fund_overlay_on_lock`, which is the path that actually funds them now,
debits the bank and writes a `chip_ledger` leg. The delta read the side table
only. Late Night PKO collected 520.00, raked 52.00, carved 260.00 into the
bounty pool and left 208.00 for a 450.00 guarantee - and the union bank paid the
242.00, journalled, at 23:10.

`funded_overlay` now reads `GREATEST(journal, side table)`. Never the sum: over
the whole history 227 events carry only the row, 187 only the leg, and **zero
carry both**. Over the 36 hours measured, 49 of 49 short events explained to the
cent, residual 0.00 in all four families. Over the 9,558 events since
2026-09-04: **0 short, 0.00 chips**.

Two indexes came with it, because the new term turned a cheap lookup into a
1.68M-row scan and the check timed out on its first run. `chip_ledger` had no
index on `tournament_id` at all; `tournament_payouts` was scanned whole - 86 MB,
132,381 rows - on every call to find a JSON key among 599 satellite seats. Both
are partial, both are tiny, both are `CONCURRENTLY`.

What remained after the fix was 151 events between 2026-07-24 and 2026-09-03,
39,685.56 chips, all short and none long: guarantees paid before the funding
trigger existed. Those prizes reached real players weeks ago and are not clawed
back. They are acknowledged in `tournament_conservation_baseline`, the mechanism
built for exactly this and already carrying 1,799 rows from four earlier sweeps.
A mint row today would have claimed 39,685.56 chips entered circulation on
2026-09-06 when they entered in July.

## 2. The dead pool's baseline had not followed an authorised retirement

`fn_ca_quick_reconcile` paged critical every day at exactly -10,700.00. On
2026-09-03 migration `20260903234327` deliberately retired the phantom promo
pool - 107 holders, 10,700.00 chips from an orphaned signup bonus that the
supply meter had never counted - and `ca_frozen_pool_baseline` still held the
pre-retirement total.

The baseline may now move, but only beside a row in the new
`ca_frozen_pool_baseline_changes` saying who moved it and under which migration,
and a trigger refuses any other change. The guard keeps full sensitivity: one
unexplained chip in or out of that pool still pages.

## 3. "Unbanked BBJ contribution" - and the real finding underneath it

180 warnings said chips were sitting on rake rows with no `hand_id` and could be
reconciled by nobody. Measured, the pool had received everything the pot
dropped: `hand_history.bbj_amount` and `bbj_contributions` both agree with the
LINKED rake rows alone in 283 of the 284 hands whose history survives.

The rows are duplicates, and the cause is exact. `atomic_distribute_rake` keys
**both** of its idempotency guards on a hand id that is NULL on the engine's
first call:

    ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    v_leg_key := COALESCE(p_hand_id, gen_random_uuid());

A partial index that excludes NULL cannot refuse a NULL, and a fresh random leg
key can never collide - and that second one is the guard standing in front of
the club wallet's `period_rake_collected` and `lifetime_rake_collected`. The
engine calls before `logHandHistory` has written the hand and again after, and
the second call was not recognised as the same hand.

**A hand that cannot name itself by id still names itself by table and number.**
The function now asks `hand_history` for the id first, and when it genuinely is
not there yet it keys the duplicate check and the leg key on
`(table_id, hand_number)`. Proved before it committed: two calls with the same
table and hand number and no hand id, inside a sub-block that was rolled back,
leaving one rake row, one club accumulator leg, and `already_processed` on the
second call.

4,452 historical rows carrying 16,426.46 of over-attributed rake are left where
they are and recorded as an owned finding. Only 371 can be proven duplicates
from surviving hands; the rest sit behind five months of VIP points and agent
commissions that people have already been paid, and restating settled earnings
is a decision taken deliberately, not by the agent who found it at 03:00.

## 4. The repair queue nobody was draining

`ca_ledger_write_failures` is the list of moments when a balance moved and its
journal row did not get written. 116 rows; exactly two had ever been repaired,
both by hand. The drain - `fn_ca_repair_write_failure` into
`fn_ca_post_correction`, keyed `correction:lwf:<id>` so it can post only once -
had existed since Phase 6.

113 legs written back: 105 bad beat drops the freeze or a lock refused
(`table_stack -> bbj_pool`, +9.82), 7 spin prizes leaving the reserve
(`spin_reserve -> player_wallet`, -430.00), one whose store the message does not
name (to `settlement_suspense`, still owed a declaration). No balance is
touched - the money moved, it was the record that was lost. One row is left
unrepaired on purpose: a diamond audit insert, which is not a chip leg.

## 5. My own noise

152 rows from things that cannot happen any more: 58 from
`fn_ca_settle_hand_stacks_absolute`, retired at the Phase 6.3 gate because the
engine has written stacks in delta mode since 2026-09-04 19:00 and every one of
the 58 predates that; and 94 from replay runs superseded by the three migrations
I applied between them.

**One replay finding stays open**: the felt, -10.74 chips, table_stack. The
engine writes a hand's stacks and its rake and jackpot legs in two transactions,
so a population of hands always has stacks written and legs pending. It flips
sign and does not accumulate. It is chip standard item 8.5 and the engine
lane's to close. Resolving it to tidy the board is exactly the move that loses
it.

The 30 `fn_ca_escrow_vs_counter_check` rows are untouched: that detector's own
retirement note says its open rows are the epoch reset gate's list.

## Migrations

    20260906015217  the overlay a tournament was funded by is read from the journal
    20260906015837  the overlay leg has an index so the check stays fast
    20260906020707  the satellite seat a target was funded by is found by index
    20260906021514  the guarantees paid before the bank funded them are acknowledged
    20260906021758  a retired detector and a superseded run do not hold the board open
    20260906022011  the frozen pool baseline moves only with a reason written beside it
    20260906023024  a hand that cannot name itself by id still names itself by table and number
    20260906023900  every leg the journal was refused is written back
