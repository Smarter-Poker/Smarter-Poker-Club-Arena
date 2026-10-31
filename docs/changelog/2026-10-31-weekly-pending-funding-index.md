# Weekly cash boundaries cover original transaction times

Midway's completed weekly evidence still reached the statement limit while computing its closing boundary. A read-only copy of the exact original boundary body reproduced the original result hash. Server-clock markers measured 91.711 seconds reconstructing inventory, 6.734 seconds checking cash seats, and 82.563 seconds reading pending cash funding.

The pending query reads original funding and application transaction times through `union_pnl_transaction_frames`. Its primary key covers the transaction identifier, but the time lookup still visits the heap. The table has about 47.5 million rows and roughly 96 percent all-visible heap pages. The new index includes `observed_at` with the original transaction key, permitting visibility-safe index-only access for both lookups.

The migration contains one concurrent index preamble and a transaction that verifies its complete valid index shape and the original installation authority. It changes no function body, source generation, percentage, payment, certificate, cache row, schedule or financial deadline. Use the existing protected-main migration installer; do not build a blocking index on live funding writers.

The isolated PostgreSQL qualification executes the actual migration and original pending query, checks duplicate-preserving row bags and club totals, measures broad-book access, verifies concurrent visibility fallback, and refuses invalid or mismatched index leftovers. The required accounting shard runs it and retains its result. The query has no ordering contract, so a different physical plan may change JSON array order while preserving every financial row.

Installation and live close verification remain separate from native qualification. After installation, use a fresh original rehearsal and its asserted commit, then verify saved documents and unchanged payment receipts. An earlier rehearsal's incidental row order is not a valid replacement for that proof.
