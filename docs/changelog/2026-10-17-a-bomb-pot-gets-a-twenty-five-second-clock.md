# 2026-10-17: a bomb pot gets a 25 second clock

Dan: "DURING BOMB POTS ONLY, EXTEND THE USERS DECISION CLOCK TO 25 SECONDS
INSTEAD OF 15 SECONDS. (MAKE SURE YOU CHANGE AND SLOW DOWN THE COUNTDOWN CLOCK
DISAPPEARING LINE AROUND THE PLAYERS NAME TO TAKE 25 SECONDS TO DISAPPEAR
INSTEAD OF 15 DURING ANY AND ALL BOMB POTS."

## What changed

- `ServerTableEngineBase.actionClockSeconds()` is the one place a turn's length
  comes from. On a bomb hand it answers `max(table clock, 25)`; on every other
  hand, the table clock (15 unless configured). A bomb hand is recognised from
  the hand's own config (`HandController.isBombPotHand()`) or the frozen bomb
  facts, so a reconnect or a rebuild that re-arms the clock mid-hand still gets
  25 seconds.
- Every site that armed a turn from `tableInfo.action_time_seconds` now asks
  that method: the TURN_CHANGE handler (which stamps the published deadline),
  `handleTurnChange`, the watchdog and recovery re-arms, the reconnect paths,
  the Pineapple discard round, and the horse decision budget. Horses are players
  (CLAUDE.md 10.5) and get the same clock.
- The ring around a player's name is drawn from the published deadline minus
  start, so a 25 second turn drains over 25 seconds with no client constant to
  move. The one client fallback that derived a start from the table's 15 second
  clock (`ACTION_TIMER_STARTED` without a start stamp) now prefers the engine's
  own `durationMs`.
- Time banks still add 20 seconds on top; reconnect grace still adds 5.

Pinned by `server/src/engine/ABombPotGetsATwentyFiveSecondClock.test.ts`.
