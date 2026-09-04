-- The two weekly union jobs set their statement_timeout INSIDE the statement
-- (set_config('statement_timeout','600s',true) ... and public.fn_...()). A
-- statement's deadline is armed when it begins and cannot be extended from
-- within it (lesson 3, 2026-09-03 handoff), so both actually run under the
-- postgres role's 2-minute cap. union-weekly-rakeback-recompute already died
-- to it on 2026-08-30 23:40 (fn_allocate_rake_credits, statement timeout).
-- The close that follows at 00:10 Monday - the first real one is 2026-09-07,
-- after the settlement floor - would take the same risk with a week of rake.
-- The SET becomes its own leading statement; the commands are otherwise the
-- ones that were scheduled, wrapped, not rewritten.
DO $$
DECLARE r record; v_cmd text;
BEGIN
  FOR r IN SELECT jobname, schedule, command FROM cron.job
            WHERE jobname IN ('union-weekly-rakeback-close', 'union-weekly-rakeback-recompute') LOOP
    IF position('set_config(''statement_timeout'',''600s'',true)' IN r.command) = 0 THEN
      RAISE EXCEPTION '% is not the command this migration expected: %', r.jobname, r.command;
    END IF;
    IF r.command LIKE 'SET statement_timeout%' THEN
      CONTINUE; -- already wrapped
    END IF;
    v_cmd := 'SET statement_timeout = ''600s'';' || r.command;
    PERFORM cron.unschedule(r.jobname);
    PERFORM cron.schedule(r.jobname, r.schedule, v_cmd);
  END LOOP;
  IF to_regprocedure('public.fn_union_settlement_cascade_all(timestamptz, timestamptz)') IS NULL
     OR to_regprocedure('public.fn_rakeback_recompute_all_clubs(date, date)') IS NULL THEN
    RAISE EXCEPTION 'a scheduled function does not resolve';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('union-weekly-rakeback-close','union-weekly-rakeback-recompute') AND command LIKE 'SET statement_timeout = ''600s'';%') <> 2 THEN
    RAISE EXCEPTION 'the two weekly jobs are not both wrapped';
  END IF;
END $$;
