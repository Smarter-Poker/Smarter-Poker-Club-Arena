# The Club Programme Mirrors The House

**Date:** 2026-09-03
**Scope:** `server/src/services/TournamentRecurringService.ts`,
`ScheduledTournamentService.ts`, `HorseFleetManager.ts`, `HorseSessionRotator.ts`,
`HorseBehavior.ts`, `liveTournamentTableRecovery.ts`, `GameServer.ts`,
`src/components/club/CreateTournamentModal.tsx`, `src/services/TournamentService.ts`,
three migrations.

## Dan's Rulings, And Where Each One Lives

**1. "Create a MTT tourney schedule that mirrors the Midway Union."**
Migration `20260903171313` copies every active Midway Union schedule row that is
not a spin into Deep Stack Society as a standalone club row: same names, days,
UTC times and config, `union_id` null. 63 rows joined the club's existing 84.
Satellites resolve their target by name inside the club, so the club's own
"Sunday $200 Deep Stack" is fed by the club's own satellites.

Mirroring the schedule was worth nothing while the events could not fill.
`topUpWithHorses` still refused every non-house top-up that was not seat-first,
on the written belief that `registerHorses` drew from an un-scoped pool. That
belief was stale when it was written down (by me, in #2850): `registerHorses`
has narrowed to `clubMemberIdsForTournament()` since 09-01. The refusal only
ever emptied the club's schedule: 59 events averaging 0.3 entrants, twelve
spawned that day at zero, while the pre-start ramp asked for a field every 45
seconds and was told no. The gate is gone for every format; the pool is the
rule.

**2. "Close any tables over 2/5."**
Deep Stack Society ran a cash ladder to $50/$100. Everything above 2/5 had
never seated a horse and never could: `HorseBankroll` wants 12 to 40 buy-ins to
sit and the club's horses hold a median of 10,000 chips. The same migration
closed the 47 that were empty and flagged the 12 that had horses in hands with
`settings.retire_when_empty`. A running table is not cut off from SQL: the
fleet stops seating anyone there (`isRetiringTable` puts it in
`surplusTableIds`), the session rotator walks one horse out per cycle through
the engine's own `leaveTable()` (folds mid-hand, cashes out at the end of the
hand), and `retireSurplusTables()` closes the row once it is empty.

**3. "Add in all the spins (mirror Midway Union)."**
The club board already offered the house `SPIN_CONFIGS`, filtered by its own
stake cap. What stopped it was the budget: one `BURST` of 12 for the whole pass,
the house first, and the house is never full. From the engine log at 17:02 UTC:
`Opened 12 spin(s) for house fade0000; 38 still to fill`, and no owner line at
all. The house spent all twelve every tick and the owner loop `break`-ed
before Deep Stack Society was offered a game. That is exactly what "DSS spins
stopped" looked like. Every board now gets `boardBudgetShares()` of BURST
before anyone spends: with one activated club, six a tick each.

**4. "Wait 60-150 seconds to allow a human to play, before a 3rd horse can
join."**
Three places hand a seat-first game its human window and they disagreed:
`seatFirstHumanWindowMs` (60-180), `freshHumanWindowMs` (60-180) and
`fn_repair_seat_first_games` (45-90). All three say 60 to 150 now (migration
`20260903171736` for the SQL). The window is the game's `start_time`; the
past-start top-up seats the last horse only once it has passed.

**5. "Add the higher stakes for Midway Union, cap it at 25-50."**
`DEFAULT_TABLES` gains NLH 5/10, 10/20 and 25/50 and PLO4 5/10. Measured
first: 48 high-band horses across Shark, JAQK and Midway, all rolled for 5/10
and 10/20 and 35 of them for 25/50. Four configs at up to three tables each is
what a pool of about thirty cash-lane horses can keep populated. 25/50 is the
top by order; nothing above it is added.

**6. "Add satellite sit n go's to the heads up area, where players can win a
ticket into bigger buy in MTTs."**
A satellite heads-up is a two-seat game on the heads-up board with
`tournament_type = 'SATELLITE'`, `satellite_target_id` and `satellite_seats =
1`. Its variant stays `'sng'` on purpose: every seat-first reader (the
GameServer fast start, `fn_take_seat_and_buy_in`, the stuck-finish sweep,
table sizing) knows a heads-up as `variant === 'sng' && max_players <= 2`, and
the finish path knows a satellite by `tournament_type === 'SATELLITE'`. So it
opens with one horse, holds the second seat for the human window, and at the
finish `processSatelliteAwards` registers the winner into the target through
the same path the scheduled satellites use, with anything beyond the seat paid
to the runner-up as cash. One feeder per dear target, three per owner, targets
being open events in the owner's own scope that cost at least 20 to enter and
start between thirty minutes and a week out. The buy-in is the smallest ladder
step whose two prize shares cover one ticket after the heads-up rake, so a
feeder never overlays. The lobby needs no change: a cap of two is a heads-up
whatever the label, and the name carries the SATELLITE badge.

**7. "All MTTs should be on a recurring weekly cycle ... Create Event ...
repeat weekly, as a check box option."**
The house programme already repeats weekly through `tournament_schedules`.
Create Event now has a single **Repeats Weekly** checkbox: the event repeats on
the weekday and UTC time of its own start, through the same schedule row the
Recurring Tournament section writes, published a week ahead so next week's
copy is on the board the moment this one exists, and spawner-owned so this
week's occurrence is never made twice. The older Restart Every path is widened
from a day to a week too (`RESTART_WEEKLY_MINUTES`; migration
`20260903172703` for `fn_create_tournament_governed_legacy`), and a weekly
clone is anchored to the last `start_time` rather than to when the hand ended,
so a three-hour Sunday event stays a Sunday event.

**8. "Don't worry about the payout shortage for right now."** Left alone.

## Verification

- `server/src/services/theClubProgrammeMirrorsTheHouse.test.ts` pins every
  rule above that lives in this process; the four client pin suites that
  described the old budget and the old window were rewritten to the new rule.
- Live, before the engine picked this up: 147 Deep Stack Society schedule
  rows, 179 open cash tables (was 226), 12 flagged to retire, spin pool active
  with 20,319 on the wallet, no club spin board.
- After the next engine restart: `Opened N spin(s) for club 2a1132b9` in the
  log, the club's flagged tables empty and close, and the club's scheduled
  events show a field on the ramp.
