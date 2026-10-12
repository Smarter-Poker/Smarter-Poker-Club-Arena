#!/usr/bin/env python3
"""Native qualification of the union P&L evidence migration.

Loads production's function bodies (md5-checked against production) and table
shapes into a disposable PostgreSQL 17 cluster, generates randomized union
books (tests/fixtures/union-pnl-evidence-fast/gen.py: ready, blocked,
resolved and stale-resolved hands, every flow kind, open seats, pending
add-ons, open tournaments with every entry/credit/refund shape, clean books
that certify), and digests every read path (evidence report for this union,
another union, a pre-capture week and an open week; both boundaries; close
quality; qualified clubs; and the same inside one close attempt) first with
the production functions, then after applying the migration file exactly as
production will. Every value and every refusal must be identical. Then: the
memo (one report per union per attempt), the partial indexes are provable
from the new queries, a red control (a deliberately wrong body must be
caught), and old-vs-new timing on a larger book.

  SEEDS=N         randomized books (default 40) plus 6 clean ones
  TIMING_SCALE=S  scale of the timing book (default 12; 0 skips timing)
  GEN_POSTIMAGE=1 apply without postimage checks and print the digests
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
root = Path(__file__).resolve().parents[2]
fx = root / 'tests/fixtures/union-pnl-evidence-fast'
sys.path.insert(0, str(fx))
pgbin = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
migration = Path(glob.glob(str(root / 'supabase/migrations/*_a_union_close_proves_its_pnl_evidence_once_and_fast.sql'))[0])
work = Path(tempfile.mkdtemp(prefix='upe.', dir=os.environ.get('TMPDIR', '/tmp')))
port = os.environ.get('PORT', '55573')
sock = work / 's'; sock.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env.update(LC_ALL='C', LANG='C', PGTZ='UTC')
started = False
PROD = {  # md5(pg_get_functiondef) in production, 2026-09-28
 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)': 'e42a295828a8d21d5be083c6a7ae4a15',
 'fn_union_pnl_boundary(uuid,timestamp with time zone)': 'be154af9a391203d46ae54e5c318141f',
 'fn_union_pnl_close_quality(uuid,timestamp with time zone,timestamp with time zone)': '8b5551d177b27bcbd211b8ecd9ee3a11',
 'fn_union_pnl_qualified_clubs(uuid,timestamp with time zone,timestamp with time zone)': '2fed6a15cdb5186d19e3cee731b8d804',
 'fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)': '7e443fd75f3b1ece7cd0713a6b8fc0a5',
 'fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)': '5c4d8cb079d19fe08536afd7067b7617',
 'fn_union_pnl_tournament_returns(uuid,uuid,timestamp with time zone,timestamp with time zone)': '065c90de9bd14ae893dcb96bff0a3be1',
 'fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)': 'b49d259721d3eb9c1d8ba7061fd28b7e',
 'fn_pnl_evidence_cents(jsonb)': '8d712bd799c3dfa691f2d8d9ff5101e8',
 'fn_union_week_start(timestamp with time zone)': '103f192a228084dad0e4268c36c82c4b',
 'fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)': '409eade1f18decea288db84784f127b2',
 'fn_weekly_accounting_attempt_begin(boolean)': '96e8c69092908fbe9526963e9012b3e0',
 'fn_weekly_accounting_attempt_end()': 'b7d27aa978a1b8db3a98921d6af82588',
 'fn_union_pnl_inventory_observe()': '11c7c788d943a11375a15819e78873ba',
 'fn_union_pnl_original_frame()': '9a6559774cc1ed4ed49b315a3428abdb',
}
CHANGED = ['fn_union_pnl_evidence_report', 'fn_union_pnl_boundary', 'fn_weekly_accounting_attempt_begin', 'fn_weekly_accounting_attempt_end']
DATA = ['cash_funding_application_receipts', 'cash_hand_provenance_receipts', 'cash_participant_funding_receipts', 'tournament_accounting_credit_receipts',
        'tournament_participant_funding_receipts', 'tournament_refund_tranches', 'union_pnl_cash_outcome_resolutions', 'union_pnl_cash_outcomes',
        'union_pnl_inventory_capture', 'union_pnl_inventory_events', 'union_pnl_original_flows', 'union_pnl_transaction_frames', 'union_pnl_weekly_capture',
        'accounting_payable_earning_sources', 'hx_inventory', 'hx_lineage', 'hx_eco', 'hx_rake_basis', 'hx_meta']
IDX = re.findall(r'CREATE INDEX IF NOT EXISTS (\w+)', (fx / 'indexes.sql').read_text())
def run(args, **kw): return subprocess.run(args, env=env, check=True, capture_output=True, text=True, **kw)
def psql(sql=None, files=(), check=True):
    args = [str(pgbin / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-h', str(sock), '-p', port, '-d', 'postgres', '-At']
    for f in files: args += ['-f', str(f)]
    r = subprocess.run(args, env=env, input=sql, capture_output=True, text=True)
    if check and r.returncode != 0: raise SystemExit(f'psql failed ({r.returncode}):\n{r.stderr[-3000:]}')
    return r
def pre(name): return (fx / 'preimage' / f'{name}.sql').read_text().rstrip('\n').replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 1) + ';\n'
def restore_old():
    psql(''.join(pre(n) for n in CHANGED) + ''.join(f'DROP INDEX IF EXISTS public.{i};\n' for i in IDX))
def apply_migration(check_post=True):
    mig = migration.read_text()
    if not check_post: mig = re.sub(r"DO \$post\$.*?END \$post\$;\n", '', mig, flags=re.S)
    (work / 'migration.sql').write_text(mig)
    psql(files=[work / 'migration.sql'])
def load_book(seed, scale, clean=False):
    psql('TRUNCATE ' + ','.join('public.' + t for t in DATA) + ';\n')
    g = work / 'book.sql'
    with g.open('w') as f:
        subprocess.run([sys.executable, str(fx / 'gen.py'), str(seed), str(scale)] + (['clean'] if clean else []), stdout=f, check=True)
    psql(files=[g]); psql('ANALYZE;')
def digest(tag, name):
    r = psql("SELECT label||'|'||digest||'|'||bytes FROM public.hx_digest();\n")
    full = psql("SELECT label||E'\\t'||body FROM public.hx_digest();\n").stdout
    (work / f'{tag}-{name}.txt').write_text(full)
    return r.stdout.strip().splitlines()
try:
    run([str(pgbin / 'initdb'), '-D', str(work / 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-l', str(work / 'server.log'), '-w', 'start',
         '-o', f"-k {sock} -p {port} -h '' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=128MB -c work_mem=16MB -c max_parallel_workers_per_gather=0"])
    started = True
    pre_sql = work / 'preimages.sql'
    pre_sql.write_text(''.join(pre(p.stem) for p in sorted((fx / 'preimage').glob('*.sql'))))
    psql(files=[fx / 'prelude.sql', fx / 'schema-tables.sql', fx / 'stubs.sql', pre_sql, fx / 'runner.sql'])
    bad = []
    for sig, h in PROD.items():
        got = psql(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure));").stdout.strip()
        if got != h: bad.append(f'{sig}: {got} != production {h}')
    if bad: raise SystemExit('preimage bodies do not match production:\n' + '\n'.join(bad))
    print(f'{len(PROD)} production bodies loaded, every md5(pg_get_functiondef) equals production')

    if os.environ.get('GEN_POSTIMAGE') == '1':
        apply_migration(check_post=False)
        d = {}
        for s in ['fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)', 'fn_union_pnl_boundary(uuid,timestamp with time zone)',
                  'fn_weekly_accounting_attempt_begin(boolean)', 'fn_weekly_accounting_attempt_end()']:
            d[s] = psql(f"SELECT md5(pg_get_functiondef('public.{s}'::regprocedure));").stdout.strip()
        print(json.dumps(d, indent=1)); sys.exit(0)

    seeds = [(s, 1, False) for s in range(1, int(os.environ.get('SEEDS', '40')) + 1)] + [(100 + s, 1, True) for s in range(1, 7)]
    failed, statuses = 0, {}
    t_old = t_new = 0.0
    for seed, scale, clean in seeds:
        name = f"{'clean' if clean else 'book'}{seed}"
        load_book(seed, scale, clean)
        t0 = time.time(); old = digest('old', name); t_old += time.time() - t0
        apply_migration()
        t0 = time.time(); new = digest('new', name); t_new += time.time() - t0
        restore_old()
        cmp_old = [l for l in old if not l.startswith('reports_computed_in_close')]
        cmp_new = [l for l in new if not l.startswith('reports_computed_in_close')]
        rep_old = [l for l in old if l.startswith('reports_computed_in_close')][0].split('|')[1]
        rep_new = [l for l in new if l.startswith('reports_computed_in_close')][0].split('|')[1]
        ev = (work / f'new-{name}.txt').read_text().split('\n')[0]
        st = re.search(r'"status": "(\w+)"', ev); st = st.group(1) if st else ('error' if 'error:' in ev else '?')
        issues = sorted(set(re.findall(r'"reason": "(\w+)"', ev) + re.findall(r'"(accepted_cash_\w+|eco_intraweek\w+|post_capture_\w+|week_precedes\w+)"', ev)))
        statuses[name] = st
        if cmp_old != cmp_new:
            failed += 1; print(f'FAIL {name}: outputs differ')
            subprocess.run(['diff', str(work / f'old-{name}.txt'), str(work / f'new-{name}.txt')])
        elif int(rep_new) > 2:
            failed += 1; print(f'FAIL {name}: {rep_new} reports computed inside one close attempt (want at most one per union)')
        else:
            print(f'PASS {name}: {len(cmp_old)} digests identical; union report {st}; close attempt computed {rep_old} reports before, {rep_new} after; issues={issues}')
    if failed: raise SystemExit(f'{failed} book(s) differ; work dir kept at {work}')
    print(f'all {len(seeds)} books identical ({sum(1 for s in statuses.values() if s=="ready")} certified ready, '
          f'{sum(1 for s in statuses.values() if s=="blocked")} blocked); digest time old {t_old:.1f}s new {t_new:.1f}s')

    # the partial indexes are provable from the new queries' predicates
    apply_migration()
    plans = psql("BEGIN; DROP INDEX public.union_pnl_cash_outcomes_expr_recognized_at_idx; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;\n"
      "EXPLAIN SELECT count(*) FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'='x' AND o.recognized_at>=now() AND o.recognized_at<now()\n"
      "  AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb\n"
      "   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);\n"
      "EXPLAIN SELECT count(*) FROM public.union_pnl_cash_outcomes WHERE recognized_at>=now() AND recognized_at<now()\n"
      "  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];\n"
      "EXPLAIN SELECT count(*) FROM public.union_pnl_original_flows WHERE recognized_at>=now() AND recognized_at<now()\n"
      "  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];\n"
      "EXPLAIN SELECT count(*) FROM public.cash_hand_provenance_receipts WHERE accepted_at>=now() AND accepted_at<now() AND transaction_id IS NULL;\n"
      "EXPLAIN SELECT count(*) FROM public.union_pnl_inventory_events i WHERE i.source_name='tournament_players' AND i.observed_at>=now() AND i.observed_at<now();\n"
      "EXPLAIN SELECT count(*) FROM public.cash_participant_funding_receipts r WHERE r.table_id='00000000-0000-0000-0000-000000000001' AND r.operation_kind='buyin' AND r.account_entity_id='00000000-0000-0000-0000-000000000002';\n"
      "EXPLAIN SELECT count(*) FROM public.tournament_accounting_credit_receipts c WHERE c.tournament_id='00000000-0000-0000-0000-000000000001';\n"
      "EXPLAIN SELECT count(*) FROM public.tournament_participant_funding_receipts r WHERE r.registration_id='00000000-0000-0000-0000-000000000001';\nROLLBACK;\n").stdout
    for i in IDX:
        if i not in plans: raise SystemExit(f'FAIL: {i} is not provable from its query:\n{plans}')
    print(f'indexes: all {len(IDX)} are usable by the queries that need them')

    # red control: a wrong owner-change test and a wrong hand pass must be caught
    red = 0
    for seed in range(1, 13):
        load_book(seed, 1)
        good = digest('green', f'r{seed}')
        for n, a, b in (('fn_union_pnl_boundary', "COALESCE(bool_or(c.credited_club_id<>e.owned),false)", "false"),
                        ('fn_union_pnl_evidence_report', "sum(x.delta) delta", "max(x.delta) delta")):
            src = (fx / 'new' / f'{n}.sql').read_text()
            if src.count(a) != 1: raise SystemExit(f'red control needle missing in {n}')
            psql(src.rstrip('\n').replace(a, b) + ';\n')
        wrong = digest('red', f'r{seed}')
        if [l for l in good if not l.startswith('reports')] != [l for l in wrong if not l.startswith('reports')]: red += 1
        restore_old(); apply_migration()
    if red == 0: raise SystemExit('FAIL red control: the harness did not notice a wrong body')
    print(f'red control: a wrong owner-change test / hand pass was caught in {red} of 12 books')
    restore_old()

    ts = float(os.environ.get('TIMING_SCALE', '12'))
    if ts:
        load_book(7, ts)
        sizes = psql("SELECT (SELECT count(*) FROM public.union_pnl_cash_outcomes)||' hands, '||(SELECT count(*) FROM public.union_pnl_original_flows)||' flows, '"
                     "||(SELECT count(*) FROM public.tournament_participant_funding_receipts)||' entries, '||(SELECT count(*) FROM public.tournament_accounting_credit_receipts)||' credits, '"
                     "||(SELECT sum(jsonb_array_length(result#>'{population,tournament_players}')) FROM public.hx_inventory)||' open registrations at the two boundaries';").stdout.strip()
        def timed(tag):
            r = psql("\\timing on\nSELECT length(public.fn_union_pnl_evidence_report((SELECT union_id FROM public.hx_meta),'2026-09-21 07:00+00','2026-09-28 07:00+00')::text);\n"
                     "BEGIN; SELECT public.fn_weekly_accounting_attempt_begin(true);\n"
                     "SELECT public.fn_union_pnl_close_quality((SELECT union_id FROM public.hx_meta),'2026-09-21 07:00+00','2026-09-28 07:00+00')->>'status';\n"
                     "SELECT length(public.fn_union_pnl_evidence_report((SELECT union_id FROM public.hx_meta),'2026-09-21 07:00+00','2026-09-28 07:00+00')::text) FROM generate_series(1,4);\n"
                     "ROLLBACK;\n")
            ms = [float(x) for x in re.findall(r'Time: ([0-9.]+) ms', r.stdout)]
            return ms
        o = timed('old'); apply_migration(); n = timed('new')
        print(f'timing book: {sizes}')
        print(f'  one report outside a close: original {o[0]/1000:.1f}s, changed {n[0]/1000:.1f}s')
        print(f'  one close (close quality + 4 more reports in one attempt): original {sum(o[3:5])/1000:.1f}s, changed {sum(n[3:5])/1000:.1f}s')
    print('GREEN OK')
finally:
    if started: subprocess.run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate', 'stop'], env=env, capture_output=True)
    if os.environ.get('KEEP') != '1': shutil.rmtree(work, ignore_errors=True)
