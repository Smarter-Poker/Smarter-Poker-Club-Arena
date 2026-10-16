# A Level Is Not Spent While Part Of The Field Has No Dealer (2026-10-16)

## What Happened

85313174 "Coffee Break Freeroll (PLO4)" parked three tables (15 players) at
17:03 UTC and every re-admission was refused until 20261016183932 was
installed at 21:36. One heads-up table, 077044ee, kept dealing until 18:01.
When the parked players were finally admitted the event was at level 42
(71,850/143,700, ante 17,244) and the last 16 were all-in out inside two
minutes.

## Cause

`advanceBlindLevel` holds a level that comes due with no hand dealt since it
began (2026-09-23). Its witness is "any table of this tournament dealt", so one
live table spent every hyper-turbo level for the whole field while most of it
could not act.

## Fix

`advanceBlindLevel` also holds a due level while any table on the manager's
admission-failure record (seated players, no dealer; stamped by
`scheduleManagedTableEngineRecovery`, cleared by admission, replacement or
removal) has been failing for `FIELD_WITHOUT_DEALER_HOLD_MS` (30 s). The level
is owed exactly as across a break and goes up once every table deals again.
The grace keeps a refusal that heals on its next retry from holding an ordinary
level. Announced once per level.

## Proof

`server/src/tournament/aLevelIsNotSpentWhilePartOfTheFieldHasNoDealer.law.test.ts`
drives the real `advanceBlindLevel`: it fails on the previous engine (the level
is published while a table has had no dealer for 90 s) and passes with the
fix; the full `src/tournament` suite (3,598 tests) passes.
