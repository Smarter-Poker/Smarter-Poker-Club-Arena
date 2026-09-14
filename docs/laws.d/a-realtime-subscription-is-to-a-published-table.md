# tests/a-realtime-subscription-is-to-a-published-table.law.test.ts

Supabase `postgres_changes` delivers rows only for tables in the
`supabase_realtime` publication, and a subscription to a table outside it fails
in the worst possible way: the channel opens, the status callback reports
`SUBSCRIBED`, the handler is attached, and no event ever arrives. No error, no
warning, no log line - the screen is simply stale forever. Measured against
production on 2026-09-14 the publication held FIVE tables, and `src/` held 115
`postgres_changes` subscriptions of which 105, across 62 files, named a table
that is not one of them: thirteen on `tournaments`, seven on `tables`, six on
`table_seats`, five each on `tournament_players`, `clubs`, `agents`,
`agent_commissions` and `chip_transactions`. None has ever fired. This law does
not fix them - `ALTER PUBLICATION ... ADD TABLE tournaments` would switch on
thirteen callbacks that have never executed in production, at once, on a live
poker platform, which is a review per subscriber and a migration per table. It
stops the number growing: the 105 are quarantined by file and table, a new
subscription to an unpublished table fails, and the author must either publish
the table deliberately (updating `REALTIME_PUBLISHED_TABLES` in `tests/helpers/realtimePublishedTables.ts` in the same commit)
or push with `realtime.send()` on a named channel, which needs no publication
and has no blast radius. The quarantine is a ratchet - a stale entry fails too,
because it would wave the next dead subscription straight through.
