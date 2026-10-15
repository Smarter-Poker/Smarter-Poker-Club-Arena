CREATE OR REPLACE FUNCTION public.fn_settler_lag_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- RakebackSettlerService.SETTLEMENT_INTERVAL_MS is 30 minutes. The grace is
  -- one whole interval plus the :53-to-:00 maintenance freeze, so a healthy
  -- cycle - including one that correctly waited out a freeze - is never an
  -- incident, and a cycle that was actually SKIPPED always is.
  c_interval_m constant numeric  := 30;
  c_grace_m    constant numeric  := 45;
  -- The union week closes at fn_union_week_start(now()) and the cascade cron
  -- (job 272, `0,30 * * * *`) then attempts it. Allow one settler interval past
  -- the boundary before calling the week blocked, so the drain gets a fair
  -- chance to accrue the final hands of the week first.
  c_week_grace constant interval := interval '30 minutes';
  v_cursor     timestamptz;
  v_cursor_id  uuid;
  v_saved      timestamptz;
  v_lag_h      numeric;
  v_stale_m    numeric;
  v_backlog    bigint;
  v_week_to    timestamptz;
  v_week_from  timestamptz;
  v_unaccrued  bigint := 0;
  v_blocked    boolean := false;
  v_stalled    boolean;
BEGIN
  SELECT high_water_mark, high_water_mark_id, updated_at
    INTO v_cursor, v_cursor_id, v_saved
    FROM daemon_state
   WHERE daemon = 'rakeback_settler';

  IF v_cursor IS NULL THEN
    -- A genuine first run has no cursor. That is not a stall.
    RETURN jsonb_build_object('healthy', true, 'note', 'no settler cursor yet');
  END IF;

  v_lag_h   := round(EXTRACT(epoch FROM (now() - v_cursor)) / 3600.0, 2);
  v_stale_m := round(EXTRACT(epoch FROM (now() - v_saved)) / 60.0, 1);

  -- Bounded on purpose: the verdict needs to know that backlog exists and
  -- roughly how much, never the exact depth of a days-old hole.
  SELECT count(*) INTO v_backlog
    FROM (SELECT 1 FROM rake_records WHERE created_at > v_cursor LIMIT 5000) s;

  v_week_to   := public.fn_union_week_start(now());
  v_week_from := v_week_to - interval '7 days';

  IF now() >= v_week_to + c_week_grace THEN
    -- The same predicate fn_process_weekly_accounting_scope gates on, minus its
    -- per-union club scoping: if ANY cash rake inside the closed week is still
    -- above the cursor then at least one union raises
    -- weekly_rake_source_not_fully_accrued and the cascade settles nothing.
    SELECT count(*) INTO v_unaccrued
      FROM (SELECT 1
              FROM rake_records rr
             WHERE NOT COALESCE(rr.is_tournament, false)
               AND rr.tournament_id IS NULL
               AND rr.rake_amount > 0
               AND rr.created_at >= v_week_from
               AND rr.created_at <  v_week_to
               AND (rr.created_at > v_cursor
                    OR (rr.created_at = v_cursor
                        AND (v_cursor_id IS NULL OR rr.id > v_cursor_id)))
             LIMIT 5000) w;
    v_blocked := v_unaccrued > 0;
  END IF;

  -- A stall is a cursor that has not moved for materially longer than one
  -- interval WHILE there is work above it. Either half alone is ordinary: an
  -- idle table gives the settler nothing to save, and a fresh backlog just
  -- means the drain is mid-cycle.
  v_stalled := (v_stale_m > c_grace_m AND v_backlog > 0);

  RETURN jsonb_build_object(
    'healthy',                 NOT (v_stalled OR v_blocked OR v_lag_h > 6),
    'cursor',                  v_cursor,
    'lag_hours',               v_lag_h,
    'last_save_hours_ago',     round(v_stale_m / 60.0, 2),
    'last_save_minutes_ago',   v_stale_m,
    'backlog_rows',            v_backlog,
    'interval_minutes',        c_interval_m,
    'stall_grace_minutes',     c_grace_m,
    'stalled',                 v_stalled,
    'week_from',               v_week_from,
    'week_to',                 v_week_to,
    'week_unaccrued_rows',     v_unaccrued,
    'week_settlement_blocked', v_blocked);
END $function$
