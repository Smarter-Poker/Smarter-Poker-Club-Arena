# 2026-09-07 - A seat-first board sells its seats once

35 heads-up events took between 3 and 32 PAID entries. The worst,
`53e50799`, is a two-handed sit-and-go holding `prize_pool` 1520.00 and
`total_rake` 80.00 - exactly 32 x (47.50 + 2.50). Every one of the 35 was all
horses, and under CLAUDE.md 10.5 that is 35 events where real club chips bought
a seat that did not exist.

## The reading I got wrong first, and how the data refuted it

0 of the 982 heads-up events after the phase-2 lock fixes were overfilled,
against 31 of the 3,654 before. I reported that as "consistent with a fix",
and it was not: the hourly histogram shows these are not a background rate at
all. **31 of the 35 fall inside two hours** - 25 inside the 11:00 hour alone,
out of only 45 heads-up events that hour - and the burst ended at 11:20, four
hours BEFORE those migrations were applied at 15:27. A rate computed across a
window containing one burst will always show the burst "fixed" by whatever
happened next (CLAUDE.md 10.86).

## The cause, in the guard that was meant to prevent it

`fn_enforce_tournament_capacity` has guarded `tournament_players` all along,
and its count was:

```sql
AND COALESCE(status,'registered') NOT IN
    ('eliminated','winner','left','withdrawn','cancelled','refunded','busted')
```

commented "LIVE entrants only. A player who busted ... must not hold a seat
against the next one." **That is the right rule for a seat and the wrong rule
for an entry.** On an MTT the two never diverge enough to matter. On a
two-handed board they diverge immediately: both seats sell, someone busts, the
live count falls to 1, and the guard admits - and charges - another entrant
into an event already sold. Then again. Up to 32 times.

`tournaments.current_players` is blind in the same way and for the same
reason: `fn_sync_seat_first_player_count` overwrites it with the live SEATED
count on every seat change, so the registration doors' own
`current_players >= max_players` pre-check could never see the entries either.
Two counters that mean "how many are here right now", asked how many have
entered.

## The fix (20260906233722)

The count, inside the guard that already existed - not a second guard beside it
(10.8), and not a detector (10.11).

- a seat-first board counts **every** row; multi-table events keep the live
  count, so nothing else changes;
- the count is taken with the tournament row locked `FOR NO KEY UPDATE`, parent
  before child, so two entries arriving together cannot both find room;
- `sng` joins `spin` in the definition of seat-first, matching the seat-count
  function - every one of the 35 was `sng` and qualified only on the `<= 2`
  half;
- `fn_tournament_entry_cap_reached` gives both registration doors one
  definition of "full" to ask, taking the GREATER of the entry count and the
  counter so it can only ever be stricter than the test it replaced;
- `atomic_tournament_register`, which is called from the browser, gets the
  tournament row lock and a capacity test - it had **neither**.

Measured before applying: of 316 open capped events, 1 is at its cap today and
the same 1 is at its cap under the new count. **Zero events change from
admitting to refusing.**

The migration proves it against live rows: it takes a finished seat-first event
already at its cap, puts it back to REGISTERING inside a subtransaction it
rolls back, attempts one more entry, and aborts if the entry is admitted. It
applied at 00:00:43 with that proof passing.

## The money

All 35 conserve - money in equals money out - so nobody is owed anything and
nothing was settled here. Two of the 35 are satellites, where
`tournament_payouts` mixes seat awards (prize_liability -> prize_liability
transfers) with cash credits, so summing that column against `prize_pool` was
never the right comparison for them.

## One regression, mine, found and fixed in a minute

Replacing `atomic_tournament_register` fired the estate's `[autorevoke]` event
trigger, which strips PUBLIC and anon EXECUTE from a function as it is created.
That function had only ever been reachable through the Postgres default - a
PUBLIC grant nobody had written down - so the replacement left it executable by
nobody. Caught by reading the catalogue immediately afterwards, not by a
player: `20260907000141_the_browser_door_states_who_may_execute_it` grants it
to `authenticated` and `service_role` (not `anon`, which the old PUBLIC grant
did allow). Registrations continued throughout - 45 in the minute concerned -
because the horse and human doors run as other roles.

The lesson is the one `20260906153725` already wrote from the other direction:
a permission nobody has written down is a permission that survives only until
the next `CREATE OR REPLACE`.
