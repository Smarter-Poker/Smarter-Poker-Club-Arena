# Hand-stat writers use one order

The original stats alerts 76 and 79 include a September 13 04:15:09.807
PostgreSQL deadlock between the forward stat rollup and the post-commit hand
projector. Both inserted the same player/hand keys into `ca_hand_player_stat`
without a common write order. This is distinct from the nearby hand-index
deadlock and the separate `player_stats` settlement conflict.

Migration `20260914212802_hand_stat_writers_share_a_canonical_order.sql`
orders the key pairs in all four existing stat writers. The forward and
historical bulk writers share a nonblocking transaction lock before reading
cursors or touching rows. A busy bulk call returns zero without advancing
its cursor or marking completion. Single-hand projection stays concurrent.
The existing forward maintenance caller reports this count and remains
scheduled; no backward caller or direct cron entry was found in the examined
source and live public-function catalog. No new repair job is introduced.

All four complete function hashes, owners and grants are checked before any
definition changes, and each resulting hash is verified. An exact repeat
application succeeds; body or authority drift aborts atomically. The
preceding hand-index migration `20260914194928` is required. Financial
arithmetic, retention limits, time windows, cursor coverage, atomic-hand
exclusion, outbox completion and permissions are unchanged.

The committed native runner passed 57 checks, including a reproduction of
the original deadlock, both writer orders, bulk deferral, later progress,
retention, rollback, replay and migration guards. Supplemental task evidence
passed 110 overlapping full-schema checks using actual facts helpers and
matching baseline/candidate cash, tournament and Diamond projections. Both
used the existing PostgreSQL 17.11 installation on macOS arm64 with zero
production connections. The private fixtures were removed afterward.

The minimal probe supplies legal opposite facts orders and avoids unrelated
financial aggregates. The larger probe uses synthetic hand and zero-charge
obligation inputs in rolled-back transactions. Neither qualifies the actual
accepted-hand path, nonzero financial obligations, all current dependencies,
Linux runtime, native release or production installation. The incident
remains open until the required release checks, installed hashes and natural
production progress are verified. Current delivery uses the existing GitHub-hosted
accounting_postgres job and root-controlled migration path; historical local
evidence does not qualify that hosted run. No retired local pipeline is used.
