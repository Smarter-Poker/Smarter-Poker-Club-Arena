# A Gateway Blip On The Departure Read Is Asked Again (2026-10-15)

## What Fired

`postHandTasks.leave_pending_failed` (warning, `moves_chips: false`) at
2026-10-14 14:27 and 2026-10-15 05:48 UTC, one cash table each.

## Root Cause

The `leave_pending_diagnostic_v1` evidence on both rows names the same line:
the departures enumeration in `processLeavePending`
(`server/src/services/supabase/seats.ts`, phase `table_seats_query`) received a
Cloudflare `502: Bad gateway` HTML page from the Supabase API. postgrest-js
returned it as an error with no SQLSTATE (`code: null`). The post-hand step
retry asks `isTransientDbError`, which does not recognise a gateway page, so
it recorded `retry_decision: non_transient` on the first attempt and gave up
with two retries of budget unused. No chips moved; every pending departure
stayed `leave_pending` until the next hand boundary.

## Fix

The enumeration is a plain GET, which PostgREST runs read-only, so asking it
again can never replay a write. `processLeavePending` now asks it again
(250 ms, then 1 s, inside the same boundary) when the returned error carries no
database code or one of PostgREST's pre-execution 503 codes
(`isGatewayReadFailure`). An error the database itself raised (a SQLSTATE or a
PostgREST answer code) is still final on the first answer. Writes are not
touched: CLAUDE.md section 2 rule 6 still holds for every write path.

## Pinned

`server/src/services/supabase/aGatewayBlipOnTheDepartureReadIsAskedAgain.test.ts`:
a 502 page then the rows completes the departure in the same boundary; a
PGRST002 is asked again; a gateway that stays down is reported after three
reads with nothing written; a 42501 is final on the first read.
