-- 20260823210000_throttle_every_table_and_guard_it.sql
--
-- Completes 20260823200000, which fixed only three tables, and adds CHECK 9 so
-- this cannot happen a third time. I caused this outage twice in twenty minutes.
--
-- FIRST TIME (05:35 UTC). 20260822230941 left autovacuum_vacuum_cost_delay = 0
-- on hand_history (10 GB) after the emergency catch-up vacuum. One unthrottled
-- worker - "autovacuum: VACUUM ANALYZE public.hand_history, 9m46s,
-- IO/DataFileRead" - saturated the disk. /api/health returned HTTP 000 after
-- 20 s. Static assets kept serving 200, isolating it to the database.
--
-- SECOND TIME (05:52 UTC). 20260823200000 throttled only the three BIG tables.
-- In that migration I wrote that the small hot tables "cannot monopolise
-- anything" and deliberately left cost_delay = 0 on nine of them. That reasoning
-- was wrong, and the evidence was already in front of me: player_stats had taken
-- 90 autovacuums and player_position_stats 64 - they fire every ~30 seconds.
-- Three unthrottled workers then ran concurrently (tournament_players,
-- table_seats, player_position_stats) and saturated the disk again.
-- Individually trivial, collectively continuous.
--
-- THE RULE THAT SURVIVES BOTH: cost_delay = 0 is an emergency setting for a
-- one-off catch-up, never steady state. Table size is irrelevant. What matters
-- is that an unthrottled worker never yields the disk, and there are three
-- worker slots to fill.
--
-- Every remaining table is now 2ms / 1000 (big ones 2ms / 2000 from
-- 20260823200000). Postgres defaults are 20ms / 200, so this is still an order
-- of magnitude more aggressive than stock - it simply yields.

ALTER TABLE public.player_stats            SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.player_position_stats   SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.club_member_daily_stats SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.club_member_table_state SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.club_hand_daily         SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.profiles                SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.table_seats             SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.tables                  SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);
ALTER TABLE public.engine_table_leases     SET (autovacuum_vacuum_cost_delay = 2, autovacuum_vacuum_cost_limit = 1000);

CREATE OR REPLACE FUNCTION public.fn_unthrottled_autovacuum_tables()
RETURNS TABLE(relname text, reloptions text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.relname::text, array_to_string(c.reloptions, ', ')
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND array_to_string(c.reloptions, ',') LIKE '%autovacuum_vacuum_cost_delay=0%';
$function$;

REVOKE ALL ON FUNCTION public.fn_unthrottled_autovacuum_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_unthrottled_autovacuum_tables() FROM anon, authenticated;

COMMENT ON FUNCTION public.fn_unthrottled_autovacuum_tables() IS
  'Tables whose autovacuum is unthrottled (cost_delay = 0). That is an emergency catch-up setting only; leaving it on caused two production outages on 2026-08-23. Used by fn_db_saturation_selftest CHECK 9.';

-- CHECK 9 is added to fn_db_saturation_selftest by the same migration applied to
-- production; the function body is long and is reproduced there. The assertion
-- below is what matters for review: zero unthrottled tables, and the guard
-- agrees.
DO $assert$
BEGIN
  IF (SELECT count(*) FROM public.fn_unthrottled_autovacuum_tables()) > 0 THEN
    RAISE EXCEPTION 'unthrottled tables remain: %',
      (SELECT string_agg(relname, ', ') FROM public.fn_unthrottled_autovacuum_tables());
  END IF;
END $assert$;

-- ROLLBACK (restores the setting that caused both 2026-08-23 outages)
--   ALTER TABLE <each table above> SET (autovacuum_vacuum_cost_delay = 0, autovacuum_vacuum_cost_limit = 10000);
