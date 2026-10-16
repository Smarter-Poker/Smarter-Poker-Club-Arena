# A real room's day: the schedule, the guarantees and the satellites (2026-10-16)

Dan, verbatim:

- "WHY THE FUCK DO WE HAVE A TOURNAMENT EVERY 20 MINUTES IN THE MIDDLE OF THE
  NIGHT, LOOK AT REAL ONLINE POKER SCHEDULES FROM THE TOP SITES, DO YOUR
  RESEARCH AND COME BACK WITH A REALISTIC TOURNAMENT SCHEDULE FOR ME."
- "WE NEED A DAILY 7PM TOURNAMENT THAT IS A 35 REBUY ADD ON WITH A 10K
  GUARANTEE MONDAY - SATURDAY. DOUBLE ALL THE OTHER CURRENT GUARANTEES, THEN
  ROUND THEM ALL UP TO THE NEAREST 1000 OR 500. NO 25 75 OR 50 AMOUNTS."
- "SATELLITES ARE NEVER 'PRIME TOURNAMENTS'. YOU SHOULD ALWAYS HAVE A REAL
  TOURNAMENT RUNNING IN THOSE SPOTS, ALL SATELLITES SHOULD START AT THE :15 OR
  :45. EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE SATELLITES INTO
  IT."

## What was wrong

The daily board ran 53 starts a day on a 20-minute grid, three an hour around
the clock, and the clubs' weekly events and four 100 Guarantee Freerolls filled
the remaining slots: 69 scheduled starts a day, 21 of them between 1 and 8 AM.
On top of that the engine's satellite feeder opened a new satellite for the
dearest weekly events as soon as the previous one filled, at whatever minute
that was: 91 satellites on 2026-10-15, one about every 45 minutes all night.

The real US-facing rooms do not work that way. PokerStars NJ ran 17 events a
day, all between 1:30 PM and midnight Eastern; ACR one every 30 minutes from
2:30 PM to midnight Eastern; BetMGM and PokerStars NJ put the flagship daily at
7 PM Eastern (6 PM Chicago).

## What it is now (both clubs, Chicago time)

- One real tournament on every :00 and :30 from 8:00 AM to 1:00 AM, every day:
  26 board events once a day (25 on Sunday, when 1 PM is the Sunday 200), plus
  the clubs' weekly events on 1:00, 9:00, 13:00 (Sunday), 15:00, 19:00, 19:30,
  20:30, 21:00, 22:00 and 23:00.
- Nothing starts between 1:30 AM and 8 AM.
- The Prime Time Main Event moves to 6 PM (7 PM Eastern). The new Nightly 10K
  (NLH) runs Monday to Saturday at 7 PM: 35 to enter, 35 rebuys and one 35
  add-on, 10,000 guaranteed.
- Retired: the Midnight Free Buy, the Early Bird Freeroll, the Pre-Dawn Mystery
  Bounty and the four 100 Guarantee Freerolls. New board events fill the half
  hours they left: Midday Turbo (1 PM, Monday to Saturday), Afternoon Deep
  Stack (2:30 PM), Happy Hour Bounty (5:30 PM), Dinner Break PLO (6:30 PM), and
  the Sunday Funday PLO Opener (7:30 PM Sunday).
- Every guarantee is the previous one doubled and rounded up to the next 500;
  an event that had none has 500. Free Buys guarantee 500, the 8 PM Prime Time
  Free Buy 1,000.
- Satellites start only on the :15 and :45, from tournament_schedules rows,
  into every event of 25 or more whose finish can seat a satellite winner:
  Prime Time Main Event, Nightly 10K, Friday Night Feature, Saturday Night Big
  Stack, Sunday Funday Warm-Up, Main Event, PLO5 Big Stack and Six-Card Closer,
  and the Sunday 200 Deep Stack. The rolling feeder stands down for the two
  board clubs (`ensureSatelliteHeadsUps`), and keeps serving every other club.

## Not yet: satellites into bounty, PKO and mystery events

Five events of 25 or more are bounty formats: Union Mystery Bounty, Union Grand
Championship, Sunday Funday Mystery, Saturday Stackfest PKO and Sunday Funday
High Roller PKO. The satellite settlement deliberately refuses those targets,
because a seat booked entirely as prize would seed an unfunded bounty head (the
2026-09-07 PKO shortfall). Seating them correctly means booking the seat
through the split-version-2 escrow leg (prize + bounty + fee) in both
settlement authorities, the seat entitlement, the four-table-cap ticket branch
and the receipts, with the guards and pinned probes moved in the same change.
That is its own money-path change and follows this one.

## How the times move without doubling a date

Occurrences are spawned up to three days ahead (seven for the Sunday 200), so
the dates through Monday 2026-10-19 are already on the board under the
2026-10-16 timetable and keep it. Each moved row now carries the times it had
(`previousStartTimes`) and, when it had moved before, the timetable before that
(`retiredStartTimes`). `resolveTimeChange` keeps a date on the previous times
when it already has one, and gives a date that already ran on the retired
timetable nothing more, so the second change in two days cannot add a third set
of starts to today. The events that did not exist before (the four new board
events, the Nightly 10K and the Sunday Funday PLO Opener) carry an empty
`previousStartTimes` and start on Tuesday 2026-10-20, the first date the new
timetable owns outright, so they never double a slot an old-timetable date
already holds. The engine that reads `retiredStartTimes` ships first; the
migration `20261016223725_a_real_rooms_day` is applied once it is serving.

Pinned by `server/src/services/theBoardIsAFixedSchedule.law.test.ts`.
