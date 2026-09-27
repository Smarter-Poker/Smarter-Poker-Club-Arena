-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233134 "rakeback_settler_batch_credit_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 21174e562d1dba4d20efef60deae97ee of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SETTLER THROUGHPUT (2026-08-19, measured) — the daemon was LOSING GROUND.
--
-- Measured over a 56-minute window on production: the durable cursor advanced
-- 14.1 minutes of history while 56 minutes of new history arrived, and the
-- backlog GREW from 286,049 to 287,786 rows. It was never going to catch up;
-- an earlier estimate that it would converge on its own was wrong.
--
-- The cause is not the database. Each page of rake_records issues ONE HTTP
-- round trip PER PLAYER PER HAND — twice over, once for
-- credit_agent_commission_from_rake and once for apply_rakeback_player_stats.
-- A 2,000-row page at ~6 dealt-in players is ~24,000 sequential PostgREST
-- calls; measured throughput was ~6 calls/sec, i.e. over an hour of pure
-- network latency per page while the actual SQL is trivial.
--
-- These two functions take the whole page as a jsonb array and loop
-- server-side, so a page costs a handful of round trips instead of 24,000.
-- Semantics are IDENTICAL: each element calls exactly the same underlying
-- function, which is idempotent (agent commissions dedupe on
-- (user_id, source_id, source_type); player stats claim through
-- rakeback_stats_applied). Each element is wrapped in its own exception block
-- so one bad row cannot abort the batch — matching the per-call error
-- isolation the client loop had.

CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  it jsonb;
  v_ok integer := 0;
  v_failed integer := 0;
  v_first_error text := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', 0, 'failed', 0, 'error', 'p_items must be a jsonb array');
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      PERFORM public.credit_agent_commission_from_rake(
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        COALESCE((it->>'rake_credit')::numeric, 0),
        it->>'source_type',
        NULLIF(it->>'source_id', '')::uuid,
        it->>'notes'
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_error IS NULL THEN v_first_error := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed, 'first_error', v_first_error);
END $$;

CREATE OR REPLACE FUNCTION public.fn_apply_rakeback_player_stats_batch(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  it jsonb;
  v_ok integer := 0;
  v_failed integer := 0;
  v_first_error text := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', 0, 'failed', 0, 'error', 'p_items must be a jsonb array');
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      PERFORM public.apply_rakeback_player_stats(
        (it->>'rake_record_id')::uuid,
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        COALESCE((it->>'hands')::integer, 1),
        COALESCE((it->>'rake')::numeric, 0)
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_error IS NULL THEN v_first_error := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed, 'first_error', v_first_error);
END $$;

REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) TO service_role;
