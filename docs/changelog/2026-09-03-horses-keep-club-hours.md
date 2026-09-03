# 2026-09-03 - Horses keep club hours

Dan, 2026-09-03: "ALL CLUBS ARE RUNNING TOO MANY HORSES AT THE SAME TIME...
PRIME TIME 5PM-12AM HAS 45-60% OF THE MEMBERS IN THE CLUB PLAYING, MORNING
FROM LIKE 9AM-5PM SHOULD HAVE LIKE 20-25% AND LATE NIGHT, FROM 12AM-9AM
SHOULD SLOWLY TRICKLE DOWN... NOT ALL AT ONCE, BUT LIKE HORSES START
'ORGANICALLY' QUITTING AND GOING TO SLEEP FOR THE NIGHT. WE SHOULDN'T HAVE
MORE THAN 10% OF THE CLUB PLAYING BETWEEN 3AM-8AM. THEN THE NUMBERS SHOULD
START PICKING BACK UP GRADUALLY." Clock: America/Chicago. Denominator: the
club's horse roster. Curve numbers were his bands, tuned inside them.

## Measured before

14:05 Chicago: 728 of 1,000 horses seated across 1,532 open seats. Per seat
club: SHARK 236 of 584 (40%), JAQK 253 of 580 (44%), Deep Stack Society 239
of 416 (57%). Nothing in the fleet read the clock: `isActiveNow` was a
hash-derived UTC window that kept ~55% of horses eligible at every hour, and
the 2026-08-26 activity floor lifted the count whenever it fell under a third.

## What changed

- `server/src/services/HorseAttendance.ts` (new, pure): the curve
  (`attendanceFraction`, piecewise-linear, continuous, weekend prime +3pts),
  per-club target with a small 20-minute wobble so three clubs do not move in
  lockstep, a per-horse chronotype (wake and bed minute from the id hash, 15%
  night owls) that decides WHO is up, proportional arrivals and departures
  budgets so the room fills over ten to fifteen minutes and unwinds over an
  hour rather than snapping, and the yield clock for a waiting human.
- `HorseFleetManager.seedAllTables`: per seat club, counts distinct seated
  horses against `attendanceTarget(club, roster)`; a horse NOT yet seated in
  the club sits only while the club's arrivals budget for this cycle lasts,
  a horse already seated is free to add tables (multi-tabling is how a
  modest headcount still fills tables). Human rescue outranks the curve.
  The 1/3 activity floor (`fleetBoost`) is removed - the curve is now both
  floor and ceiling. Candidate pool uses `isAwake(id, chicagoMinute)`.
- `HorseSessionRotator.sendSleepersHome`: per club, anyone over target goes
  home, `departuresBudget` a cycle (15% of the excess, 1-8), earliest
  bedtime first; independently, a horse past its own bedtime racks up with a
  probability that rises the later it gets (capped at 4 extra per club per
  cycle so a coincidence never reads as a wave). Going home means leaving
  every cash seat in the club through `engine.leaveTable` (hand-boundary
  safe). A horse whose seats cannot all be released (a human's game that
  would go short, no live engine) stays up. Club rosters are re-read every
  10 minutes; a failed read keeps the last answer, no answer = curve not
  applied (fail open, like every gate in the fleet).
- Yielding to a waiting human (Dan, same day: "NOT RIGHT AWAY, AFTER A COUPLE
  HANDS... WITHIN A COUPLE MINUTES OF EACH OTHER... IT CAN'T BE OBVIOUS"):
  the queue still decides HOW MANY stand up; a per-table clock decides WHEN.
  First yield 2-4 minutes after a person appears in the queue, each further
  yield 1.5-3 minutes after the last, jittered per table. While the clock
  runs, nothing else at that table leaves.

## What this supersedes, and what it does not

- Supersedes the 2026-08-26 activity floor ("a minimum of 1 out of 3 horses
  should be playing") - deleted, not left to argue.
- Does NOT change the 2026-09-02 table-level rule (75% of tables full, 4
  tables per horse). Fewer horses at night means fewer tables can be full;
  that is what a room at 4am looks like. The fleet fills tables with the
  horses the curve allows.
- Tournament horse registration (`TournamentRecurringService`) still uses
  the old `isActiveNow` UTC window. Tournament seats COUNT toward the club's
  attendance (the fleet gates cash arrivals on the total), but tournament
  registration itself is not yet on the curve. Flagged for Dan.

## Tests

`server/src/services/HorseAttendance.test.ts` (18): curve inside every band
Dan named, dead zone under 10% with the wobble, continuity, Chicago clock
across CDT/CST, chronotype pool always wider than the curve, trickle pace,
wind-down reaches under 10% by 03:30 on the quota alone, yield clock timing,
wiring pins on both managers. `theFloorIsFull.law.test.ts` updated: the
certain departure is now gated on `yieldNow`.

## Verify after deploy (DB, not the health endpoint)

    select ts.club_id, count(distinct ts.user_id) seated
    from table_seats ts join profiles p on p.id = ts.user_id
    where ts.left_at is null and p.is_horse group by 1;

against roster x curve at the Chicago hour; and the engine log lines
`[HorseFleet] Attendance (Chicago HH:MM): <club> seated/target of roster` and
`[SessionRotator] Attendance ...` / `going home`.
