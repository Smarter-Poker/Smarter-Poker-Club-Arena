/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHICH TABLES REALTIME ACTUALLY PUBLISHES (measured 2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Supabase's `postgres_changes` only delivers rows for tables that are members
 * of the `supabase_realtime` PUBLICATION. A subscription to a table outside it
 * is not an error: the channel opens, `SUBSCRIBED` fires, the callback is wired
 * up, and then nothing ever arrives. It fails SILENTLY and it fails FOREVER.
 *
 * This file exists because that is not hypothetical here. Measured against
 * production on 2026-09-14:
 *
 *     SELECT tablename FROM pg_publication_tables
 *      WHERE pubname = 'supabase_realtime';
 *
 * returned FIVE tables. `src/` at the same moment carried 115 `postgres_changes`
 * subscriptions, of which 105 - across 62 files - named a table that is not one
 * of them. Thirteen of those were on `tournaments`, seven on `tables`, six on
 * `table_seats`, five each on `tournament_players`, `clubs`, `agents`,
 * `agent_commissions` and `chip_transactions`.
 *
 * So the honest description of realtime on this platform is: a handful of
 * `club_members` and `notifications` listeners work, and everything else is a
 * websocket channel waiting for a message that cannot be sent.
 *
 * ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────
 *
 * `a-realtime-subscription-is-to-a-published-table.law.test.ts` reads this list
 * and fails any NEW `postgres_changes` subscription that names a table outside
 * it. The 105 that already exist are quarantined there by name, so the law is
 * green today and the number can only go down.
 *
 * It lives under `tests/` and not `src/` deliberately: nothing in the app reads
 * it, because it is not application configuration - it is a checked-in copy of
 * something that lives in the DATABASE, kept here so a test can see it. A file
 * under `src/` that the entry cannot reach is dead weight in the bundle and
 * `every-file-under-src-is-reachable.law.test.ts` is right to say so.
 *
 * ── HOW TO ADD A TABLE ─────────────────────────────────────────────────────
 *
 * A migration, not an edit here:
 *
 *     ALTER PUBLICATION supabase_realtime ADD TABLE public.<table>;
 *
 * and then add it below in the same commit. Two things to weigh first, because
 * neither is free:
 *
 *   1. EVERY row change is decoded from the WAL and RLS-evaluated PER
 *      SUBSCRIBER. On a hot table with many listeners that is real CPU, and it
 *      is charged per message.
 *   2. PUBLISHING A TABLE WAKES EVERY SUBSCRIPTION TO IT AT ONCE. There are 13
 *      listeners on `tournaments` that have never once run their callback in
 *      production. Publishing it does not "turn realtime on" - it turns on
 *      thirteen untested code paths simultaneously, on a live poker platform.
 *      Publish a table only alongside a deliberate review of every subscriber
 *      to it, and prefer doing it one table at a time.
 *
 * For a NEW feature that wants server-pushed updates, `realtime.send()` and
 * `realtime.broadcast_changes()` both exist on this database and are the better
 * tool: an explicit message on a named channel, nothing decoded from the WAL,
 * and no blast radius over code nobody has re-read.
 */

/** Tables in the `supabase_realtime` publication. Verified 2026-09-14. */
export const REALTIME_PUBLISHED_TABLES: readonly string[] = [
  'club_members',
  'notifications',
  'tournament_bounty_obligations',
  'tournament_deal_votes',
  'tournament_manager_wakes',
];

/** True when `postgres_changes` on this table can actually deliver a row. */
export function isRealtimePublished(table: string): boolean {
  return REALTIME_PUBLISHED_TABLES.includes(table);
}
