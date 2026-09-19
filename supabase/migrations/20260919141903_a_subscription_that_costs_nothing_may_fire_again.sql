-- 20260919141903_a_subscription_that_costs_nothing_may_fire_again
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 14:19:03 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT WAS WRONG
--
-- On 2026-09-06 the realtime publication was trimmed to fix a WAL stream that
-- was costing 22.9 seconds of database time per 15 seconds of WAL - 68% of one
-- core, continuously - and on 2026-09-08 a SET TABLE replaced the rest of its
-- membership. Both were right. `notifications` was restored additively on
-- 2026-09-10 after somebody noticed it had gone.
--
-- Nobody swept the client for the others. Measured 2026-09-19: the publication
-- carries FIVE tables in public - club_members, notifications,
-- tournament_bounty_obligations, tournament_deal_votes,
-- tournament_manager_wakes - and this repository's src/ makes 34
-- postgres_changes subscriptions to tables that are not among them. Those
-- channels join, report SUBSCRIBED, and receive nothing, for ever, with no
-- error. That is the same silence that killed the hole-card push for four
-- hours on 2026-08-31 and the reason
-- scripts/ci/check-realtime-publication.mjs exists; its KNOWN_UNPUBLISHED
-- baseline was seeded on 2026-09-06, BEFORE the trim, so the 34 that died
-- after it were never recorded and the detector has been red ever since.
--
-- THE MEASUREMENT THAT DECIDES IT
--
-- The 2026-09-06 work established that decode cost tracks the number of
-- CHANGES and, per change, the COLUMN COUNT, because apply_rls runs roughly
-- one dynamic cast plus one column-privilege check per column per change. So
-- the question is not "is this table useful" but "what does publishing it
-- cost", and that is arithmetic. From pg_stat_user_tables, writes since the
-- stats reset:
--
--   NOT PUBLISHED HERE - 56,527,172 writes across eleven tables
--     tournament_players  25,280,935   27 cols
--     table_seats         14,582,928   26 cols
--     tournaments          5,477,895  117 cols
--     tables               4,643,367  159 cols
--     agent_commissions    1,802,610   10 cols
--     agents               1,066,935   31 cols
--     clubs                1,047,848   94 cols
--     game_management_events 1,027,487 14 cols
--     profiles             1,000,061  120 cols
--     union_wallets          338,150   12 cols
--     chip_transactions      258,956   15 cols
--
--   PUBLISHED HERE - 35,618 writes across twenty-three tables, which is
--   0.063% of the eleven above. Every one of them is subscribed to by this
--   repository's client today and receives nothing:
--
--     theme_asset_unlocks 19,580 · friendships 5,816 · unions 3,407 ·
--     wallets 2,633 · user_theme_settings 1,956 · audit_trail 801 ·
--     settlement_invoices 848 · user_table_settings 467 ·
--     anti_cheat_flags 54 · bbj_winners 23 · session_history 3 ·
--     club_chat, table_chat, club_announcements, cashout_requests,
--     club_diamond_wallets, disputes, flash_pools, promotions, messages,
--     anti_cheat_events, user_table_studio_preferences - all 0
--     (table_waitlist joins them at 30 writes over 8 columns; see below)
--
-- So this restores twenty-three live features for six hundredths of one percent
-- of the write volume the trim was protecting the poller from. The eleven
-- expensive ones stay out and are recorded in the detector's baseline with
-- their measured cost, because their pages need a different delivery path -
-- the engine socket, or a refetch - not a republished table.
--
-- THIS IS NOT A FAKE FIX. Realtime evaluates RLS per subscriber, so a
-- published table with no SELECT policy the subscriber can satisfy delivers
-- nothing and would look identical to the bug. All twenty-three were checked
-- first, and the block below re-checks each one before publishing it: every one
-- has row-level security ON and at least one SELECT (or ALL) policy reachable
-- by `authenticated`. Two carry REPLICA IDENTITY FULL, which
-- makes each change carry the whole old row - `messages` (0 writes) and
-- `user_table_settings` (467). At those volumes it is immaterial, and changing
-- a replica identity is a separate decision with its own risks, so neither is
-- touched here.
--
-- ONE STATEMENT, NOT TWENTY-THREE. Every DDL event reloads PostgREST's schema
-- cache, ~28 seconds on this database. Twenty-three loose ALTERs would be ten
-- minutes of reloads. The block below builds a single ALTER PUBLICATION for
-- whatever is not already published, so a re-run is a no-op and a first run is
-- one reload.
--
-- ADD TABLE, never SET TABLE. SET TABLE is what silently dropped
-- `notifications` on 2026-09-08; it replaces the whole membership. The five
-- tables already published are asserted present afterwards.
--
-- APPLIED IN TWO PARTS, and this file is the end state. The first apply
-- (schema_migrations 20260919142022) carried twenty-two. Re-scanning src/
-- immediately afterwards left twelve subscriptions still dead - eleven of them
-- the expensive tables above, and table_waitlist, which had never been
-- measured. It turns out to be 8 columns, 30 writes and 4 live rows, with RLS
-- on and three SELECT policies reachable by authenticated, and it is what
-- src/components/common/GlobalWaitlistListener.tsx needs so a waitlisted
-- player learns a seat opened. It went in as
-- the_waitlist_listener_can_hear_a_seat_open. This file lists all twenty-three
-- and adds only what is missing, so running it now is a no-op and running it
-- on a fresh database produces the same end state in one reload.
--
-- @live-proof: (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename IN ('club_chat','table_chat','friendships','club_announcements','bbj_winners','promotions','flash_pools','wallets','disputes','cashout_requests','settlement_invoices','club_diamond_wallets','session_history','theme_asset_unlocks','user_theme_settings','user_table_studio_preferences','unions','audit_trail','messages','anti_cheat_events','anti_cheat_flags','user_table_settings','table_waitlist')) = 23
-- @live-proof: (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename IN ('tournament_players','table_seats','tournaments','tables','agent_commissions','agents','clubs','game_management_events','profiles','union_wallets','chip_transactions')) = 0
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $publish$
DECLARE
  -- Subscribed by src/ today, receiving nothing, and cheap to decode.
  v_wanted CONSTANT text[] := ARRAY[
    'club_chat', 'table_chat', 'friendships', 'club_announcements',
    'bbj_winners', 'promotions', 'flash_pools', 'wallets', 'disputes',
    'cashout_requests', 'settlement_invoices', 'club_diamond_wallets',
    'session_history', 'theme_asset_unlocks', 'user_theme_settings',
    'user_table_studio_preferences', 'unions', 'audit_trail', 'messages',
    'anti_cheat_events', 'anti_cheat_flags', 'user_table_settings',
    'table_waitlist'];
  -- The eleven the 2026-09-06 trim exists to keep out. Named so this
  -- migration refuses rather than drifts if one is ever added to v_wanted.
  v_forbidden CONSTANT text[] := ARRAY[
    'tournament_players', 'table_seats', 'tournaments', 'tables',
    'agent_commissions', 'agents', 'clubs', 'game_management_events',
    'profiles', 'union_wallets', 'chip_transactions'];
  v_before CONSTANT text[] := ARRAY[
    'club_members', 'notifications', 'tournament_bounty_obligations',
    'tournament_deal_votes', 'tournament_manager_wakes'];
  v_name  text;
  v_add   text[] := ARRAY[]::text[];
  v_bad   text;
  v_kept  int;
