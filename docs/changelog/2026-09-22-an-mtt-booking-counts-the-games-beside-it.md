# 2026-09-22 - an MTT booking counts the games it will be played beside

Date: 2026-09-22. `server/src/services/TournamentRecurringService.ts` and its
tests only. No migration, no trigger change, no change to Spins or SNGs.
Nothing was deployed by this commit.

## What was wrong

Horses were being dealt into more than four games at once. Measured on
production at 12:00 UTC: 103 horses held more than four open seats, 114 seats
above their fourth. Every one of those 114 was an MTT seat, and 112 of them had
been booked more than an hour before the event started (median 13 hours).
Horse 7f554d21 held seven chairs: three in tournaments frozen since
2026-09-18, then four freezeout MTTs on 2026-09-19, all booked between 08:30
and 08:47 that morning.

The four-game cap is asked only when a horse registers, and at registration a
booking counts as a game only in the hour before its event starts
(`fn_concurrent_game_load` clause 2, mirrored on the server by
`REGISTRATION_LOAD_HORIZON_MS`). The MTT pre-start ramp registers fields up to
72 hours ahead, so a horse holding three seats could take four bookings for
the same afternoon, one at a time, and none of them was a game yet to the
others. At the start, `fn_enforce_four_table_limit` lets every entrant take
its chair (the cap is at the door, not at the chair, 2026-09-09), and the
pre-start cleanup can only stand a horse up from cash. Frozen tournaments keep
their seats, so the excess stays.

## What changed

`registerHorses` now takes the persisted row of the event it is filling. For
an MTT or satellite field (format contract `mtt-v1` or `mtt-v2`) a horse is
also refused when its open tournament seats plus its other pending bookings
that start within `MTT_OVERLAP_WINDOW_MS` either side of the event's start
already come to four. Cash seats are not counted, because the rotator sheds
them before a start.

`MTT_OVERLAP_WINDOW_MS` is six hours, an estimated MTT duration. It is a fixed
window around the event rather than a count of every far booking: counting a
booking from the moment it is made is the rule Dan rejected on 2026-09-07,
when it held 615 of 1,000 horses out of every open board. A booking for next
Sunday still costs nothing today; a fifth game on the same afternoon can no
longer be booked.

A refused horse is skipped exactly as a horse at the four-game cap is skipped,
and the number of entries the registrar asks for is unchanged. The empty-pool
warning names the new exclusion as `mtt-overlap`. The read behind the rule
(`horseTournamentCommitments`) pages like `horseLoadMap`, is held once per
discovery pass, and declines the pass when it cannot be read whole.

Spins and SNGs register exactly as before, the one-hour window for the
seat-first boards is unchanged, and the database triggers are unchanged.

## Replayed against production (read-only)

- The 103 current over-cap horses: the rule would have refused the booking
  behind 42 of the 114 fifth-plus seats at the moment it was made. Replaying
  each horse's MTT and satellite bookings of the last six days in order, 68 of
  the 114 excess seats would not exist and 46 would remain, on 43 horses.
  Most of the remainder sits beside events that started more than six hours
  earlier and never finished, which the six-hour estimate cannot see, or
  beside Spin and SNG seats taken after the booking, which this change leaves
  alone by decision.
- Overlay risk: of 2,950 horse MTT and satellite registrations in the last
  three days (273 events), 129 would have found no eligible horse under the
  rule, in 52 events. 83 of them were in 28 guaranteed events. The same method
  finds 2 under the current rule. The median eligible pool at a registration
  falls from 30 horses to 10, because frozen tournament seats now count
  against every MTT.

## Tests

`MttOverlapCap.test.ts` covers the measured 7f554d21 case (09:16, 11:00,
17:00 and 23:00 registered in that order; only 09:16 and 17:00 register),
cash seats not counting, the inclusive six-hour boundary, a horse with four
tournament seats never registering for an MTT or satellite, Spin and SNG
registrations unchanged, a refused horse dropped exactly as the four-game cap
drops one, and an unreadable read declining the pass.
`MttTicketQuotaRecovery.test.ts` stubs the new read in its harness.
