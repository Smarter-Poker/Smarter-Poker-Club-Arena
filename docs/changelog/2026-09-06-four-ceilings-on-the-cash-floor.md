# Four ceilings on the cash floor, three of them invented (2026-09-06)

Dan, 2026-09-06, on the four dials below: "PROCEED... WITH EVERYTHING YOU
NEED TO GET DONE."

## What was measured

Read from production between 09:29 and 09:45 CDT, after the audit board in
`docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md` section 0:

- 1,000 horses. **510 at the four-game cap.** 175 seated at cash, an average
  of 1.66 tables each: 83 at one table, 69 at two, 21 at three, **2 at four**.
  Dan's rule (2026-09-02) is four tables at once.
- 2,111 tournament bookings across 897 players. 1,377 for events more than
  six hours away, 466 more than a day away, the furthest 68 hours (the 6 AM
  freeroll three days out; Sunday Funday Main Event at 11 hours; Monday Rebuy
  Rush at 29). **217 horses were at the cap on bookings alone.**
- `stable_hand_membership_tags.max_tables`: 333 tags at 2, 576 at 3, 198 at
  4, 473 tourney-only at 1. **837 cash-eligible horses tagged below four.**
- Engine log, every fleet cycle: `not sittable ... aggregate_exposure=277
other_club=127 sit_cap=21`. Opening feeders logged `sittable 15, wanted 6,
selected 0` cycle after cycle - the fifteen unexposed horses were the ones
  asleep, because every horse that was awake was already at three shares of
  its bankroll.
- Feeders, three hours: 25 opened, 14 live, 11 abandoned.

Every feeder opens on a count of buyers that these ceilings then refuse at
the chair. The handoff called the feeder ratio "open and unexplained"; this
is the explanation.

## The four dials, and what was done with each

| Dial                          | Was                                                   | Now                                                                | Where                                                                                                 |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A booking counts as a game    | from registration                                     | from 60 minutes before the start (NULL start = seat-first, always) | `fn_concurrent_game_load` clause (2), migration `20260906144448`; `HorseGameLoad.ts` `bookingIsAGame` |
| `max_tables` per cash persona | grinder 4, regular 3, weekend 3, mixer 2, night owl 2 | 4 for every cash-mode persona                                      | `StableHand.ts` `MAX_TABLES_BY_PERSONA`; the 1,107 live cash-mode tags updated in the same migration  |
| `AGGREGATE_EXPOSURE_MULTIPLE` | 3 shares                                              | 4 shares                                                           | `HorseBankroll.ts`                                                                                    |
| Tourney-only lane share       | 30% of tags (42% of horses)                           | unchanged                                                          | Dan's 2026-08-26 ruling; not touched                                                                  |

The first three had nothing written behind them. `PHASE_MAX_BB` (#3213) was
the same shape: a restriction in code that read as a design decision.

## What does NOT change

**Never more than four LIVE seats.** The client shows four tabs
(`MultiTablePage.MAX_TABLES`), `fn_enforce_four_table_limit` still refuses
the fifth seat, tournament or cash, and `fn_enforce_booking_game_cap` still
refuses a booking that would make five. The booking window changes WHEN a
booking starts to occupy one of the four, not how many there are.

## The gap the window opens, and how it is closed

With the old rule a booked player could never take a chair they would have
to give back. With the window, a horse can hold four cash seats while its
tournament is two hours out; at the start the fifth live seat is refused and
the horse is seated late by `ensureLateRegSeated`, blinded off until a cash
session happens to end. A person does not do that.

`HorseTournamentCommitment.ts` + `HorseSessionRotator.leaveCashForTournaments`:
for every horse whose live seats plus imminent bookings exceed four, the
rotator stands it up from the cash seat it has held longest (a table with no
person at it first). Between sixty and fifteen minutes out it is a hazard
spread evenly over the window, one seat per cycle, so a room does not stand
up in unison at :00; inside fifteen minutes it is certain. Through
`engine.leaveTable`, the door a human uses. Outside the rotator's realism cap,
like the lone stand: a commitment, not the floor thinning itself.

## Proof

Rolled-back probe of the migration body against production (psql,
`BEGIN ... ROLLBACK`, 09:47 CDT):

    horses at the four-game cap:   475 -> 3
    cash-mode tags at four:        198 -> 1,107 (2: 333, 3: 576 -> 0)
    tourney-only tags at one:      473 -> 473
    a horse capped by bookings alone (…0044): load 4 -> 0

After ROLLBACK the tags and the function were unchanged (re-read).

Tests: `HorseGameLoad.test.ts` (the window, the NULL branch, the live
defect), `HorseTournamentCommitment.test.ts` (the hazard, the certain point,
the leaving order, the rotator wiring), `HorseAggregateExposure.test.ts` and
`HorseBankroll.test.ts` (four shares), `StableHand.test.ts` (every cash
persona is four).

## What to measure after the :55 cutover

1. `select count(*) from profiles p where is_horse and fn_concurrent_game_load(p.id) >= 4` -
   the migration applies at merge, so this drops before the engine moves.
2. Tables per seated horse (the query in the handoff section 3) - should
   climb from 1.66 toward 3-4 over the following hour.
3. `feeder_live / feeder_opened` over the hour, against 14 / 25.
4. `[SessionRotator] tournamentLeaves=` lines in the hour before the Sunday
   Funday events (11-13 hours out as this was written).
5. `[HorseFleet] not sittable` - `aggregate_exposure` should fall from 277.