BEGIN
  IF v_wanted && v_forbidden THEN
    RAISE EXCEPTION 'refused: a table the 2026-09-06 trim excluded is in the publish list';
  END IF;

  -- Every one must exist, have RLS on, and be readable by a subscriber, or
  -- publishing it delivers nothing and only looks like a fix.
  FOREACH v_name IN ARRAY v_wanted LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = v_name AND c.relkind = 'r') THEN
      RAISE EXCEPTION 'refused: public.% is not a table', v_name;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = v_name) THEN
      RAISE EXCEPTION 'refused: public.% has row-level security off; publishing it would broadcast every row', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = v_name
                      AND p.cmd IN ('SELECT', 'ALL')
                      AND (p.roles @> ARRAY['authenticated']::name[]
                           OR p.roles @> ARRAY['public']::name[])) THEN
      RAISE EXCEPTION 'refused: public.% has no SELECT policy a subscriber can satisfy', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                      AND tablename = v_name) THEN
      v_add := v_add || v_name;
    END IF;
  END LOOP;

  IF array_length(v_add, 1) IS NULL THEN
    RAISE NOTICE 'every table is already published; nothing to do';
  ELSE
    -- ONE statement, so ONE schema-cache reload.
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.'
         || array_to_string(v_add, ', public.');
    RAISE NOTICE 'published % table(s): %', array_length(v_add, 1), array_to_string(v_add, ', ');
  END IF;

  -- ADD, not SET: the five that were already published are still published.
  SELECT count(*) INTO v_kept FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
     AND tablename = ANY(v_before);
  IF v_kept <> array_length(v_before, 1) THEN
    RAISE EXCEPTION 'refused: the publication lost a table it already carried (% of % remain)',
      v_kept, array_length(v_before, 1);
  END IF;

  -- And nothing expensive crept in.
  SELECT string_agg(tablename, ', ') INTO v_bad FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
     AND tablename = ANY(v_forbidden);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'refused: the publication now carries %, which the 2026-09-06 trim excluded', v_bad;
  END IF;

  FOREACH v_name IN ARRAY v_wanted LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                      AND tablename = v_name) THEN
      RAISE EXCEPTION 'failed: public.% is still not published', v_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'supabase_realtime now carries % public table(s)',
    (SELECT count(*) FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public');
END
$publish$;

COMMIT;
