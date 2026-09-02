-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825011905; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PERFORMANCE 2026-08-25. fn_sync_tournament_chips: stop rewriting rows whose
-- chip count has not changed.
--
-- ============================================================================
-- EVIDENCE
-- ============================================================================
-- tournament_players took 151,246 writes in the ~2.7h since the database
-- restart - about 940 writes per minute, and 48% of ALL writes to tables in the
-- supabase_realtime publication. Realtime WAL decoding is currently the single
-- largest consumer of database time at 33.8% (6,741 calls, 271 ms mean).
--
-- ============================================================================
-- ROOT CAUSE
-- ============================================================================
-- The sync rewrote EVERY playing player's row on every call:
--
--   UPDATE tournament_players tp
--      SET chips = floor(GREATEST(u.chips, 0))::integer
--     FROM jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
--    WHERE tp.tournament_id = p_tournament_id
--      AND tp.user_id = u.user_id
--      AND tp.status = 'playing';
--
-- There was no test for whether the value actually differed. Between hands most
-- players' stacks are unchanged - they folded, or were not in the hand at all -
-- so the majority of these were NO-OP updates that still paid full price:
--
--   * a new heap tuple under MVCC, so the table bloats and autovacuum must
--     later reclaim the dead one;
--   * a full WAL record;
--   * index maintenance on every index over the row;
--   * and, because tournament_players is in the supabase_realtime publication,
--     a logical-decode plus RLS evaluation per subscriber - for a row whose
--     content did not change.
--
-- ============================================================================
-- FIX
-- ============================================================================
-- One extra predicate. IS DISTINCT FROM (not <>) so a NULL chips column is
-- handled correctly rather than silently never matching.
--
-- Postgres does not skip no-op UPDATEs on its own - an UPDATE that sets a
-- column to the value it already holds still writes a new tuple - so this has
-- to be expressed in the WHERE clause.
--
-- RETURN VALUE: v_count now counts rows ACTUALLY CHANGED rather than rows
-- matched. Verified safe: the sole caller is
-- server/src/tournament/TournamentManagerEliminations.ts:58, which destructures
-- only `{ error }` from the RPC and never reads the count. The narrower meaning
-- is also the more useful one for any future caller.
--
-- Chip values themselves are unchanged: same floor(GREATEST(chips, 0))::integer
-- expression, same tournament / user / status filter. A player whose stack DID
-- change is still written exactly as before.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   Restore the previous body by removing the final AND predicate, i.e. the
--   line beginning `AND tp.chips IS DISTINCT FROM`.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_chips(p_tournament_id uuid, p_updates jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RETURN 0;
  END IF;

  UPDATE public.tournament_players tp
     SET chips = floor(GREATEST(u.chips, 0))::integer
  FROM jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
  WHERE tp.tournament_id = p_tournament_id
    AND tp.user_id = u.user_id
    AND tp.status = 'playing'
    -- PERF 2026-08-25: skip rows whose chip count is already correct. Postgres
    -- does not elide a no-op UPDATE by itself, and every one of those wrote a
    -- heap tuple, a WAL record, index entries and a realtime decode for no
    -- change at all. IS DISTINCT FROM, not <>, so a NULL chips column still
    -- matches and gets written.
    AND tp.chips IS DISTINCT FROM floor(GREATEST(u.chips, 0))::integer;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ============================================================================
-- POST-APPLY ASSERTIONS (static only - this function writes tournament chip
-- stacks, so the assertions must never invoke it)
-- ============================================================================
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_sync_tournament_chips';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_sync_tournament_chips is missing';
  END IF;

  IF position('IS DISTINCT FROM' in v_src) = 0 THEN
    RAISE EXCEPTION 'the no-op skip predicate was not applied';
  END IF;

  -- The chip expression must be byte-identical to the previous version, or
  -- stacks would change value rather than merely being written less often.
  IF position('floor(GREATEST(u.chips, 0))::integer' in v_src) = 0 THEN
    RAISE EXCEPTION 'the chip value expression changed - stacks are at risk';
  END IF;

  -- The status guard must survive: eliminated players must never be rewritten.
  IF position('tp.status = ''playing''' in v_src) = 0 THEN
    RAISE EXCEPTION 'the status guard was lost';
  END IF;

  -- The tournament scope must survive.
  IF position('tp.tournament_id = p_tournament_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'the tournament scope was lost';
  END IF;
END $$;

