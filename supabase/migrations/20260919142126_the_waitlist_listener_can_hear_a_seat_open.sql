-- THE WAITLIST LISTENER CAN HEAR A SEAT OPEN (2026-09-19)
--
-- The second part of a_subscription_that_costs_nothing_may_fire_again, applied
-- minutes later. That migration restored twenty-two dead subscriptions;
-- re-scanning src/ afterwards left twelve still dead, eleven of them the
-- expensive tables the 2026-09-06 WAL trim exists to keep out - and
-- table_waitlist, which had not been measured and turns out to be nothing
-- like them.
--
-- Measured now: 8 columns, 30 writes since the stats reset, 4 live rows, RLS
-- on, three SELECT policies reachable by authenticated
-- (waitlist_admin_read, waitlist_public_queue_read, waitlist_user_own_read).
-- It carries REPLICA IDENTITY FULL, which makes each change carry the whole
-- old row; at 30 writes over 8 columns that is immaterial and changing a
-- replica identity is a separate decision.
--
-- What it costs to leave out is the whole point of the feature:
-- src/components/common/GlobalWaitlistListener.tsx subscribes to it so a
-- waitlisted player learns a seat opened. Unpublished, that channel joins,
-- reports SUBSCRIBED, and the player is never told.
--
-- ADD TABLE, never SET TABLE. The other twenty-seven are asserted present
-- afterwards.
--
-- Repo file: supabase/migrations/20260919141903_a_subscription_that_costs_nothing_may_fire_again.sql
-- (that file lists all twenty-three and only adds what is missing, so it is
-- the end state and a re-run is a no-op).
--
-- @live-proof: EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'table_waitlist')

DO $publish$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'table_waitlist') THEN
    RAISE EXCEPTION 'refused: public.table_waitlist has row-level security off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'table_waitlist'
                    AND p.cmd IN ('SELECT', 'ALL')
                    AND (p.roles @> ARRAY['authenticated']::name[]
                         OR p.roles @> ARRAY['public']::name[])) THEN
    RAISE EXCEPTION 'refused: public.table_waitlist has no SELECT policy a subscriber can satisfy';
  END IF;

  SELECT count(*) INTO v_before FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public';

  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'table_waitlist') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.table_waitlist;
  ELSE
    RAISE NOTICE 'table_waitlist was already published; nothing to do';
  END IF;

  SELECT count(*) INTO v_after FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public';

  IF v_after < v_before THEN
    RAISE EXCEPTION 'refused: the publication lost tables (% -> %)', v_before, v_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'table_waitlist') THEN
    RAISE EXCEPTION 'failed: public.table_waitlist is still not published';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                AND tablename = ANY(ARRAY['tournament_players','table_seats','tournaments','tables',
                                          'agent_commissions','agents','clubs','game_management_events',
                                          'profiles','union_wallets','chip_transactions'])) THEN
    RAISE EXCEPTION 'refused: the publication now carries a table the 2026-09-06 trim excluded';
  END IF;

  RAISE NOTICE 'supabase_realtime now carries % public table(s)', v_after;
END
$publish$;
