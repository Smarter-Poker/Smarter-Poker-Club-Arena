# The Capped-Winner Collision Is Recorded, Not Replayed (2026-10-17)

Two agents root-caused the same outage in the same night and shipped two
different fixes for it:

- `20261017025359_a_satellite_winner_is_not_capped_by_the_satellite_it_won`
  (merged to main ~03:3xZ): passes the winner's own satellite seat as
  `p_exclude_table_id` to the cap load. It deliberately KEEPS the Diamond
  refusal for a winner with four OTHER games.
- `20261017033733_a_capped_diamond_satellite_winner_is_paid_not_held`
  (applied live 03:39Z, PR #7211): subtracts every live seat at the dying
  satellite from the cap load AND pays a still-capped Diamond winner the
  ticket's whole-Diamond value through the duplicate-qualification cash
  door, so the event always finishes.

`20261017033733` applied first. When the merged-migration applier dispatched
`20261017025359` at 04:16Z it was correctly REFUSED - "unexpected live body
(8fb5cdbc...)" - and committed nothing: the preimage it pins no longer
exists.

## The decision

The live behaviour (`20261017033733`) stands, for the reason the outage
itself proved: the stuck winner (a horse) held FOUR OTHER live tournaments.
Under the self-seat exclusion alone the event would still have been refused
and still be RUNNING, undealt and unpaid, hours later - the exact failure
Dan ordered removed that night ("THEY MUST 1000% OF THE TIME SELF HEAL AND
FINISH UP"). The self-seat exclusion that `20261017025359` exists for is a
strict subset of the live subtraction.

## The record

Version `20261017025359` is recorded in `supabase_migrations.schema_migrations`
with a supersession note, so the applier is never re-dispatched at a
preimage that no longer exists and the migration ledger reconciles. Its
file stays on main unchanged, as history: its intent is live, through the
stronger substitution. Nothing was committed by its refused apply and no
row it would have written is missing.

Its law test (`tests/a-satellite-winner-is-not-capped-by-the-satellite-it-won.law.test.ts`)
pins only that file's own text and stays green; the live behaviour is pinned
by `tests/a-capped-diamond-satellite-winner-is-paid-not-held.law.test.ts`.
