-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831231703; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- RESTORE table_hole_cards TO THE REALTIME PUBLICATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 2026-08-31, INCIDENT FIX. Migration 20260831190200_trim_realtime_publication_
-- hot_unsubscribed dropped this table from supabase_realtime at ~19:02 UTC on
-- the stated grounds that it had "ZERO subscribers". That premise was wrong.
--
-- table_hole_cards IS the delivery channel for a player's own hole cards. The
-- engine never sends them over the game WebSocket (ServerTableEngineHandEvents
-- .ts:313-336, "Do NOT broadcast state here"), and every public snapshot
-- deliberately scrubs them (mapEngineSnapshot.ts:398). The client's ONLY push
-- receiver is TablePage.tsx:8133-8141 — and it is invisible to a grep for
-- `postgres_changes` because the table name is passed as a `table:` PROP to the
-- useMasterBusChannel wrapper rather than written at an .on() call site. That
-- is how the audit missed it.
--
-- Consequence between 19:02 and this migration: no player received a hole-card
-- push. Cards arrived only via the client's bounded 0s/2s/5s recovery poll, so
-- players sat blind through most of a 15s action clock, and the reconnect
-- re-push (ServerTableEngineDealing.ts:2425 rePushHoleCards) — which works by
-- re-upserting the row precisely to fire this subscription — was inert, leaving
-- no mid-hand reconnect recovery at all.
--
-- This also restores what 20260815032444_add_table_hole_cards_to_realtime_
-- publication added for the same reason; its own comment records that the
-- channel errored "on every table page load" until it landed.
--
-- REPLICA IDENTITY FULL is required, not optional: rePushHoleCards re-delivers
-- by UPDATE (ON CONFLICT DO UPDATE), and without FULL the client's payload
-- carries no usable `old` row for the change detection.
--
-- THE WAL COST THE TRIM WANTED IS REAL AND STAYS UNPAID HERE. Correctness
-- first. The durable fix is to move hole cards onto the private engine socket
-- the player already holds and drop this table from realtime again — tracked
-- separately. Do not re-trim this table before that ships.

ALTER TABLE public.table_hole_cards REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'table_hole_cards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.table_hole_cards;
  END IF;
END $$;

-- Assert it, so a future publication trim fails loudly here instead of
-- silently blinding every player at every table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'table_hole_cards'
  ) THEN
    RAISE EXCEPTION 'table_hole_cards MUST be in the supabase_realtime publication - it is the only delivery path for a player''s own hole cards';
  END IF;
  IF (SELECT relreplident FROM pg_class WHERE oid = 'public.table_hole_cards'::regclass) <> 'f' THEN
    RAISE EXCEPTION 'table_hole_cards MUST have REPLICA IDENTITY FULL for the reconnect re-push to reach the client';
  END IF;
END $$;
