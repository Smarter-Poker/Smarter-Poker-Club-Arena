# The Mixed Recovery Reads The Fleet At The Process Root

`20260927145449` was applied at 21:24 UTC (run 36351518715) and voided the dead
origin hands of 70 of the 71 stranded mixed-custody events, credit 0. Engine
`e6b9dc5d` then admitted each successor, but every recovery was retained on
`GameServer.mixed_original_recovery_retained` with "Tournament data authority
cannot be rebound inside another manager context", and none resumed.

The mixed admission's `current()` scanned every table engine's lease authority
inline, and `reservation.assertCurrent` re-checks it from inside
`manager.recoverMixedF06Custody`, inside that manager's bound authority. The
first engine of any other tournament threw. This is the class
`tournamentEnginesOnFleet` closed for the physical-map check on 2026-09-26; the
admission closure now uses the same process-root read
(`noTournamentEngineOnFleet`). The predicate is unchanged.

Test: `server/src/theMixedRecoveryReadsTheFleetAtTheProcessRoot.test.ts`
reproduces the throw with the inline scan and proves the root read answers
exactly from inside a manager while another tournament shares the fleet.
No money moves.
