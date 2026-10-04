# A satellite's Rewards tab shows seats (2026-10-04)

## What was wrong

The tournament lobby's Rewards tab priced `tournaments.payout_structure` for
every event. A satellite does not pay that ladder. On FE93D011 ("Sunday Funday
Main Event Satellite", completed, pool 810) the tab read "2 Paid Places, Money
Bubble 3rd, 1st 63.52% 515, 2nd 36.48% 295". What `tournament_players`
recorded was seven unranked seat winners at 100 each, 8th place at 100 and 9th
place at 10. The tab stated money that was never paid.

## The server rule, and where it was read

`public.fn_ca_settle_satellite_cohort`, newest definition in
`supabase/migrations/20260925205909_a_satellite_seat_into_a_running_target_is_dealt_in.sql`
(first defined in this shape by `20260921095012_...`):

- `v_ticket_cost := round(target.buy_in_amount + target.buy_in_fee, 2)`
- `v_ticket_award_count := floor(v_pool / v_ticket_cost)` where `v_pool` is the
  satellite's own `prize_pool`
- `v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2)`,
  paid to the next finisher when it is above zero
- each award is delivered as `seat`, `ticket` or `cash`, each worth one ticket
- `satellite_seats` is the ADVERTISED count: the settlement refuses (P0403) if
  the pool does not fund that many tickets. It is not the number awarded.
- `payout_structure` is never read.

FE93D011 agrees: floor(810 / 100) = 8 awards of 100, remainder 10.

## What changed

`src/components/tournament/details/RewardsTab.tsx`, satellites only:

- Completed, with prizes recorded per player: the percentage ladder is replaced
  by the recorded awards. Seat winners (by `isRecordedSatelliteQualifier`) are
  listed first as "Seat", then the other paid finishers by finishing place,
  each with the recorded prize. The header note reads "N Players Awarded" and a
  "Seat Winners" tile replaces "Money Bubble".
- Not completed, or completed with nothing recorded per player: the ladder is
  replaced by "This Satellite Awards Seats Into The Target Event". The target's
  price is not on the row or in the tab's props, so no seat count is computed.
  The only figure quoted is the stored `satellite_seats`, labelled "Seats
  Advertised".
- "N Paid Places", "Money Bubble", "% Of The Field Paid" and "No Payout
  Structure Has Been Published" no longer appear on a satellite.

Every other event renders as before.

## Not done

A live seat count for a running satellite. It needs the target's buy-in and
fee, which the tab does not hold; adding that read was left out rather than
guessing a number.

Test: `tests/unit/aSatelliteRewardsTabShowsSeats.test.tsx`.
