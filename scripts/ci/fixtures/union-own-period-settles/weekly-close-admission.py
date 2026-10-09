"""Native cron-command regression, using the same disposable PG17 cluster.

pg_cron is real but its launcher is disabled. We execute its stored command
ourselves with now()/clock_timestamp() bound to a controlled fixture clock.
The due callback records admission; in safety cases it invokes the captured
production scope coordinator and real gate helper, stopping before money.
This proves admission and refusal, not payment execution or wall-clock cron.
"""
import hashlib
import json
import re


def exercise(run, check, one, fixtures):
    captured = json.loads((fixtures / 'weekly-close-job.live-20261009.json').read_text())
    command_before = captured['job']['command']
    scope = (fixtures / 'fn_process_weekly_accounting_scope.live-20261009.sql').read_text()
    migration = one('*_the_weekly_close_starts_at_four_in_chicago.sql').read_text()
    scope_sig = 'public.fn_process_weekly_accounting_scope(uuid,uuid)'
    quote = lambda s: "'" + s.replace("'", "''") + "'"
    controlled = lambda s: s.replace('clock_timestamp()', 'public.ca_test_clock()').replace('now()', 'public.ca_test_clock()')
    union = 'fade0000-0000-0000-0000-000000000001'

    run("""
      CREATE EXTENSION pg_cron;
      CREATE FUNCTION public.ca_test_clock() RETURNS timestamptz LANGUAGE sql STABLE AS
        $$ SELECT current_setting('ca.test_now')::timestamptz $$;
      CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(current_setting('ca.test_frozen',true),'false')::boolean $$;
      CREATE TABLE public.unions(id uuid);
      CREATE TABLE public.clubs(id uuid, is_union boolean);
      CREATE TABLE public.union_pnl_inventory_checkpoints(boundary timestamptz);
      CREATE TABLE public.union_pnl_inventory_seal_layers(boundary timestamptz);
      CREATE TABLE public.weekly_accounting_scheduler_visits(last_outcome text,last_visit_at timestamptz);
      ALTER TABLE public.union_accounting_runs ADD COLUMN result jsonb, ADD COLUMN finished_at timestamptz;
      CREATE TABLE public.accounting_close_gates(scope_kind text,scope_id uuid,period_start timestamptz,
        period_end timestamptz,gate_until timestamptz,reason text,held_visits integer DEFAULT 0,
        first_held_at timestamptz,last_held_at timestamptz);
      CREATE TABLE public.financial_alerts(source text,severity text,message text,context jsonb);
      CREATE TABLE public.ca_test_admissions(result jsonb);
    """)
    run(f"INSERT INTO public.unions VALUES ('{union}');")
    helpers = (fixtures / 'weekly-close-admission-helpers.sql').read_text()
    run(controlled(helpers))
    run(scope + ';')
    live_hash = run(f"SELECT md5(pg_get_functiondef('{scope_sig}'::regprocedure))")
    check('scheduler-is-captured-production-preimage', live_hash == captured['scheduler_md5'], live_hash)
    # Time is the only substitution in the real owning coordinator.
    run(controlled(scope) + ';')
    run(f"""
      CREATE FUNCTION public.fn_union_settlement_cascade_due() RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE r jsonb;
      BEGIN
        IF current_setting('ca.test_mode')='scope' THEN
          r:=public.fn_process_weekly_accounting_scope('{union}',NULL);
        ELSE r:='{{"admitted":true}}'::jsonb; END IF;
        INSERT INTO public.ca_test_admissions VALUES(r);
        RETURN r;
      END $$;
      SELECT cron.schedule('union-weekly-rakeback-close','*/5 * * * *',{quote(command_before)});
      UPDATE cron.job SET jobid=272 WHERE jobname='union-weekly-rakeback-close';
      SELECT cron.schedule('fixture-unrelated','7 * * * *','SELECT 1');
    """)
    check('cron-launcher-disabled', run('SHOW cron.launch_active_jobs') == 'off')
    all_before = json.loads(run('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j'))
    check('cron-preimage-is-live-command',
          run('SELECT md5(command) FROM cron.job WHERE jobid=272') == captured['command_md5'])

    def tick(command, instant, *, progress=None, frozen=False, mode='admission', held=False, large=False):
        setup = f"""
          BEGIN;
          SET LOCAL ca.test_now={quote(instant)};
          SET LOCAL ca.test_mode={quote(mode)};
          SET LOCAL ca.test_frozen={quote(str(frozen).lower())};
          TRUNCATE public.union_accounting_runs, public.union_settlement_floor,
            public.union_pnl_inventory_checkpoints, public.union_pnl_inventory_seal_layers,
            public.weekly_accounting_scheduler_visits, public.accounting_close_gates,
            public.financial_alerts, public.ca_test_admissions;
        """
        if not large:
            setup += 'INSERT INTO public.union_pnl_inventory_checkpoints VALUES(public.fn_union_week_start(public.ca_test_clock()));'
        if progress in ('running', 'failed'):
            result = {'chunk_committed': True} if progress == 'running' else {'error': 'weekly_scope_time_budget_exhausted'}
            setup += f"INSERT INTO public.union_accounting_runs(status,result,finished_at) VALUES({quote(progress)},{quote(json.dumps(result))},public.ca_test_clock());"
        if progress == 'seal':
            setup += 'TRUNCATE public.union_pnl_inventory_checkpoints; INSERT INTO public.union_pnl_inventory_seal_layers VALUES(public.fn_union_week_start(public.ca_test_clock()));'
        if held or progress == 'gate-lifted':
            until = "public.ca_test_clock()+interval '1 hour'" if held else "public.ca_test_clock()-interval '1 minute'"
            setup += f"""INSERT INTO public.accounting_close_gates(scope_kind,scope_id,period_start,period_end,gate_until,reason)
              VALUES('union','{union}',public.fn_union_prev_week_start(public.ca_test_clock()),
                public.fn_union_week_start(public.ca_test_clock()),{until},'fixture gate');"""
        output = run(setup + controlled(command) + """
          SELECT jsonb_build_object('calls',(SELECT count(*) FROM public.ca_test_admissions),
            'receipts',(SELECT COALESCE(jsonb_agg(result),'[]'::jsonb) FROM public.ca_test_admissions),
            'runs',(SELECT count(*) FROM public.union_accounting_runs),
            'held_visits',(SELECT COALESCE(sum(held_visits),0) FROM public.accounting_close_gates),
            'warnings',(SELECT count(*) FROM public.financial_alerts WHERE severity='warning'),
            'attempt_budget',current_setting('app.weekly_accounting_attempt_budget'),
            'scope_budget',current_setting('app.weekly_accounting_scope_budget'),
            'statement_timeout',current_setting('statement_timeout'),
            'chunked',current_setting('app.weekly_accounting_chunked'));
          ROLLBACK;
        """).splitlines()
        return json.loads(output[-1])

    # UTC instants independently specify Chicago's spring/summer and winter offsets.
    cases = [
        ('dst-before-due', '2026-03-09 08:55:00+00', 0, 0),
        ('dst-four-am', '2026-03-09 09:00:00+00', 0, 1),
        ('dst-four-oh-five', '2026-03-09 09:05:00+00', 0, 1),
        ('standard-before-due', '2026-11-02 09:55:00+00', 0, 0),
        ('standard-four-am', '2026-11-02 10:00:00+00', 0, 1),
        ('standard-four-oh-five', '2026-11-02 10:05:00+00', 0, 1),
        ('next-monday-four-am', '2026-10-12 09:00:00+00', 0, 1),
        ('next-monday-four-thirty-five', '2026-10-12 09:35:00+00', 0, 1),
        ('existing-forty-minute-tick', '2026-10-12 09:40:00+00', 1, 1),
        ('monday-later-hour', '2026-10-12 10:05:00+00', 0, 0),
        ('tuesday-is-not-monday', '2026-10-13 09:05:00+00', 0, 0),
    ]
    for name, instant, baseline, _ in cases:
        receipt = tick(command_before, instant)
        check('baseline-' + name, receipt['calls'] == baseline, receipt)
    check('scheduler-migration-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    command_after = run('SELECT command FROM cron.job WHERE jobid=272')
    check('scheduler-postimage-is-exact', hashlib.md5(command_after.encode()).hexdigest() == captured['candidate_md5'])
    expected_jobs = all_before
    next(j for j in expected_jobs if j['jobid'] == 272)['command'] = command_after
    check('only-owned-cron-command-changed',
          json.loads(run('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j')) == expected_jobs)
    for name, instant, _, candidate in cases:
        receipt = tick(command_after, instant)
        check('candidate-' + name, receipt['calls'] == candidate, receipt)
        check('unchanged-budget-' + name,
              (receipt['attempt_budget'],receipt['scope_budget'],receipt['statement_timeout'],receipt['chunked'])
              == ('1','9 minutes','12min','on'), receipt)
    for progress in ('running', 'failed', 'gate-lifted', 'seal'):
        baseline = tick(command_before, '2026-10-13 09:05:00+00', progress=progress)
        candidate = tick(command_after, '2026-10-13 09:05:00+00', progress=progress)
        check('carry-forward-' + progress, baseline == candidate and candidate['calls'] == 1, candidate)
    receipt = tick(command_after, '2026-10-12 09:00:00+00', large=True)
    check('large-inventory-budget-unchanged',
          receipt['scope_budget']=='50 minutes' and receipt['statement_timeout']=='1h', receipt)
    receipt = tick(command_after, '2026-10-12 09:00:00+00', frozen=True, mode='scope')
    check('four-am-freeze-is-enforced-by-production-coordinator',
          receipt['calls']==1 and receipt['runs']==0 and receipt['receipts'][0].get('reason')=='maintenance_window', receipt)
    receipt = tick(command_after, '2026-10-12 09:05:00+00', held=True, mode='scope')
    check('thawed-four-oh-five-reaches-the-existing-held-week-gate',
          receipt['calls']==1 and receipt['runs']==0 and receipt['held_visits']==1 and receipt['warnings']==1
          and receipt['receipts'][0].get('checked')==0 and receipt['receipts'][0].get('failed')==0, receipt)
    receipt = tick(command_after, '2026-10-12 09:45:00+00', progress='running', mode='scope')
    check('carry-forward-maintenance-window-still-refuses',
          receipt['receipts'][0].get('reason')=='maintenance_window', receipt)
    try:
        run(migration)
    except RuntimeError as error:
        check('scheduler-migration-refuses-replay', 'not the pinned preimage' in str(error), str(error)[-250:])
    else:
        check('scheduler-migration-refuses-replay', False)
    check('replay-leaves-exact-job-postimage', run('SELECT command FROM cron.job WHERE jobid=272') == command_after)
