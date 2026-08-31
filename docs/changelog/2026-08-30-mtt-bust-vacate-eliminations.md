# 2026-08-30 — Vacated busts were invisible to the elimination sweep; MTTs hung heads-up-won

## Symptom (live, production)

10 of 16 RUNNING MTTs stranded: exactly one seated survivor, blinds escalating
past level 100+, no hands dealt for hours, champion never crowned, first prize
never paid. Example: Afternoon Bounty (NLH) b51f3708 — 4 players
`status='playing'`, only 1 with an open seat, the other 3 holding stale
positive `chips` (4380/4420/9599) and no seat row anywhere in the event.

## Root cause

The same-day "bust vacates the seat immediately" change (Dan 2026-08-30)
removes the 0-stack seat row at hand settle. The elimination sweep detects
busts only via `tournament_players.chips <= 0`, and its chip sync reads OPEN
seats only. The vacate raced the sync: chips froze at the last pre-bust
positive value, the player never entered the bust list, `remainingCount`
never reached 1, `finishTournament` unreachable. Seat-row reuse by
`ensureLateRegSeated` also destroyed the exit evidence.

## Fix

1. `ServerTableEngineDealing.ts`: the vacate now zeroes
   `tournament_players.chips` in the same branch (guarded `status='playing'`;
   a later rebuy overwrites the 0 exactly as before).
2. `TournamentManagerEliminations.ts`: seatless-phantom backstop — a
   'playing' player with chips > 0 and no open seat for 24 consecutive sweeps
   (~2 min) is zeroed through the ordinary `fn_sync_tournament_chips` path,
   so the standard elimination/rebuy-window/payout path finishes the event.
3. Pin: `BustedVacateVisibleToSweep.guard.test.ts`.

## Production repair

Stranded events repaired by zeroing the phantom players' stale chips via SQL
(data-only; the deployed engine's own elimination + payout path then finished
each event and paid the champion). See audit in this session's report.
