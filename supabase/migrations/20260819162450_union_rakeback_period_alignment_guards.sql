-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162450 "union_rakeback_period_alignment_guards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 68604675c107c4c37c06f9f67e961b98 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Guard rails for period alignment:
--  1. Manual (owner) closes must be exact ISO weeks — prevents a mid-week
--     manual period from overlapping the automated Monday cadence (the
--     idempotency log only dedupes EXACT period matches, so an overlapping
--     ad-hoc period could double-pay days already settled).
--  2. close_all's resume cursor jumps to the Monday ON/AFTER the last executed
--     period_end — if a legacy/misaligned period ever exists, we skip forward
--     rather than re-covering paid days.

CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner  uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM unions WHERE id = p_union_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_not_found');
  END IF;
  IF v_caller IS NULL OR v_caller <> v_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start <> date_trunc('week', p_period_start)
     OR p_period_end   <> date_trunc('week', p_period_end)
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_must_be_iso_weeks',
      'hint', 'start and end must both be Monday 00:00 UTC');
  END IF;
  RETURN public.fn_union_weekly_rakeback_close(p_union_id, p_period_start, p_period_end);
END $$;

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close_all(
  p_union_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_union        record;
  v_cursor       timestamptz;
  v_current_week timestamptz := date_trunc('week', now());
  v_result       jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_guard        integer;
BEGIN
  FOR v_union IN
    SELECT id FROM unions WHERE p_union_id IS NULL OR id = p_union_id
  LOOP
    SELECT MAX(period_end) INTO v_cursor
      FROM union_rakeback_log WHERE union_id = v_union.id;
    IF v_cursor IS NULL THEN
      SELECT MIN(created_at) INTO v_cursor
        FROM union_wallet_transactions
       WHERE union_id = v_union.id
         AND wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake';
      IF v_cursor IS NULL THEN CONTINUE; END IF;
      v_cursor := date_trunc('week', v_cursor);
    ELSE
      -- Monday ON or AFTER the last executed period_end (aligned stays put;
      -- a misaligned legacy period skips forward, never re-covering paid days).
      IF v_cursor <> date_trunc('week', v_cursor) THEN
        v_cursor := date_trunc('week', v_cursor + interval '6 days');
      END IF;
    END IF;

    v_guard := 0;
    WHILE v_cursor + interval '7 days' <= v_current_week AND v_guard < 60 LOOP
      v_result := fn_union_weekly_rakeback_close(
        v_union.id, v_cursor, v_cursor + interval '7 days');
      IF COALESCE(v_result->>'error', '') NOT IN ('', 'already_executed') THEN
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
        EXIT;
      END IF;
      IF (v_result->>'success')::boolean IS TRUE THEN
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
      END IF;
      v_cursor := v_cursor + interval '7 days';
      v_guard := v_guard + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'closes', v_results);
END $$;
