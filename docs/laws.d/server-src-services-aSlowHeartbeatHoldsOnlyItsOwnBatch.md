# server/src/services/aSlowHeartbeatHoldsOnlyItsOwnBatch.law.test.ts

A lease heartbeat request carries at most 50 claims, and a batch queued on the dedicated session waits at most a second behind a statement that has not answered before asking on the shared client, so one renewal statement that stalls (2026-10-03 09:34:33, one 8 s statement carrying all ~300 tournament claims held every lease row, the hedge could only answer busy, and every manager's proof expired at 09:34:42) can leave unrenewed only its own batch; its claims stay UNKNOWN and nobody is accused.
