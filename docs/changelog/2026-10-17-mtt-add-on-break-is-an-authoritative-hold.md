# A tournament add-on break is an authoritative hold in the live-table certificate

## What failed

Post-deploy run 39022068317 (the opt-in natural two-/three-run mobile proof)
never reached its natural observation. The required MTT continuity case failed
first: after the forced reconnect on MTT table `a42f5d39`, the browser saw
`pot_distributed` for hand 37157948, a `level_up` three seconds later, and then
no gameplay event for 45078ms, so `waitForCausalHandCycle` reported a frozen
table.

The table was not frozen. The level change reached the rebuy cap, the engine
opened the tournament's add-on window and held every table for its persisted
one-minute add-on break (`TournamentManagerBase.beginAddOnBreak`,
`holdDealingUntil(addon_period_ends_at)`). Gameplay resumed with
`hand_started` 70 seconds after the last hand, right after the break ended. The
break announcement travels on the tournament's Realtime channel, not the
engine table socket, so the socket journal saw only silence.

Selection already refuses a board whose add-on window is open
(`addon_period_open` in `tournamentHudWitness.ts`). This board's window opened
while it was being watched.

## The change

- `classifyAddOnBreakHold` (`tests/e2e/support/tournamentBoardEnding.ts`)
  derives the break interval exactly as the engine does
  (`addon_period_ends_at` minus `addon_break_minutes`, clamped 1..10) and
  calls a silence a hold only when the silence overlaps that interval AND the
  silence before the break began and after it ended each still fit the
  ordinary 45-second gameplay limit. A table that stalls into a break, or
  fails to resume after one, is still a failure.
- The board reader gains a read-only `addOnBreakWindow(tournamentId)`.
- On a gameplay-silence failure the database still shows running, the case
  reads that window. A proven hold routes to the existing bounded reselection
  (`AuthoritativeHoldDuringObservation`, same case deadline and replacement cap
  as a natural ending) and is attached as `<format>-add-on-break-holds`.
  Nothing passes the case: the replacement board must satisfy every
  transport, ownership, reconnect and causal hand-cycle assertion.

No deadline, silence limit or assertion changed. No engine or client runtime
change; this is verification code only.

Pinned by `tests/unit/addOnBreakHold.test.ts`, which replays the production
failure's timing and the stall-before / no-resume-after negatives.
