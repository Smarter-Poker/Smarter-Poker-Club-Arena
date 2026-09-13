# A busy manager keeps its lease

**Date:** 2026-09-10
**Migration:** `20260910063559_a_busy_manager_keeps_its_lease` (applied 06:36:07 UTC)
**Law:** `tests/a-busy-manager-keeps-its-lease.law.test.ts`
**Relates to:** issue #4094, the stalled-tournament class

## What was wrong

Between 05:59 and 06:29 UTC the engine logged 649
`Lost the tournament lease ... to another engine instance` across 235 events.
There was one engine instance (`1-781c16fb`), and `engine_tournament_leases`
showed every one of its 127 leases heartbeated within 4-5 seconds. Nobody took
anything. The busiest event, `f922df63` (21 tables), was fenced, torn down and
re-adopted at 06:10, 06:19 and 06:24; between those, no table of it was broken
or balanced, and at 06:27 twenty-nine RUNNING events sat at one player per
table with hands stopped.

Two locks on the same row could not both be right:

- `smarter_private.fn_smarter_data_api_pre_request` (the PostgREST hook that
  validates a tournament-manager request) took `SELECT ... FOR SHARE` on the
  event's lease row for every non-GET request, for the life of that
  transaction: every hand commit, elimination and seat move.
- `heartbeat_tournament_leases_v4` renews with
  `FOR NO KEY UPDATE OF l SKIP LOCKED`. FOR SHARE conflicts with
  FOR NO KEY UPDATE, so a row a manager request was holding was skipped and
  answered `busy`. The engine, correctly, treats `busy` as "extends nothing"
  (`server/src/services/tournamentLease.ts`). Four busy passes - the 20-second
  proof window at a 5-second cadence - and the manager's own expiry timer
  fenced and stopped it. A 21-table event writes almost continuously, so it
  was busy almost every pass.

## What changed

The hook takes `FOR KEY SHARE`, which conflicts with `FOR UPDATE` only, so the
heartbeat's renewal proceeds while a manager request is in flight. The fencing
guarantee the hook exists for - a takeover waits until every in-flight manager
transaction has committed - is kept by making `claim_tournament_lease_v2` lock
the row `FOR UPDATE` before its upsert. (On its own the upsert only ever took
FOR NO KEY UPDATE, which FOR KEY SHARE does not block; it used to wait on
FOR SHARE holders only by the accident of the same conflict that broke the
heartbeat. Now it waits by design.) The heartbeat and the engine's `busy` rule
are untouched and pinned.

## Measured

Lease losses per minute, engine log, same instance: 14, 14, 4, 5, 10, 11, 9,
4, 8, 12, 14, 8, 8 (06:23-06:35) -> applied 06:36:07 -> see the follow-up
reading in the pull request.
