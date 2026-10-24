# server/src/services/theBoardIsAFixedSchedule.law.test.ts

Dan, 2026-10-15 and 2026-10-16: "PUT THEM ON A HARD CODED SCHEDULE" and "I WANT ALL HARD CODED SCHEDULED EVENTS ONLY", for the Midway Union and the Diamond Arena. The law pins that the board (five Free Buys, 15 lobby MTTs, 5 union MTTs, 53 fixed America/Chicago starts a day per club) is hard coded in server/src/config/fixedBoard.ts and written into tournament_schedules by the engine itself before it reads a schedule, so a schedule can never run ahead of the code that builds it; that every hard-coded event builds the exact row the old board timer built, in both clubs; that the old timers stand down for the Midway Union; that the Prime Time Free Buy charges a 1 chip rebuy and add-on; and that a Diamond Arena freeroll's rebuy and add-on are 100 Diamonds.

Owner October 22: both rooms emit 250 for morning/midnight and 500 for the other Free Buys on every weekday; existing registered contracts remain protected.
