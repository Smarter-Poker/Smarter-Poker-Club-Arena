# server/src/engine/LeaveVacatesInRealTime.law.test.ts

Leaving is real time (Dan 2026-09-05): every sit-out write carries `is_sitting_out` and not `status` alone, so the sit-out trigger, the restart restore and the client seat poll can all see a departing seat; both the deferred mid-hand leave and the tournament sit-out re-broadcast state so a second device is never left holding a stale snapshot; and the busted-seat vacate is REACHABLE at every tournament format rather than nested inside the `is_rebuy || is_reentry` gate, where Spins, Heads-Up and freezeout MTTs never reached it.
