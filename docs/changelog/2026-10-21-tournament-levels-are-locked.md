# Tournament Levels Are Locked, Never A Range (2026-10-21)

Dan: "TOURNAMENT LEVELS CAN NEVER EVER BE A 'RANGE'. ... TURBOS AND FREE ROLLS 5
MINUTE LEVELS, STANDARD TOURNAMENTS AND BOUNTY TOURNAMENTS 8 MINUTE LEVELS, DEEP
STACK TOURNAMENTS 10 MINUTE LEVELS." Spins and Sit & Gos are excluded.

## Cause

The MTT presets are tapered ladders (blindLadder.ts): STANDARD 10 down to 5,
TURBO 4 down to 2, DEEPSTACK 12 down to 6, the Diamond Free Buy 6 down to 5.
181 of 254 registering MTTs and all 27 registering satellites carried a mixed
clock, printed in the lobby as "10 Min Opening - 5-10 Min Range". Midway used
fixed clocks but at 12 minutes for Free Buys and deep stacks.

## Fix

- `server/src/tournament/lockedLevelClock.ts`: the one rule (freeroll/turbo 5,
  standard/bounty 8, deep stack 10) and `withLockedLevelClock`, applied at the
  scheduled and recurring MTT insert paths. Midway's structure policy uses it.
- Free Buys keep Dan's one hour of late registration: twelve 5-minute levels.
- `supabase/migrations/20261021222049_lock_tournament_level_clocks.sql`:
  `fn_ca_locked_level_minutes` (the same rule) and the BEFORE INSERT trigger
  `tournaments_lock_level_clock`, so no creator can publish a range. Every
  not-yet-started MTT and satellite and every schedule config with an explicit
  ladder was rewritten through it.
- Law: `server/src/tournament/TournamentLevelsAreLocked.law.test.ts`.
