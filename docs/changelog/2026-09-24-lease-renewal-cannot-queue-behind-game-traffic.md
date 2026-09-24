# 2026-09-24 - lease renewal cannot queue behind game traffic

Branch `fix/lease-renewal-cannot-queue-behind-game-traffic`. Engine only. No migration, no
GRANT, no new credential.

## The defect (proven 2026-09-22 from engine logs and Postgres/PostgREST logs)

Every table and tournament lease heartbeat (`heartbeat_table_leases_v4`,
`heartbeat_tournament_leases_v4`) went through the SHARED PostgREST client in
`server/src/services/supabase/client.ts`, the same client every hand, seat and settlement
uses. Between 13:52:55 and 13:53:30 UTC PostgREST answered 437 requests with 504 PGRST003
"Timed out acquiring connection from connection pool": game traffic held every pool
connection. The heartbeat SQL is fast (`heartbeat_tournament_leases_v4` mean 46.6 ms over
264,503 calls), but it never reached Postgres. No heartbeat was answered inside the 20 s local
proof window, so every manager's proof expired at once: 1,616 `lease_proof_expired` and 572
`tournament_lease_lost` in one minute. Each burst kills manager generations mid-hand and leaves
reserved hands that block their tables (the MTT stall). 103 more followed in one hour.

A longer proof window is not a fix: the audited 30 s takeover boundary caps it.

## The fix

`server/src/services/leaseHeartbeatSession.ts` renews leases on a persistent Postgres session
of its own, one per scope (tournament, table). Game traffic never uses these sessions, so it
cannot fill them.

- Configuration is the engine's existing raw-session configuration, now in
  `server/src/services/supabase/enginePgSession.ts` and shared with the LISTEN session in
  `handOutboxListener.ts`: `ENGINE_PG_LISTEN_URL` (Supavisor session-mode string) and the
  optional `ENGINE_PG_LISTEN_CA_FILE`, verified TLS. No new variable, no new secret.
- One statement at a time per scope. On connect the session runs
  `SET statement_timeout = 8000` and checks `has_function_privilege(..., 'EXECUTE')` on its
  heartbeat function. A local bound of 10 s drops a session whose socket goes silent.
- A lost session reconnects in the background with the listener's jittered backoff (500 ms
  base, 30 s cap). The heartbeat loop never waits for a reconnect: while the session is down,
  each request uses the shared client exactly as before.
- No `ENGINE_PG_LISTEN_URL`, or a login role without EXECUTE on the heartbeat function, means
  the shared client, unchanged. A role without EXECUTE disables the session for the life of
  the process (logged once) instead of reconnecting in a loop.
- A request that fails on the dedicated session is UNKNOWN and is not replayed on the shared
  client: the statement may have run, and the next pass asks again.

`tableLease.ts` and `tournamentLease.ts` change one call each: `supabase.rpc(<heartbeat>, args)`
becomes `leaseHeartbeatRpc(<scope>, args)`, same arguments, same `{ data, error }` answer.
Every proof rule is untouched: the proof deadline is read immediately before the call (so any
wait in the session queue only shortens it), the window is 20 s, `busy` and every error or
UNKNOWN outcome extend nothing, and authority is extended only by a validated `kept` row on
the exact generation.

`GameServer` closes both sessions on shutdown after the leases are released, and `/metrics`
gains `poker_lease_heartbeat_session_enabled{scope}`,
`poker_lease_heartbeat_session_connected{scope}`,
`poker_lease_heartbeat_statements_total{scope,transport="dedicated"|"shared"}` and
`poker_lease_heartbeat_session_disconnects_total{scope}`.

## Why the heartbeat may skip the Data API actor headers

Through PostgREST a request carries the actor headers stamped in `client.ts` and passes the
`smarter_private.fn_smarter_data_api_pre_request` hook. On a raw session neither happens.
That is safe here only because of what the two functions are (read from the production
definitions and the migrations):

- Both are `SECURITY DEFINER`, owned by `postgres`, `search_path` pinned, and read no request
  setting (`request.headers`, `request.jwt.claims`, `app.smarter_data_actor`) and no
  `auth.role()`. Their authority is their arguments: the instance id and the exact lease
  generation.
- They update only `heartbeat_at`. The lease triggers are `f06_aborted_generation` (checks the
  aborted-generation tombstones, which the heartbeat's own WHERE already excludes) and
  `a00_f06_retired_origin_claim` (fires only on `tournament_id`, `lease_generation`,
  `instance_id`, `engine_version`, `acquired_at`, `protocol_version`). Neither reads a request
  setting.

`TournamentManagerRequestFence.guard.test.ts` now pins the exception on purpose: raw `pg`
sessions may exist only in `leaseHeartbeatSession.ts` and `handOutboxListener.ts`, the lease
session may run only `SELECT` and `SET`, and the only functions it calls are the two heartbeat
functions.

## Grants and production configuration

- EXECUTE: both functions have ACL `{postgres=X/postgres,service_role=X/postgres}`. The
  documented value of `ENGINE_PG_LISTEN_URL` logs in as `postgres.<project-ref>` through the
  session pooler, i.e. the owner, which has EXECUTE. No GRANT is needed and no migration is in
  this change. If a least-privilege role (such as the optional `engine_outbox_listener` in the
  2026-09-10 changelog) is ever used for the variable, it would need
  `GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer),
public.heartbeat_table_leases_v4(text,jsonb,integer) TO <role>`; until then the privilege
  check at connect falls back to the shared client.
- The fix is inert until `ENGINE_PG_LISTEN_URL` is set on the engine host. The 2026-09-10
  changelog records it as deliberately unset because the engine host holds no database
  password. Whether it is set today was not checked (no `.env` was read). Setting it is Dan's
  call, by name only: `ENGINE_PG_LISTEN_URL` in `/opt/club-arena/server/.env`, the Supavisor
  session-mode string (port 5432), then the normal engine restart. Setting it also enables the
  LISTEN wake for hand projection, which was built to be enabled by this same variable.
- Connections: two more session-mode connections per engine process (one per scope).

## Tests

`server/src/services/leaseRenewalCannotQueueBehindGameTraffic.test.ts`:

- Every shared Data API request hangs (the 2026-09-22 pool). Tournament and table heartbeats
  run every 5 s for 30 s. On `origin/main` no proof is ever renewed and every manager's
  authority ends at 20 s (`expected 0 to be greater than 30000`). With the fix every proof is
  renewed on the dedicated session and outlives the window.
- `busy` on the exact generation extends nothing and accuses nobody.
- A statement timeout (57014) is UNKNOWN, extends nothing, is not replayed on the shared
  client, and keeps the session.
- A silent session is dropped after the local bound, the next pass is served immediately by
  the shared client, and the backoff reconnects in the background.
- A session that cannot connect falls back without waiting for the retry.
- A login role without EXECUTE disables the session and uses the shared client.
- With no session configured the request through the shared client is byte for byte the same
  and no session is opened.

## Not verified

- No live session was opened against production; the dedicated path is proven with a mocked
  `pg` client only.
- Whether `ENGINE_PG_LISTEN_URL` is set on the engine host today.
- Supavisor session-mode pool headroom for two more connections was not measured.
