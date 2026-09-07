# 2026-09-07 - a registration days away is not a game today

Seat-first boards (Spins, Heads-Up, SNGs) were filling slowly or not at all:
160 boards open with 36 of 367 seats paid, 73% of the afternoon's boards taking
more than ten minutes to start, `pickFreeHorses` answering "0 of 3 claimable"
and `SEAT-FIRST BOARD CANNOT FILL ... top-up added 0 of 1 needed` two hundred
times per half hour - and a human at one of those boards left waiting for
opponents that existed.

Measured on the live fleet at 22:30 UTC: 615 of 1,000 horses read as "at
capacity" (load >= 4), and 2,092 of their load units were REGISTRATIONS in
events that had not started - 108 horses booked for "Sunday $200 Deep Stack"
six days out, 110 for "Wednesday Feature" three days out, 290 for a freeroll an
hour away. `horseLoadMap` counted every ANNOUNCED/REGISTERING booking as one
of the horse's four concurrent games, so a booking for next Sunday held a
chair a horse could have been sitting in now.

The registration read is now bounded: a booking counts only when its event
starts within `REGISTRATION_LOAD_HORIZON_MS` (30 minutes - longer than any
seat-first game, shorter than any registration ramp), or when `start_time` is
null (a seat-first game that starts when full, which is deduped against its
own seat anyway). The pure counting in `buildHorseLoadMap` is unchanged. The
same PostgREST query against production returns 124 rows bounded vs 2,077
unbounded. Two pins added to `HorseConcurrency.test.ts`; 53 tests in the
horse concurrency / four-table / seat-first files pass; `tsc` clean.

Acceptance: open seat-first boards and their time-to-start over the hour after
deploy, and `seat_first_human_waiting` per half hour, against the numbers above.
