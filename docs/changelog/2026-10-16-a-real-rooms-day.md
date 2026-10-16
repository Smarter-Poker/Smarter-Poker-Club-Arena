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
- "TOURNAMENTS FROM 6PM -10PM SHOULD BE LARGER BUY IN, AND SUNDAY SHOULD BE JAM
  PACKED FROM 11AM TO 11PM WITH TOURNAMENTS, BIGGER BUY IN'S BIGGER
  GUARANTEES. AND MAKE SURE THE FREE BUY TOURNAMENTS ARE STILL RUNNING AT THE
  SAME TIMES EVERY DAY. AT 8:30AM, 12:30PM 4:30PM 8:30PM AND 12:30AM EVERY DAY."

## What was wrong

The daily board ran 53 starts a day on a 20-minute grid, three an hour around
the clock, and the clubs' weekly events and four 100 Guarantee Freerolls filled
the remaining slots: 69 scheduled starts a day, 21 of them between 1 and 8 AM.
On top of that the engine's satellite feeder opened a new satellite for the
dearest weekly events as soon as the previous one filled, at whatever minute
that was: 91 satellites on 2026-10-15, about one every 45 minutes all night.

The real US-facing rooms do not work that way. PokerStars NJ ran 17 events a
day, all between 1:30 PM and midnight Eastern; ACR one every 30 minutes from
2:30 PM to midnight Eastern; BetMGM and PokerStars NJ put the flagship daily at
7 PM Eastern (6 PM Chicago).

## What it is now (both clubs, Chicago time)

- One real tournament on every :00 and :30 from 8:00 AM to 1:00 AM, every day,
  and nothing between 1:30 AM and 8 AM. Monday to Saturday: 26 board events
  once each and nine weekly half hours (1:00, 9:00, 15:00, 19:00, 19:30, 20:00,
  21:00, 22:00, 23:00). Sunday: the board keeps eleven events outside 11 AM to
  11 PM, and the Sunday Funday series holds every half hour from 11 AM to
  11 PM.
- The five Free Buys run every day at 8:30 AM, 12:30 PM, 4:30 PM, 8:30 PM and
  12:30 AM (`FREE_BUY_SLOT_MINUTE`).
- 6 PM to 10 PM is the dearest part of the day: the Prime Time Main Event is
  30 + 3 at 6 PM (7 PM Eastern), the Nightly 10K is 35 at 7 PM Monday to
  Saturday (35 rebuys and one 35 add-on, 10,000 guaranteed), and every other
  event starting in that window costs 22 or more (33 on the marquee nights),
  bounty and guarantee scaled with it.
- Sunday Funday: fourteen new events from 22 to 109, guarantees 2,000 to
  7,500, plus the 7:30 PM PLO Opener, beside the Sunday 200, Warm-Up, Mystery,
  Main Event, High Roller PKO and Six-Card Closer.
- Retired: the Early Bird Freeroll, the Pre-Dawn Mystery Bounty, the Late
  Night Grind and the four 100 Guarantee Freerolls. New board events: Midday
  Turbo, Afternoon Deep Stack, Happy Hour Bounty, Dinner Break PLO.
- Every guarantee is the previous one doubled and rounded up to the next 500;
  an event that had none has 500. Free Buys guarantee 500, the 8:30 PM Prime
  Time Free Buy 1,000.
- Satellites start only on the :15 and :45, from tournament_schedules rows,
  into every event of 25 or more whose finish can seat a satellite winner. The
  rolling feeder stands down for the two board clubs
  (`ensureSatelliteHeadsUps`) and keeps serving every other club.

## Not yet: satellites into bounty, PKO and mystery events

The bounty-format events of 25 or more (Union Mystery Bounty, Union Grand
Championship, the Sunday Funday Bounty Builder, PLO PKO, PLO5 Mystery, Late
PKO, Night Owl, Mystery and High Roller PKO, Saturday Stackfest PKO and
Mystery, Friday Fight Night PKO, Monday Knockout, Tuesday Bounty Hunt, Friday
Five-Card Bounty) have no satellites yet. The satellite settlement
deliberately refuses those targets, because a seat booked entirely as prize
would seed an unfunded bounty head (the 2026-09-07 PKO shortfall). Seating them
correctly means booking the seat through the split-version-2 escrow leg
(prize + bounty + fee) in both settlement authorities, the seat entitlement,
the four-table-cap ticket branch and the receipts, with the guards and pinned
probes moved in the same change. That is its own money-path change and follows
this one.

## How the times move without doubling a date

Occurrences are spawned up to three days ahead (seven for the Sunday 200), so
the dates through Monday 2026-10-19 are already on the board under the
2026-10-16 timetable and keep it. Each moved row carries the times it had
(`previousStartTimes`) and, when it had moved before, the timetable before that
(`retiredStartTimes`). `resolveTimeChange` keeps a date on the previous times
when it already has one, and gives a date that already ran on the retired
timetable nothing more, so the second change in two days cannot add a third set
of starts to today. Events that did not exist before carry an empty
`previousStartTimes` and start on Tuesday 2026-10-20, the first date the new
timetable owns outright. The engine that reads these keys ships first; the
migration `*_a_real_rooms_day` follows once it is serving.

Pinned by `server/src/services/theBoardIsAFixedSchedule.law.test.ts` and
`server/src/services/FreeBuy.test.ts`.
