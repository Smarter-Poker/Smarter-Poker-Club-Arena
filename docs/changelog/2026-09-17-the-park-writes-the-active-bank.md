# The park writes the active bank too

Date: 2026-09-17. Engine change, phase 1 of the horse programme.

## What was wrong

At the 17:55 UTC break, 30 tables that had parked between hands at 17:53
were counted as unparked for the whole break, `readyForRestart` never
opened, and the three engine releases staged for that window (including the
turn-clock decision deadline) waited for the next hour. Nothing was in the
air on those tables. The restart gate reads
`isMaintenanceStateDurable()`, which requires the park write to have landed
whenever a seated player holds a time bank, and `captureParkedTimeBanks`
skipped every bank still counting down. A slow main loop leaves a horse's
auto-activated bank active past the end of the last hand, so a table whose
every bank was active had nothing to write, `persistPresenceForRestart`
returned before writing, the durable flag never rose, and the gate stayed
shut until the table's 480 s pause safety timeout kicked it, after which
the zombie reaper rebuilt it.

## What changed

- `captureParkedTimeBanks` captures an active bank too, charged its whole
  current activation (`remainingSeconds - currentUseSeconds`), the same
  deduction the engine makes at stop.
- A park with no presence state and no restorable bank marks itself durable
  at once: nothing to write is nothing to lose.
- A refused park write is retried once, five seconds on, while the break
  still holds; a second refusal leaves the gate shut as before.

## Law

`server/src/engine/theParkWritesTheActiveBank.law.test.ts`, registered in
`docs/laws.d/`.

## What was not changed

The gate itself: a table with cards in the air, or with a restorable bank
whose write was refused twice, still holds the restart.
