# The lease heartbeat has its own login (2026-10-02)

## What happened

About fifteen times in 24 hours (2026-10-01 22:49Z to 2026-10-02 22:27Z) the engine lost every
table and tournament lease at once, killed and rebuilt ~340 tables, and voided the hands in
flight (~160 critical `financial_alerts` per storm), while logging "Lost the deal-lease ... to
another engine instance" with only one instance alive.

22:27Z, from edge logs: heartbeats every 5 s answered in ~0.4 s until 22:27:07. The 22:27:12 and
22:27:17 requests never came back and the 22:27:22 one took 13.4 s, because PostgREST's pool
(~71 connections, ~36 busy even when calm, slow readers such as
`fn_horse_committed_observation_snapshot`) answered PGRST003. The 20 s local proof from 22:27:07
ran out at 22:27:27 and every manager and table fenced itself. The lease rows still named this
instance.

## Root cause

#5166 (2026-09-24) already moved heartbeats onto a dedicated Postgres session per scope that game
traffic cannot fill, but only when `ENGINE_PG_LISTEN_URL` is set on the engine host. It never was
(the host holds no database password): `docker inspect` shows no such variable and
`pg_stat_activity` showed no engine session of any kind. Every heartbeat still queued for a
PostgREST pool slot.

## Fix

- Migration `20261002223745_the_lease_heartbeat_has_its_own_login`: login role
  `engine_lease_heartbeat` (NOINHERIT, CONNECTION LIMIT 8, EXECUTE on
  `heartbeat_table_leases_v4` and `heartbeat_tournament_leases_v4` only), a random password
  generated in the database and kept in Vault as the Supavisor session-mode URL
  (`engine_lease_heartbeat_url`), and `fn_engine_lease_session_url()` for `service_role` only.
  Re-applying never rotates an existing secret.
- `leaseHeartbeatSession.ts`: with no host variable, the engine reads that URL at boot through the
  service-role client it already holds (bounded 5 s, retried every 30 s on a transport failure,
  never logged). A session built before the credential arrived is replaced once it does.
- `enginePgSession.ts`: verified TLS now trusts the Supabase Root 2021 CA beside the system roots.
  Supavisor's chain ends there; without it every connect failed verification (measured with
  `openssl s_client -starttls postgres`: error 19 without, 0 with).
- `GameServer.ts`: a cash lease loss says whether the database refuted it or the proof ran out
  unanswered (`verdict: refuted | unproven`), as tournaments already did. Both still fence.

Nothing about proofs, windows, generations or fencing changed. A real conflict the database
answers still fences at once; only the socket the heartbeat travels on changed.

The hand-projection LISTEN session reads only the host variable and stays off.

## Tests

`server/src/services/theLeaseHeartbeatHasItsOwnLogin.test.ts`: under a stalled shared pool,
table and tournament proofs outlive 30 s on the Vault credential; a `taken` answer on that session
fences every claim; without the credential the storm reproduces (nothing renewed, nothing
accused); a failed read is retried and upgrades the session; a host variable wins; the password
never reaches a log; the Supabase root is in the TLS trust list.
