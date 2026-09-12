-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903184634; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903184634   (the stamp IS the apply time, UTC: 2026-09-03 18:46:34)
--   name        union_active_players_is_the_sum_of_its_clubs
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2605 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903184634 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_batch_union_realtime_active_counts, public.fn_union_active_player_counts
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH member_clubs AS (
    SELECT uc.union_id, uc.club_id
      FROM public.union_clubs uc
     WHERE uc.union_id = ANY(p_union_ids)
  ),
  per_club AS (
    SELECT a.club_id, a.active_count
      FROM public.fn_batch_club_realtime_active_counts(
             (SELECT coalesce(array_agg(DISTINCT mc.club_id), '{}'::uuid[]) FROM member_clubs mc)
           ) a
  )
  SELECT requested.union_id,
         coalesce(sum(pc.active_count), 0)::bigint AS active_count
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN member_clubs mc ON mc.union_id = requested.union_id
    LEFT JOIN per_club pc ON pc.club_id = mc.club_id
   GROUP BY requested.union_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_active_player_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT * FROM public.fn_batch_union_realtime_active_counts(p_union_ids);
$function$;

REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) IS
  'Sum of each member club''s active-player count (fn_batch_club_realtime_active_counts) over union_clubs. Matches the union member count basis: a player in two clubs is two active players. Returns a row per requested union, zero included.';

DO $assert$
DECLARE
  v_union uuid;
  v_union_active bigint;
  v_club_sum bigint;
BEGIN
  SELECT u.id INTO v_union
    FROM public.unions u
    ORDER BY coalesce(u.member_count, 0) DESC
    LIMIT 1;
  IF v_union IS NULL THEN RETURN; END IF;

  SELECT active_count INTO v_union_active
    FROM public.fn_batch_union_realtime_active_counts(ARRAY[v_union]);

  SELECT coalesce(sum(a.active_count), 0) INTO v_club_sum
    FROM public.fn_batch_club_realtime_active_counts(
           (SELECT coalesce(array_agg(uc.club_id), '{}'::uuid[])
              FROM public.union_clubs uc WHERE uc.union_id = v_union)
         ) a;

  RAISE NOTICE 'union % active=% sum_of_clubs=%', v_union, v_union_active, v_club_sum;

  IF coalesce(v_union_active, -1) <> v_club_sum THEN
    RAISE EXCEPTION 'union active (%) is not the sum of its clubs (%)', v_union_active, v_club_sum;
  END IF;
END;
$assert$;
