# Club Data reporting rollups

## Summary

Club Data no longer re-sums the production wallet and tournament-rake ledgers on every Games or Players request. Three RLS-protected daily reporting facts now provide the same per-club game, player, fee, and net data at bounded query cost.

## Reliability

- Relevant wallet and tournament-rake inserts update the reporting facts in the same transaction.
- Ledger updates or deletes rebuild the affected UTC day from source.
- `ca_refresh_reporting_rollups` can rebuild any bounded range from the authoritative ledgers.
- An advisory lock prevents a rebuild from racing an in-flight ledger trigger.
- The initial migration backfills the full 186-day current/comparison reporting horizon.

## Compatibility and security

- The existing `ca_club_data_snapshot` and `ca_club_player_breakdown` JSON contracts are unchanged.
- Union players retain first-joined home-club attribution.
- Tournament performance retains member-centric attribution across events, while cash performance remains tied to the table's union.
- Per-player hand totals are now pinned to the requested club instead of including the same player's activity in unrelated clubs.
- Tournament-table wallet movements are excluded from cash net, matching the existing cash-game definition.
- Creator search is joined once instead of running a correlated profile lookup across every tournament row.
- No-search requests use a dedicated plan containing no optional `ILIKE` branch, preventing PostgreSQL from evaluating search work for every row when the search box is empty.
- The no-search helper is replanned with its actual club and date values, avoiding PostgreSQL's measured 20-second generic plan in favor of the indexed one-second plan.
- Snapshot totals are aggregated inside PostgreSQL and only the visible top 100 rows cross the function boundary; tournament participant counts are calculated after that bound.
- Horse profiles remain included and retain their `is_horse` marker.
- Reporting tables have RLS enabled with no direct browser policies; access remains through authorized definer RPCs.
