# A lease renewal does not wait for the disk (2026-10-03)

## What happened

At 00:53:39-41Z on 2026-10-03 the engine fenced every table and tournament at once (182
`cash_lease_proof_expired`, 144 `tournament_lease_proof_expired`, 39 `tournament_lease_lost`
watchdog rebuilds in `engine_recovery_events`). The same burst had happened at 19:37, 20:53 and
22:27 on 2026-10-02. This one came after #5874 shipped (deploy 23:57Z): the dedicated heartbeat
session was connected and answering (1,885 table statements, mean 27.5 ms, max 404 ms).

From the database:

- The checkpoint that started at 00:44 was in its I/O-saturated tail (`sync=104.7 s`, longest single
  fsync 10.7 s), and `sp_prune_hand_history` ran 00:53:01-00:54:07. `hand_atomic_commits` holds no
  row from 00:53:22 to 00:53:36. Every COMMIT was waiting for its WAL flush.
- The heartbeat UPDATE itself finished in milliseconds: no heartbeat statement was cancelled, and
  `pg_stat_statements` shows none slower than 1.6 s. Its COMMIT waited on the same flush.
  `statement_timeout` is disarmed before COMMIT, so nothing cut it short. The session was silent
  for its full 10 s local bound and was dropped (`disconnects_total` 1 per scope; the new backends
  started 00:53:33/34).
- That waiting COMMIT still held the row lock of every lease it renewed. The heartbeat function
  skips locked rows, so the hedge sent on the shared client could only answer `busy` (edge log:
  `heartbeat_table_leases_v4` at 00:53:28.58 in 758 ms), and `busy` renews nothing. 20 s after the
  last renewal, every proof ran out.

## Fix

`server/src/services/leaseHeartbeatSession.ts`: the dedicated session runs
`SET synchronous_commit = off` after `SET statement_timeout = 8000`. A heartbeat COMMIT returns once
the commit record is in the WAL buffers. It no longer waits for the flush or holds the lease rows
during a disk stall.

## What does not change

- What a `kept` answer proves to every live session: the new `heartbeat_at` is visible to other
  transactions the moment COMMIT returns, so a competing claim still sees it and still fails.
- The proof window (20 s from before the request is sent), the 30 s takeover boundary, generations,
  `busy`/UNKNOWN handling and the hedges are unchanged.
- Hand submissions keep synchronous commit and still check instance, generation and
  `heartbeat_at` in the database (`fn_ca_retain_hand_submission`, `FOR KEY SHARE`). A lease that
  another generation holds is answered `taken` and fences at once.
- The only thing given up is durability across a Postgres crash. An unflushed `heartbeat_at` can be
  lost in recovery. A crash ends every engine statement anyway, and the next heartbeat answers
  `taken`/`stale`/`missing` (fail-stop). WAL is flushed in order, so a durable hand also makes
  every earlier heartbeat durable.

## Tests

`server/src/services/aRenewalDoesNotWaitForTheDisk.test.ts` models a database whose synchronous
COMMIT waits out a flush stall while holding its row lock. It runs real `tableLease` passes every
5 s against a real `ServerTableEngine` on fake timers:

- the session commits asynchronously before it renews anything;
- a 25 s flush stall no longer expires the proof. Without the fix this test fails at 25 s, which is
  the production shape;
- a heartbeat that takes 12 s does not expire the proof when the next renewal succeeds;
- a lease taken by another generation still fences the dealer, and
  `hasCurrentEngineLeaseAuthority()` (the gate in front of the atomic hand commit) is false. A later
  proof for the old generation cannot revive it, during a flush stall or not.
