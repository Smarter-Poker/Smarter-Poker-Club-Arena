# tests/a-cluster-wake-does-not-queue-behind-the-pass.law.test.ts

A per-game cluster wake never waits behind the 5-second pass. The pass
(`fn_cash_clusters_tick_all`) holds every `cash_games` row it ticked until it
commits, and the engine's wake (`ClusterController.tickGame` calling
`fn_cash_cluster_tick`) used to queue on that row: 27,682 wakes spent 8,486 s
of database time in 100 minutes on 2026-10-03, mean 307 ms, max 5.8 s. The tick
now takes its row with `SKIP LOCKED` when no pass deadline is set and answers
`ticking_elsewhere` if somebody holds it; inside a pass, which publishes
`ca.cluster_pass_deadline`, it waits as before under the pass's lock timeout.
The law pins the exact fragment replaced on the md5-pinned live text, the
reverse-substitution and privilege checks, the branch on the pass deadline, the
pass still publishing that deadline, and the engine ignoring an answer with no
actions and no `seated_total`. The CI harness applies the shipped migration to
a stand-in carrying the same fragment and proves a held row answers at once, a
free row ticks, a missing game is `not_found`, a pass still waits, and a
session whose pass ended is a wake again.
