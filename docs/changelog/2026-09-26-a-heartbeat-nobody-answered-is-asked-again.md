# A heartbeat nobody answered is asked again (2026-09-26)

## What happened at 04:45:26 UTC

All 338 tournament managers lost lease authority in the same instant
(`GameServer.tournament_lease_lost_stop_failed` on every one). Their stops were
then refused (`mixed:originals_not_drained:engine_stops_not_all_fulfilled`), they
sat in quarantine, tournament dealing fell from about 280 events a minute to about
12 for roughly 80 minutes, and the 04:55 break read
`stopped_bank_custody_unwritten: 608`. Every lease row in the database still named
this instance and generation.

Measured, not inferred:

- **The heartbeats rode the shared PostgREST client.** Live `/metrics` on engine
  `94c7cf0b` (and again on `209d1b45`):
  `poker_lease_heartbeat_session_enabled{scope="tournament"} 0`, `{scope="table"} 0`,
  `poker_lease_heartbeat_statements_total{transport="dedicated"} 0` for both scopes,
  all traffic on `transport="shared"`. `ENGINE_PG_LISTEN_URL` is not set on the
  engine host, so the 2026-09-24 fix (`lease-renewal-cannot-queue-behind-game-traffic`)
  has been inert since it shipped; its own changelog said it would be until the
  variable was placed. `poker_hand_outbox_listener_enabled 0` confirms the same
  variable is absent.
- **PostgREST's pool was full.** `postgrest_logs`: 1,915 responses with HTTP 504
  in the minute 04:45 (71 in 04:46, 41 in 04:43, 113 in 04:40), among them
  `POST /rpc/heartbeat_table_leases_v4` 504 at 04:45:15 and
  `POST /rpc/heartbeat_tournament_leases_v4` 504 at **04:45:26.49** - the instant of
  the fleet-wide loss. 338 claims is one request (500 per request).
- **The engine was not stalled.** `hand_history` kept landing every second from
  04:44:55 to 04:45:41 through the same pool: other requests were getting through.
- **The database fence followed, it did not lead.** `TOURNAMENT_MANAGER_FENCED:
lease generation is no longer current` first appears at 04:45:37, about 30 s after
  the last heartbeat that reached Postgres - the stale boundary of
  `fn_*` actor checks, reached because the fenced managers stopped heartbeating.

## The mechanism, by line

1. `server/src/services/leaseHeartbeatBatches.ts` (before this change,
   `dispatch`): `available = claims.filter((claim) => !this.retained.has(key(claim)))`.
   While one request for a claim was outstanding, every later renewal pass sent
   nothing for it. For 20 s the fleet asked the database exactly once.
2. `server/src/services/tournamentLease.ts` `heartbeatTournamentBatch`: the proof
   deadline is read immediately before the request (`+ 20_000`). A request that
   waits out its window renews nothing.
3. `server/src/tournament/TournamentManagerBase.ts` `armTournamentLeaseExpiryTimer`
   / `expireTournamentLeaseAuthority`, and the per-table
   `ServerTableEngineBase.expireEngineLeaseAuthority` -> `killForRestart`: at the
   deadline every manager fences and every table engine is killed mid-hand.
4. `server/src/GameServer.ts` `performOwnedEngineLeaseProofRenewal`: every manager
   whose local proof lapsed was reported as "no longer proves its current lease
   generation" - the same words as a database refusal - and retired through
   `stopTournamentManagerIfOwned(..., 'GameServer.tournament_lease_lost_stop_failed')`.

So "I could not tell" (one unanswered request) was turned into "I lost it" for
the whole fleet (CLAUDE.md 10.86).

## What changed

- **A claim nobody answered is asked again.** `RetainedLeaseHeartbeatBatches` now
  lets an ordinary renewal pass re-send a claim whose only requests have been in
  flight for at least one cadence (`HEARTBEAT_HEDGE_AFTER_MS = 5_000`), up to
  `HEARTBEAT_MAX_OUTSTANDING_PER_CLAIM = 3` at once. A claim still waiting in the
  local queue is not duplicated. No timer, retry loop or background job was added:
  a question is only ever sent by the existing 5 s renewal pass. Each question
  carries its own proof deadline taken immediately before it is sent, so a hedge
  can only prove what the database said to it. Answer rules are unchanged: the
  first validated `kept` on the exact generation renews, a later one never
  shortens it, `busy` and UNKNOWN extend nothing, and `taken`, `stale`, `missing`
  or another generation still fence. Both scopes (tournament and cash table) share
  the class, so the 60-table cash burst at 04:45 is covered by the same change.
