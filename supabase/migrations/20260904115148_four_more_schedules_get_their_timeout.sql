-- Four more schedules ask for more than the postgres role's 2-minute cap by
-- calling set_config('statement_timeout', ...) INSIDE the statement, which
-- cannot extend a deadline that is already armed (lesson 3, 2026-09-03).
-- Each has died to the cap this week (ca-payout-sweep-hourly 11 of 87 runs,
-- the two tournament sweeps on 2026-09-02). Same treatment as the weekly
-- union jobs: the intended timeout becomes a leading statement of its own,
-- the command is otherwise untouched.
DO $$
DECLARE r record; v_to text; v_cmd text; v_n int := 0;
BEGIN
  FOR r IN SELECT jobname, schedule, command FROM cron.job
            WHERE jobname IN ('ca-payout-sweep-hourly', 'reconcile-club-member-daily-profit',
                              'tourney_money_conservation_deep_daily', 'tourney_payout_sweep_detect_daily')
              AND command NOT LIKE 'SET statement_timeout%' LOOP
    v_to := substring(r.command FROM 'set_config\(''statement_timeout'',''([0-9]+s)''');
    IF v_to IS NULL THEN
      RAISE EXCEPTION '% does not carry an inner statement_timeout this migration expected: %', r.jobname, r.command;
    END IF;
    v_cmd := 'SET statement_timeout = ''' || v_to || ''';' || r.command;
    PERFORM cron.unschedule(r.jobname);
    PERFORM cron.schedule(r.jobname, r.schedule, v_cmd);
    v_n := v_n + 1;
  END LOOP;
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('ca-payout-sweep-hourly', 'reconcile-club-member-daily-profit',
        'tourney_money_conservation_deep_daily', 'tourney_payout_sweep_detect_daily')
        AND command LIKE 'SET statement_timeout = ''%s'';%') <> 4 THEN
    RAISE EXCEPTION 'not all four jobs are wrapped';
  END IF;
  RAISE NOTICE 'wrapped % job(s)', v_n;
END $$;
