# A cancelled freeroll's last knockout candidate is closed (2026-10-26)

## What was left

One knockout record, from the "$100 Freeroll - 12:00 PM" of 2026-09-18, still
read `pending` 37 days later. The player's stack went to 0 in a hand on
2026-09-18; the event was cancelled on 2026-09-27 before the door resolved
the bust. The cancellation refunded the field and marked every entrant
eliminated, but left the knockout record open.

It was the only unresolved record of any finished or cancelled event, and the
only record older than a minute anywhere in the table.

## Why the cause is already closed

Both cancellation paths (`atomic_cancel_tournament` and
`fn_poker_diamond_tournament_cancel`) now refuse any event that has started
or dealt a hand. A knockout record exists only for a dealt hand, so a
cancellation can no longer leave one behind. `20261015024956` had already
stopped the stalled-door alarm counting this row.

## Fix

`supabase/migrations/20261026042452_a_cancelled_freeroll_s_last_knockout_candidate_is_closed.sql`
closes the one record as `eliminated` at the cancellation instant, which is
what the event's own roster already says. It refuses unless the board is
exactly as read, and asserts no finished or cancelled event is left with an
open record. Proved first in a rolled-back transaction on production: one
row changed, none left. No money moves (a freeroll, its escrow closed at
exact zero, no trigger on the table).
