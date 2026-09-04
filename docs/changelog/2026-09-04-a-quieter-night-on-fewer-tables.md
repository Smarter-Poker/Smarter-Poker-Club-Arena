# A quieter night, on fewer tables

**2026-09-04.** Dan read the first night the occupancy curve was actually
enforced and gave four instructions. All four are here.

> "there should not be 89 people playing in the middle of the night, cut that
> from 10% to 5%. thats a more reasonable and accurate number we should see...
> yes close all those tables. drain first, and never kick anyone. fewer
> tables, more players at each table. late night shouldn't have any 2-3 handed
> games."

## 1. The night is 5%, not 10%

`nightCap` was 10% of the population and is now 5%. It is the only night knob
that needed to move: the curve itself reads 10, 8, 7, 8 and 9 percent across
03:00-08:00, so a 5% ceiling binds every one of those hours and the whole
window lands on 5%.

| Host               | population | was | now    |
| ------------------ | ---------- | --- | ------ |
| Midway Union       | 584        | 58  | **29** |
| Deep Stack Society | 416        | 41  | **20** |

A test pins the constant, the two numbers, and the fact that the cap rather
than the curve is what decides every hour of the window.

**Not changed, and worth Dan seeing:** the shoulder hours are outside the night
window and keep their curve. Midnight is 35% of the population, 01:00 is 28%
and 02:00 is 16% - so around 2am Midway Union may still carry 93 bodies before
the 5% ceiling takes over at 03:00. If "middle of the night" is meant to start
earlier than 03:00, that is a separate change to the window and not one an
agent should make on its own.

## 2. The 89 excess tables close, by draining

The estate already had exactly the mechanism Dan described, built on
2026-09-03 for "close any tables over 2/5": a table marked
`settings.retire_when_empty` gets no new horses, `HorseSessionRotator` walks
its horses out through the normal Leave Table path, and `retireSurplusTables`
closes it **only once it is genuinely empty**. A table with anybody at it is
left alone and retired on a later cycle.

So the executor does not close anything. It marks the planner's `close` list
and the fleet's own drain does the rest. Nobody is moved off a seat, and the
close itself sets `status = 'closed'` rather than deleting the row, so the
`trg_auto_cashout_on_table_close` trigger still covers any human seat.

The list is entirely the unusual games - short deck, pineapple, PLO8, limit
hold'em, limit Omaha-8 - trimmed to what the fleet can support. It is a
standing rule about game mix, not a time-of-day one, so it is permanent.

## 3. Late night gets no 2-3 handed games

At 5% there are about 38 seats to place on Midway Union overnight. Spread
across eighty open tables that is one player a table: the head count would be
right and the room would look dead. So inside the night window a shaped table
with fewer than four players is **parked** - drained and closed until morning -
and the seats concentrate onto the tables that stay.

Three things are never parked, and each is a way this could have gone wrong:

- **a table with a human seated.** Parking stops the seeder refilling it, which
  is how a person ends up alone at a table nobody else can join.
- **a table a human is waiting for.** They are queuing for that game.
- **the fullest tables the host still needs.** The wind-down thins tables as it
  runs, so without a floor the parking cascades: every table drops under four,
  every table is parked, and the host has nowhere to seat anybody.

That floor is derived rather than fixed, and the derivation matters: 29 bodies
at up to 1.3 seats each is 38 seats, which is **seven** full rings, not six. A
fixed six would have left the seeder unable to place everyone the curve allows,
and the head count would then have sat under target for no reason a player
could see. It rounds up and uses the widest end of the seats-per-horse band,
because one extra open table is a far cheaper mistake than nowhere to seat.

## PARKED IS NOT RETIRED, and confusing them would have deleted the floor

This is the part that took the longest to get right, and it is worth writing
down plainly.

`retire_when_empty` is **permanent by design**. `ensureAllTablesExist` reopens
a closed table _unless_ it carries that flag, specifically so a deliberate
retirement is not undone on the next boot. Reaching for the same flag to park
tables overnight would have meant: one quiet night, eighty tables closed, and
none of them ever reopened. For Deep Stack Society - whose 167 tables the fleet
does not create at all - nothing on the platform would ever have brought them
back.

So the night has its own flag, `settings.night_parked`, with its own lifetime.
It drains and closes identically, and it is lifted two independent ways:

1. **The executor** clears the flag and reopens the table on every cycle
   outside the night window - not once at 08:00, because a park lifted only by
   a single scheduled moment is a park that survives an engine restart at
   07:59.
2. **The fleet, at boot**, reopens a closed parked table whenever it is not
   currently night. This is the net that catches the case where the executor is
   switched off entirely. Inside the night window it leaves them alone, or the
   hourly engine restart would undo the parking every hour.

A test asserts the executor never writes the retirement flag from the night
list, or the reverse.

## What the live floor says this will do

Read at 04:19 Chicago, before any of it has deployed:

| Host               | tables now | close (permanent) | park (tonight) | left open |
| ------------------ | ---------- | ----------------- | -------------- | --------- |
| Midway Union       | 80         | 24                | 14             | 42        |
| Deep Stack Society | 167        | 65                | 65             | 37        |

That is the FIRST pass only. Most tables still hold four or more players, so
they are not parked yet; as the wind-down empties the thinnest ones they drop
under four, get parked, drain and close. It converges on roughly seven tables
per host holding the night's 29 and 20 bodies at five or six players each,
which is what "fewer tables, more players at each" asks for. In the morning the
parks lift and the floor comes back.

## Verified

Server typecheck clean, 5,123 tests across 357 files. Client typecheck clean,
12,568 tests. The plan was read against the live floor through the planner
directly; nothing was written to production by this work.

One existing pin moved rather than weakened: `CashTableClosureIsRespected`
pinned the exact reopen condition in `ensureAllTablesExist`, which now carries
the night-park exemption. The pin was updated in the same commit and also
asserts the park reads the clock rather than only a flag.
