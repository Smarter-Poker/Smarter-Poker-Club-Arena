# A tournament heartbeat walks each lease once (2026-10-03)

## What happened

09:34-09:38Z: 470 `tournament_lease_proof_expired` and 333 `tournament_lease_lost` watchdog
rebuilds, plus 29 hand refusals, while cron job 407 held one transaction from 09:25:00 to 09:40:00
(a rolled-back probe of the weekly union close). Cash heartbeats were unaffected.

- The dedicated tournament heartbeat hit its 8 s `statement_timeout` at 09:34:41, 09:35:46,
  09:37:06, 09:38:26 and 09:38:51. It never waited on a lock (`log_lock_waits` at 1 s logged
  nothing for `engine_lease_heartbeat`; the function skips locked rows). Hedges on the shared
  client took 4.2-7.4 s. Since 2026-10-02 23:57 the tournament heartbeat's max is 7,650 ms; the
  table heartbeat's is 1,038 ms.
- The union close never reads or locks `engine_tournament_leases`, the f06 tables or any row the
  heartbeat touches. It held the xmin horizon for 15 minutes.

## Why only tournaments

Every tournament-manager write takes `FOR KEY SHARE` on its lease row
(`fn_smarter_data_api_pre_request`, hand submissions), and the heartbeat updates that row every
5 s, so each superseded version carries a MultiXact xmax. With the horizon pinned nothing is
pruned. Each row grows about 12 versions a minute, and every index probe of the row walks the
chain, resolving MultiXact members for each version through a small SLRU
(`multixact_member_buffers` 32, `multixact_offset_buffers` 16). That SLRU already reads about
10k member pages a second at normal load. The function probed each claim three times.

Local PostgreSQL 16 reproduction (same function text and md5, 264 leases, 16 clients taking
`FOR KEY SHARE` at ~2,800 tps, one REPEATABLE READ transaction pinning the horizon, one fleet
heartbeat a second): 48 ms rose to 500-870 ms within ~150 heartbeats. The same pin without the
lockers went only from 28 to 74 ms.

## Fix

Migration `20261003131500_a_tournament_heartbeat_walks_each_lease_once` edits
`heartbeat_tournament_leases_v4` by three measured anchors:

- The `lockable` CTE also returns the ctid it locked. The UPDATE reaches that exact version by TID
  scan, with every predicate kept, plus `tournament_id` equal to the locked row.
- The answer for a renewed claim comes from RETURNING. Only claims that were not renewed read the
  row again, with the classification rules unchanged.

Every state (kept, taken, stale, other instance, aborted generation, `FOR SHARE` busy,
`KEY SHARE` kept, missing) returns the same state and generation as before. Measured gain under a
pin: 2.6x in one late-pin measurement, and 1.33-1.5x on average when the two versions alternate.
Lock-hold time drops with it.

## What remains

This lowers the cost of every renewal, but it does not make an unbounded pin harmless. The onset
on 2026-10-03 was about 9 minutes into the pin, so back-office transactions during play must stay
well below that; a single close step of 440-740 s is inside the danger zone. Raising the
MultiXact SLRU buffers (PG17 `multixact_*_buffers`, needs a restart) would remove the amplifier.