- **A hedge does not queue behind a stuck dedicated statement.**
  `leaseHeartbeatSession.call` sends a request to the shared client when the
  dedicated session's current statement has been outstanding for a second or
  more (`LEASE_HEARTBEAT_HEDGE_TO_SHARED_AFTER_MS`). Ordinary back-to-back batches
  still take turns on the session (~50 ms each).
- **The report says which it was.** `GameServer.tournament_lease_lost` now carries
  `verdict: 'refuted' | 'unproven'`, and the message distinguishes "the database
  named another holder, a stale row or none" from "no answer arrived, and the
  database did not say it moved". A manager is fenced either way: an unproven
  generation must not deal.

## What did not change

- Fencing. The 20 s proof window, the 30 s stale boundary, the rule that a late
  answer cannot resurrect an expired proof, the fence on any negative answer, and
  the table/tournament kill on expiry are untouched. The release allow-list, exit
  codes 1/70/75, the `O_EXCL` guard and the 285000 ms floor are untouched.
- No cron, sweep, backfill or repair job (10.12).

## What is NOT fixed here, stated plainly

- **The dedicated renewal session is still not configured in production.**
  `ENGINE_PG_LISTEN_URL` (Supavisor session-mode string, port 5432) in
  `/opt/club-arena/server/.env` on the engine host, then the normal restart, is
  what takes renewal off the shared pool entirely. No agent has a sanctioned path
  to write that file, and it holds a database password. This change makes a
  saturated pool survivable as long as any question gets through inside the
  window; it cannot make renewal independent of the pool.
- **A manager whose proof genuinely lapses still dies and can still quarantine.**
  If no question is answered for 20 s, managers fence and table engines are killed
  mid-hand exactly as before. The quarantine that followed at 04:45 is the
  memoized table-engine teardown (`ServerTableEngineBase.stop` returns its first
  rejected `teardownPromise` for ever) together with a stopped-bank capture that
  threw, which leaves `stoppedTimeBankCustody` null and
  `stopped_bank_custody_unwritten` permanent. Resuming an unproven manager in place
  would need every one of the ~130 `lifecycleCanMutate` sites in the engine and
  ~110 `lifecycleIsCurrent` sites in the manager to wait rather than abort; that
  is not safe to do in one change and is not attempted here.

## Tests

- `server/src/services/aHeartbeatNobodyAnsweredIsAskedAgain.law.test.ts` (new law,
  `docs/laws.d/a-heartbeat-nobody-answered-is-asked-again.md`), both scopes, real
  `heartbeatTournaments` / `heartbeatTables` and the real coordinator driven the
  way GameServer drives them, a 338-lease fleet:
  1. the pass's one request waits 20.5 s and returns the 504; later questions are
     answered `kept`: **no lease lapses, every one renewed**;
  2. same, but the database answers `taken` on another generation for one
     tournament: **exactly that one is fenced**;
  3. every question hangs: **every lease lapses on its own deadline** and no claim
     holds more than three questions.
     Planted regression (the old "one outstanding request blocks every later
     question" rule restored in `mayAsk`): cases 1 and 2 go red for both scopes, all
     338 leases fenced.
- `leaseRenewalCannotQueueBehindGameTraffic.test.ts`: a hedge reaches the shared
  client while the dedicated statement has not answered.
- Moved pins, same commit: `GameServerBoundedLeaseRenewal.test.ts` ("the retained
  exact claim cannot be dispatched twice" becomes "at most three questions at
  once; the unanswered claim was asked again"), `leaseHeartbeatFleet.test.ts`
  (the queued pass is no longer the only question; every one of 2,501 claims is
  answered once the stuck transports settle), `aFinishedTournamentIsNotALostLease.test.ts`
  (accepts both report wordings).
