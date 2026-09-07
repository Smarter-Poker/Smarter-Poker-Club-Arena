# server/src/engine/oneSeriesPerMetricName.law.test.ts

Every global gauge on /metrics is emitted exactly ONCE for the whole fleet and
every per-table sample carries a `table_id` (2026-09-07: GameServer
concatenated all 272 engines' expositions, so Prometheus kept one arbitrary
sample per name and answered `poker_active_tables 1` while 272 tables dealt -
`EngineFleetShrank` could never fire and `EngineHandsStopped` fired for hours
on a healthy engine); and `poker_hands_dealt_total` is a monotonic counter
rather than the length of the 100-entry hand-timing ring buffer, which pinned
it at 100 and made `increase(...)` zero forever.
