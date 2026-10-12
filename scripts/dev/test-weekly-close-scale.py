#!/usr/bin/env python3
"""Native qualification of the weekly-close-scale migration.

Loads the captured production tables and function bodies into a disposable
PostgreSQL 17 cluster, builds deterministic club weeks (clean and with one
broken fact each), and runs round 2, round 3 (each twice: first payment and
paid replay), the cash-commission gate and the weekly statement, first with
the production (preimage) functions and then after applying the migration
exactly as production will. Every return value, refusal (SQLSTATE and text),
ledger leg, wallet row, balance, settlement, payout, period, routed receipt
and statement must be identical. Then: the earned-plan memo, the deadline,
and a timing/page-touch comparison at scale.

  GEN_POSTIMAGE=1  apply without postimage checks and print the digests.
  TIMING_HANDS=N   hands in the timing book (default 40000; 0 skips timing).
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
root = Path(__file__).resolve().parents[2]
fx = root / 'tests/fixtures/weekly-close-scale'
sys.path.insert(0, str(fx))
from scenarios import SCENARIOS
pgbin = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
migration = Path(glob.glob(str(root / 'supabase/migrations/*_a_weekly_close_proves_each_book_once_and_never_holds_a_long_.sql'))[0])
work = Path(tempfile.mkdtemp(prefix='wcs.', dir=os.environ.get('TMPDIR', '/tmp')))
port = os.environ.get('PORT', '55561')
sock = work / 's'; sock.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env.update(LC_ALL='C', LANG='C', PGTZ='UTC')
started = False
def run(args, **kw):
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True, **kw)
def psql(sql=None, files=(), check=True, db='postgres'):
    args = [str(pgbin / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-h', str(sock), '-p', port, '-d', db]
    for f in files: args += ['-f', str(f)]
    r = subprocess.run(args, env=env, input=sql, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f'psql failed ({r.returncode}):\n{r.stderr[-3000:]}')
    return r
def stop():
    if started:
        subprocess.run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate', 'stop'], env=env, capture_output=True)
try:
    run([str(pgbin / 'initdb'), '-D', str(work / 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-l', str(work / 'server.log'), '-w', 'start',
         '-o', f"-k {sock} -p {port} -h '' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=256MB -c work_mem=20MB -c max_parallel_workers_per_gather=0"])
    started = True
    # preimage bodies end without a statement terminator
    pre_sql = work / 'preimages.sql'
    with pre_sql.open('w') as f:
        f.write('SET check_function_bodies=off;\n')
        for p in sorted((fx / 'preimage').glob('*.sql')):
            f.write(p.read_text().rstrip('\n') + ';\n')
    psql(files=[fx / 'prelude.sql', fx / 'schema-tables.sql', pre_sql, fx / 'stubs.sql', fx / 'generator.sql', fx / 'runner.sql'])

    def scenario_outputs(tag):
        outs = {}
        for name, kind, players, hands, union, mutation in SCENARIOS:
            o = work / f'{tag}-{name}.txt'
            script = (f"ALTER SEQUENCE public.wcs_seq RESTART;\nALTER TABLE public.accounting_rakeback_period_calculations ALTER COLUMN id RESTART WITH 1;\nBEGIN;\nSELECT public.wcs_generate({players},{hands},{'true' if union else 'false'});\n{mutation}\n"
                      f"SELECT public.wcs_run('{kind}');\n\\o {o}\n\\i {fx / 'digest.sql'}\n\\o\nROLLBACK;\n")
            psql(script)
            outs[name] = o.read_text()
        return outs

    t0 = time.time()
    old = scenario_outputs('old')
    print(f'original functions: {len(old)} scenarios in {time.time()-t0:.1f}s')

    # production earned plan back in place, then the migration as production applies it
    psql(files=[fx / 'preimage' / 'fn_accounting_union_earned_plan.sql'], sql=None) if False else None
    psql((fx / 'preimage' / 'fn_accounting_union_earned_plan.sql').read_text().rstrip('\n') + ';\n')
    mig = migration.read_text()
    if os.environ.get('GEN_POSTIMAGE') == '1':
        mig = re.sub(r"DO \$post\$.*?END \$post\$;\n", '', mig, flags=re.S)
    (work / 'migration.sql').write_text(mig)
    psql(files=[work / 'migration.sql'])
    sigs = ['fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)',
            'fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)',
            'fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)',
            'fn_club_weekly_accounting_summary(uuid)',
            'fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)',
            'fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)',
            'fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)',
            'fn_process_weekly_accounting_scope(uuid,uuid)',
            'fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',
            'fn_weekly_accounting_attempt_begin(boolean)', 'fn_weekly_accounting_deadline_check()', 'fn_weekly_accounting_attempt_end()']
    digests = {}
    for s in sigs:
        r = psql(f"\\pset tuples_only on\n\\pset format unaligned\nSELECT md5(pg_get_functiondef('public.{s}'::regprocedure));\n")
        digests[s] = r.stdout.strip()
    if os.environ.get('GEN_POSTIMAGE') == '1':
        print(json.dumps(digests, indent=1)); sys.exit(0)
    print('migration applied with its preimage and postimage checks')
    # the v3 earned plan proves bank rows this harness does not model: count its proofs instead
    psql("CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_v3(p_union_id uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb "
         "LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO public.wcs_calls(fn) VALUES('earned_plan'); "
         "RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'basis_detail','[]'::jsonb); END $$;")
    t0 = time.time()
    new = scenario_outputs('new')
    print(f'changed functions: {len(new)} scenarios in {time.time()-t0:.1f}s')
    failed = 0
    for name in old:
        if old[name] != new[name]:
            failed += 1
            print(f'FAIL {name}: outputs differ')
            subprocess.run(['diff', str(work / f'old-{name}.txt'), str(work / f'new-{name}.txt')])
        else:
            steps = [l.split('|') for l in old[name].splitlines() if l.startswith('OUT|')]
            def show(s):
                if s[3] != 't': return f"{s[2]}={s[5]}"
                if s[2] == 'statement':
                    j = json.loads(s[6]); return f"statement=ok(issues={j['source_issue_count']},burned={j['private_rake_burned']},ready={j['ready_to_issue']})"
                return f"{s[2]}=ok"
            summary = ', '.join(show(s) for s in steps)
            print(f'PASS {name}: identical ({len(old[name].splitlines())} lines; {summary})')
    if failed:
        raise SystemExit(f'{failed} scenario(s) differ; work dir kept at {work}')

    # memo: inside a close attempt the earned plan is proved once; outside, every call
    r = psql("\\pset tuples_only on\n\\pset format unaligned\nBEGIN;\nTRUNCATE public.wcs_calls;\n"
             "SELECT public.fn_accounting_union_earned_plan(wcs_u('union'),'2026-08-31 07:00+00','2026-09-07 07:00+00') FROM generate_series(1,3);\n"
             "SELECT 'outside='||count(*) FROM public.wcs_calls;\nTRUNCATE public.wcs_calls;\n"
             "SELECT public.fn_weekly_accounting_attempt_begin(true);\n"
             "SELECT public.fn_accounting_union_earned_plan(wcs_u('union'),'2026-08-31 07:00+00','2026-09-07 07:00+00') FROM generate_series(1,3);\n"
             "SELECT public.fn_accounting_union_earned_plan(wcs_u('union'),'2026-09-07 07:00+00','2026-09-14 07:00+00');\n"
             "SELECT 'inside='||count(*) FROM public.wcs_calls;\nSELECT public.fn_weekly_accounting_attempt_end();\nTRUNCATE public.wcs_calls;\n"
             "SELECT public.fn_accounting_union_earned_plan(wcs_u('union'),'2026-08-31 07:00+00','2026-09-07 07:00+00');\n"
             "SELECT 'after_end='||count(*) FROM public.wcs_calls;\nROLLBACK;\n")
    got = [l for l in r.stdout.split() if '=' in l]
    print('memo proofs:', got)
    if got != ['outside=3', 'inside=2', 'after_end=1']:
        raise SystemExit('FAIL memo')
    # deadline: no-op without an attempt; raises past it; attempt_end clears it
    r = psql("\\pset tuples_only on\n\\pset format unaligned\nBEGIN;\nSELECT public.fn_weekly_accounting_deadline_check();\n"
             "SET LOCAL app.weekly_accounting_scope_budget='0 seconds';\nSELECT public.fn_weekly_accounting_attempt_begin(false);\n"
             "DO $$ BEGIN PERFORM public.fn_weekly_accounting_deadline_check(); RAISE NOTICE 'NOT RAISED'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'raised:%', SQLERRM; END $$;\n"
             "SELECT public.fn_weekly_accounting_attempt_end();\nSELECT public.fn_weekly_accounting_deadline_check();\nROLLBACK;\n")
    if 'raised:weekly_scope_time_budget_exhausted' not in r.stderr or 'NOT RAISED' in r.stderr:
        raise SystemExit('FAIL deadline: ' + r.stderr)
    print('deadline: silent outside an attempt, raises weekly_scope_time_budget_exhausted past it, cleared by attempt_end')
    # the coordinator carries the checks
    r = psql("\\pset tuples_only on\n\\pset format unaligned\nSELECT (length(d)-length(replace(d,'fn_weekly_accounting_deadline_check','')))/length('fn_weekly_accounting_deadline_check'),"
             "(length(d)-length(replace(d,'fn_weekly_accounting_attempt_begin','')))/length('fn_weekly_accounting_attempt_begin') FROM (SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) d) x;\n")
    print('coordinator deadline checks / attempt begins:', r.stdout.strip())

    hands = int(os.environ.get('TIMING_HANDS', '40000'))
    if hands:
        timing = fx / 'timing.sql'
        psql(f"SELECT public.wcs_generate(380,{hands},false,40);\nANALYZE;\n")
        def timed(tag):
            r = psql(f"\\set tag {tag}\n" + timing.read_text())
            return r.stdout + r.stderr
        new_t = timed('changed')
        # the preimage functions back in place for the same book
        for n in ['fn_settle_accounting_commission_stage', 'fn_settle_accounting_rakeback_stage', 'fn_club_weekly_accounting_summary', 'fn_assert_cash_commission_period']:
            psql((fx / 'preimage' / f'{n}.sql').read_text().rstrip('\n') + ';\n')
        old_t = timed('original')
        print(new_t); print(old_t)
    print('GREEN OK')
    shutil.rmtree(work, ignore_errors=True) if False else None
finally:
    stop()
    if os.environ.get('KEEP') != '1':
        shutil.rmtree(work, ignore_errors=True)
