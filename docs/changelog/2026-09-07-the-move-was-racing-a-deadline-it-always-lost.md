# The move was racing a deadline it always lost

2026-09-07, continuing the must-move audit. Three migrations, and the second one
handed me the third.

## 1. Expiry had no reason, so nobody could see what it was hiding

Every terminal state of a seat move carried a reason except the one that
mattered: `destination_unavailable`, `destination_full`, `player_not_seated`,
`deadlock detected` - and 29 `expired` rows over six hours with `note` NULL.

Three completely different failures land in expiry and the row could not tell
them apart: the player left before the hand boundary, the player busted into a
rebuy window, or the engine never executed a move it was handed. The first two
are ordinary. The third is a defect, and it had been invisible for as long as
the column had been NULL.

Expiry now says which. Within four minutes of the migration landing, six moves
expired and **every one of them said `engine_did_not_execute_before_expiry`** -
the player still seated, still holding chips, the boundary simply not there yet.

That single line turned a shrug into a lead.

## 2. So why had no boundary arrived? Because a hand takes 227 seconds

Measured across all 114 live cluster tables with two or more players:

|                                     |           |
| ----------------------------------- | --------- |
| average hands in 30 minutes         | 9.9       |
| average seconds per hand            | **226.7** |
| tables under 10 hands in 30 minutes | 74 of 114 |
| tables over 30 hands in 30 minutes  | **0**     |

And `cash_seat_moves.expires_at` had the column default `now() + '00:03:00'`.

**The deadline was shorter than the average hand.** Every promotion the
controller planned was racing a clock it usually lost: the move expired, the
planner re-planned it on the next tick, and it expired again. That is the whole
explanation for feeders sitting on players while mains had open seats - a
symptom I had already checked twice and twice found "planned, waiting for a
boundary", without asking whether the boundary would arrive before the deadline.

The window is now derived from the table's own recent cadence - four
hand-lengths of its last three intervals, floored at the old three minutes so
nothing gets shorter than today, capped at fifteen so a table that has gone
quiet cannot hold a move for ever. Live afterwards: 3.0 to 15.0 minutes,
averaging 4.9 across 159 tables. The column default is dropped in the same
migration, because a default and a trigger both owning one value is how they
disagree six months later.

CLAUDE.md 1.1.7 already says this: **a number tuned to hardware and written down
as a constant outlives the hardware.** Three minutes was right for a table
dealing a hand a minute.

### And this one is a symptom fix, which it says out loud

227 seconds a hand is not normal; a healthy online table deals one every 40-60
seconds. The reason is the engine core, and it is the same finding as this
morning's frozen governor metric: the event-loop governor has been pinned at its
**0.2 floor** with p50 loop delay of **350-650 ms**. It is shedding as hard as it
can and the core is still out of headroom. That is capacity work and a larger
piece; what this migration stops is a player being punished for it.

## 3. A transient failure is not a refusal

`fn_cash_seat_move_execute` ended with a bare `WHEN OTHERS` that cancelled the
player's move and wrote `SQLERRM` into its note. Right for a real refusal - the
destination filled, the player is gone. Wrong for the three states that mean
"the database was busy, try again": `40P01` deadlock, `55P03` lock timeout,
`40001` serialization. Eleven moves in six hours were cancelled with note
`deadlock detected`.

The cost is not one lost move. The planner's back-off then refuses to re-plan
that player for sixty seconds - a deliberate rule, so a refusal is not retried
every five seconds - so a database hiccup became a player watching an open main
seat for a minute. **An infrastructure fault should never be charged to a
player.** Those three states now leave the move `pending` for the next boundary,
bounded by its own `expires_at`, using the same taxonomy the tournament side
already had in `completedFlip.ts`.

## How these were applied

`fn_cash_cluster_tick` is 37,872 characters with exactly one expiry site.
Retyping a body that size is how it acquires a typo nobody sees, so both
function changes are **asserted single substitutions** on the definition the
previous migration installed: each fails if its search text is not found exactly
once, and asserts the result afterwards. The first draft of a different
migration earlier today aborted because its assertion matched its own fix; that
is the behaviour you want from an assertion, and it is why these carry them.

## Files

- `supabase/migrations/20260907171507_an_expired_move_says_what_it_was_waiting_for.sql`
- `supabase/migrations/20260907171656_a_transient_failure_is_not_a_refusal.sql`
- `supabase/migrations/20260907171945_a_move_waits_as_long_as_the_table_takes.sql`

All three applied and recorded on production.
