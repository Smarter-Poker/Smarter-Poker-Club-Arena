-- ═══════════════════════════════════════════════════════════════════════════
-- RESTORE table_hole_cards TO THE REALTIME PUBLICATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED TO PRODUCTION 2026-08-31 ~23:15 UTC as an incident fix, ahead of
-- this file landing. Recorded here so the repo and the database agree.
--
-- Migration 20260831190200_trim_realtime_publication_hot_unsubscribed dropped
-- this table from supabase_realtime at ~19:02 UTC on the stated grounds that
-- it had "ZERO subscribers". That premise was wrong.
--
-- table_hole_cards IS the delivery channel for a player's own hole cards. The
-- engine never sends them over the game WebSocket (ServerTableEngineHandEvents
-- .ts:313-336, "Do NOT broadcast state here - cards are delivered securely via
-- table_hole_cards"), and every public snapshot deliberately scrubs them
-- (mapEngineSnapshot.ts:398). The client's ONLY push receiver is
-- TablePage.tsx's `table-cards-secure-*` channel - invisible to a grep for
-- `postgres_changes` because the table name is passed as a `table:` PROP to
-- the useMasterBusChannel wrapper rather than written at an .on() call site.
-- That is how the audit came to believe nobody was listening.
--
-- Consequence between 19:02 and the fix: no player at any table received a
-- hole-card push. Cards arrived only through the client's bounded recovery
-- poll, so players sat blind through much of a 15s action clock, and the
-- reconnect re-push (ServerTableEngineDealing.rePushHoleCards, which works by
-- re-upserting the row precisely to fire this subscription) was inert - there
-- was no mid-hand reconnect recovery at all.
--
-- This restores what 20260815032444_add_table_hole_cards_to_realtime_
-- publication added for the same reason; that migration's own comment records
-- the channel erroring "on every table page load" until it landed. Twice is
-- enough, so the assertion below now fails loudly instead.
--
-- REPLICA IDENTITY FULL is required, not cosmetic: the reconnect re-push
-- re-delivers by UPDATE (ON CONFLICT DO UPDATE), and without FULL the client's
-- payload carries no usable `old` row.
--
-- THE WAL COST THE TRIM WANTED IS REAL AND STAYS UNPAID HERE. Correctness
-- first. The durable fix is to deliver hole cards as a private frame on the
-- engine socket the player already holds and then drop this table from
-- realtime for good - tracked separately. Do not re-trim it before that ships.

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
