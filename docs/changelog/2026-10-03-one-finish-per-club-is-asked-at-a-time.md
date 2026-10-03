# One finish per club is asked at a time (2026-10-03)

**Measured.** `fn_complete_tournament_terminal` holds the club's bank-scope
finish lock (`fn_ca_lock_settlement_lane_for_finish`, F(scope) exclusive) for
the whole settlement, 2-12 s of CPU inside Postgres. Once decided games stopped
queueing in the elimination scheduler (#5958), more of them reached that lock
at once: other finishes of the same club waited in the lock queue holding a
PostgREST connection and were cancelled by the 8 s `lock_timeout` (55P03),
28-66 every fifteen minutes from 13:00 UTC against 0-4 before, each retried
with backoff behind newer arrivals.

**Fix.** The engine is the only caller. A finish attempt for a club is sent
only after that club's previous attempt has answered, in arrival order
(`withTerminalFinishLane`); the club is the one the tournament's manager noted
when it loaded the row. Other clubs and un-noted tournaments are sent at once,
as before. The database stays the authority and still serializes; nothing in
the settlement, its retries or its resolver changed.

**Regression.** `server/src/tournament/oneFinishPerClubIsAskedAtATime.law.test.ts`.
