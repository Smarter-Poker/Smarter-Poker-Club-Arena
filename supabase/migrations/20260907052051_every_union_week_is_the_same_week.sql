-- EVERY UNION WEEK IS THE SAME WEEK
-- =============================================================================
-- 20260907044041 moved the SETTLEMENT to midnight America/Los_Angeles and left
-- thirteen other union, agent and rake functions computing the week in UTC.
-- That is a half-finished change: the settlement closes Aug 31 07:00 to Sep 7
-- 07:00 while the operator preview, the agent statements and the risk reports
-- all describe Aug 31 00:00 to Sep 7 00:00. Same nouns, different seven hours.
--
-- Two of them were worse than cosmetic:
--
--   fn_union_settlement_preview mirrors rounds 2 and 3 exactly and is what an
--   operator reads BEFORE approving a settlement. It was previewing a period
--   the cascade would not settle.
--
--   fn_execute_union_rakeback VALIDATES that its period is week-aligned with
--     p_period_start <> date_trunc('week', p_period_start)  ->  refuse
--   In UTC that guard REFUSES a Pacific period outright. Verified:
--     '2026-08-31 07:00+00' = date_trunc('week', '2026-08-31 07:00+00')  ->  false
--   It has no database caller, no cron caller and no caller in either repo,
--   but it is granted to authenticated, so it was a loaded gun aimed at the
--   next person to call it with a real period.
--
-- HOW THIS IS APPLIED. Thirteen function bodies are not retyped - several are
-- money functions of 3-5 KB and a transcription slip in one would be silent.
-- Each definition is read back with pg_get_functiondef and the exact substrings
-- are replaced, longest pattern first, then re-executed. The only thing that
-- can change is the text being swapped. All of it in ONE transaction, so
-- pgrst_ddl_watch coalesces to a single schema reload (production DDL policy).
--
-- DELIBERATELY NOT TOUCHED:
--
--   fn_rakeback_recompute_all_clubs runs at 06:45, BEFORE the 07:00 boundary,
--   where fn_union_week_start(now()) still returns LAST week. Swapping the
--   helper in there would have made it recompute 2026-08-24 instead of
--   2026-08-31. Its UTC arithmetic already yields the correct window, so it
--   keeps it. Checked, not assumed.
--
--   trg_union_rake_weekly and fn_union_rake_weekly_verify bucket
--   union_rake_weekly by UTC week. They agree with each other, the table is a
--   display rollup whose own trigger comment says the fallback reads the
--   ledger, and moving them needs the existing rows rebucketed in the same
--   change. Left consistent, and recorded as the next piece of work.
--
--   rakeback_periods are UTC-DATE buckets, so a Pacific week cannot align to
--   them exactly. Round 3 claims rows with
--     period_start >= p_period_start::date AND < p_period_end::date + 1
--   which is eight date-buckets for a seven-day week. That is pre-existing and
--   unchanged by the boundary move, it cannot double-pay because the status
--   flips pending -> paid, and the steady state is seven days per week. The
--   off-by-one and the granularity mismatch are both recorded rather than
--   changed at 05:30 on the morning the invoices go out.
-- =============================================================================

BEGIN;

DO $migrate$
DECLARE
  r        record;
  newdef   text;
  v_changed int := 0;
  v_seen    int := 0;
  targets  text[] := ARRAY[
    'fn_agent_downline_rake',
    'fn_agent_downline_rake_summary',
    'fn_agent_roster_report',
    'fn_agent_weekly_statement',
    'fn_union_agent_risk_report',
    'fn_union_club_exit_blockers',
    'fn_union_distribution_check',
    'fn_union_money_report',
    'fn_union_treasury_selftest',
    'fn_union_weekly_agent_statements',
    'fn_union_settlement_preview',
    'fn_union_weekly_rakeback_close_all',
    'fn_execute_union_rakeback'
  ];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proname = ANY(targets)
     ORDER BY p.proname
  LOOP
    v_seen := v_seen + 1;
    newdef := r.def;

    -- Longest patterns first, so a shorter one cannot eat part of a longer one.
    newdef := replace(newdef, 'date_trunc(''week'', now()) - interval ''7 days''',
                              'public.fn_union_prev_week_start(now())');
    newdef := replace(newdef, 'date_trunc(''week'', v_cursor + interval ''6 days'')',
                              'public.fn_union_week_start(v_cursor + interval ''6 days'')');
    newdef := replace(newdef, 'date_trunc(''week'', p_period_start)',
                              'public.fn_union_week_start(p_period_start)');
    newdef := replace(newdef, 'date_trunc(''week'', p_period_end)',
                              'public.fn_union_week_start(p_period_end)');
    newdef := replace(newdef, 'date_trunc(''week'', v_cursor)',
                              'public.fn_union_week_start(v_cursor)');
    newdef := replace(newdef, 'date_trunc(''week'', now())',
                              'public.fn_union_week_start(now())');

    IF newdef IS DISTINCT FROM r.def THEN
      EXECUTE newdef;
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  IF v_seen <> array_length(targets, 1) THEN
    RAISE EXCEPTION 'expected % target functions, found %', array_length(targets, 1), v_seen;
  END IF;
  IF v_changed <> v_seen THEN
    RAISE EXCEPTION 'only % of % target functions changed; one of them did not match a pattern',
      v_changed, v_seen;
  END IF;
END
$migrate$;

-- ASSERTIONS -----------------------------------------------------------------

DO $assert$
DECLARE
  v_left    text;
  v_preview jsonb;
BEGIN
  -- Nothing in the union/agent/rake domain may still truncate the week in UTC,
  -- with the two documented exceptions above.
  SELECT string_agg(p.proname, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc LIKE '%date_trunc(''week'', now())%'
     AND (p.proname LIKE '%union%' OR p.proname LIKE '%agent%' OR p.proname LIKE '%rake%')
     AND p.proname NOT IN ('fn_rakeback_recompute_all_clubs');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'still computing the union week in UTC: %', v_left;
  END IF;

  -- The guard that would have refused a Pacific period must now accept one.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_execute_union_rakeback'
                AND p.prosrc LIKE '%date_trunc(''week'', p_period_%') THEN
    RAISE EXCEPTION 'fn_execute_union_rakeback still validates week alignment in UTC';
  END IF;

  -- END TO END: the operator preview must describe exactly the period the
  -- cascade would settle. This is the wiring, not the text.
  v_preview := public.fn_union_settlement_preview('fade0000-0000-0000-0000-000000000001'::uuid);
  IF (v_preview->>'period_start')::timestamptz <> public.fn_union_prev_week_start(now())
     OR (v_preview->>'period_end')::timestamptz <> public.fn_union_week_start(now()) THEN
    RAISE EXCEPTION 'preview period % to % does not match the cascade period % to %',
      v_preview->>'period_start', v_preview->>'period_end',
      public.fn_union_prev_week_start(now()), public.fn_union_week_start(now());
  END IF;
END
$assert$;

COMMIT;
