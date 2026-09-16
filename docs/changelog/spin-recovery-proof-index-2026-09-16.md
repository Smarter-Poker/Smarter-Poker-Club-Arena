# A Spin recovery proof read 1.8 GB of ledger to find two rows

Club Arena, 2026-09-16. Follow-up to the horses-are-not-playing work.

`fn_prove_played_spin_launch_recovery` averaged 3,109 ms over 254 calls with
a 9,885 ms worst case against its own 10 s statement timeout, and the engine
logged `played_spin_recovery_unreadable ... canceling statement due to
statement timeout`: a proof that cannot be read is a Spin that stands down
with three paid seats instead of dealing. This is the door behind the forty
stranded Spins of 2026-09-12.

The `journals` CTE reads the Spin's `spin_entry` and `spin_prize` ledger rows
by `tournament_id` and `category`, and `chip_ledger` had no index that could
answer it: a parallel sequential scan over 809,372 rows per worker, 238,660
shared buffers, 996 ms when everything was cached and the box was quiet.

`idx_chip_ledger_tournament_category` on `(tournament_id, category) WHERE
tournament_id IS NOT NULL` (625,543 of 4,046,878 rows; 22 MB) turns that read
into a five-buffer index-only scan: 0.148 ms. The whole proof measured 32 ms
after the build. Built CONCURRENTLY through psql at 19:28 UTC and recorded as
version 20260916193500; the function itself is unchanged.
