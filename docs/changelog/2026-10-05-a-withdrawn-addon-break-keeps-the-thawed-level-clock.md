# 2026-10-05 - A withdrawn add-on break keeps the thawed level clock

Follow-up to PR #6085 (an add-on break begun inside the freeze has not begun).

## Defect

`withdrawAddOnBreakBegunBeforeItsStart` (server/src/tournament/TournamentManagerBase.ts)
restarted the level clock with `startBlindTimer(savedBlindTimerRemaining)`.

1. **Burned freeze time.** The remainder was measured by `suspendLevelClock`
   when the withdrawn break began, inside the maintenance freeze, against the
   pre-freeze anchor. Every minute from the freeze start to the break start
   was charged to the level.
2. **Unfenced overwrite.** `startBlindTimer` persisted that burned anchor with
   a detached `update ... eq('id')`. GameServer's thaw hook runs
   `resyncLevelClockAfterMaintenanceThaw` straight after the add-on re-read.
   When its read beat the detached write, memory followed the correctly thawed
   anchor and the row was then overwritten with the burned one, so the next
   restart resumed the level up to the whole freeze short.

## Fix

- The withdrawal no longer goes through `startBlindTimer`. The add-on break
  never moved the durable anchor (suspension is memory only) and
  `fn_thaw_platform` already shifted it by the frozen duration, so the row is
  the correct clock. `rearmLevelClockFromThawedAnchor` arms a provisional local
  wake, writes nothing, and raises `blindClockNeedsThawResync`: the thaw
  re-read re-arms from the durable anchor at once, and if that read does not
  land the wake rereads the anchor itself before it may publish a level.
- `startBlindTimer`'s persist is now fenced like the break release and the
  publication RPC: `.eq('status','RUNNING').eq('current_level', armedLevel)`,
  so a stale arm can never land on a level the row has moved past.

## Tests

- New `server/src/tournament/AWithdrawnAddOnBreakKeepsTheThawedLevelClock.test.ts`
  drives the real manager (real suspend, startBlindTimer and thaw resync)
  against one durable row: no anchor written in either read/write order, the
  level runs to the thawed deadline, the unresynced wake is flagged to reread,
  and the persist fence refuses a moved level. All four fail on the previous
  code.
- `AnAddOnBreakBegunInsideTheFreezeHasNotBegun.test.ts` updated: the
  withdrawal re-arms a flagged local wake instead of calling startBlindTimer.
- Three supabase mocks (`LevelClockMaintenanceThaw`, `BlindLevelTransitionRecovery`,
  `aBlindPastTheStructureNeedsAProvenStack`) now model the chained, fenced
  PostgREST update.
