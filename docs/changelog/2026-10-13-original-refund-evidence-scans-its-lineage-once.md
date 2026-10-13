# Original refund evidence scans its lineage once

The original weekly refund classifier performed a sequential application scan for each eligible cash refund flow. Production plans identify this repeated branch; isolated PostgreSQL17 qualification with 27,557 applications and 1,024 eligible flows reproduces 1,024 scans. A materialized join over deduplicated original transaction/table/player/club/amount keys performs one scan and returns the identical complete branch rows.

Only RF lineage resolution and its empty COUNT0 expression change. Original pending-addon, occupancy, account, club, player, amount and transaction checks remain exact. Duplicate original flows do not multiply applications; multiple matching applications still fail the downstream exactly-one proof. All unrelated financial branches remain byte-identical.

The guarded migration binds the actual installed function and source40 matcher, changes only the flow tuple, preserves source security, and relies on the existing generation identity to invalidate stale caches. It never changes historical certificates, money, indexes or execution budgets. Native classification26 and rowwork evidence are isolated; whole-week readiness still requires actual post-installation natural completion.
