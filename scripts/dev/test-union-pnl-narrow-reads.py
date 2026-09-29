#!/usr/bin/env python3
"""Native qualification of 20260929044303: a union close reads narrow
projections, not wide rows.

Builds production's union P&L state in a disposable PostgreSQL 17 cluster by
applying the real migration chain (20260928211132, 20260928222109,
20260928230637, 20260929001003) over the harness tables, and checks every
function this change replaces or depends on against production's live
md5(pg_get_functiondef) (2026-09-29). Then, for each randomized book
(tests/fixtures/union-pnl-evidence-fast/gen.py plus this fixture's extras.sql
edge shapes, and clean books that certify), every read path is digested
(hx_digest: the report for the Union, another Union, a pre-capture and an
open week, both boundaries, close quality, qualified clubs, and all of it
again inside one close attempt), first with production's functions, then:
  1. after the migration, before any backfill (the original reads);
  2. after the throttled backfill has completed in random small steps (the
     projections), plus the full projection proof and the sampled verifier;
  3. on a fresh copy where the migration came first and the book was written
     through the writers (the capture-time path).
Every digest must equal production's, value for value and refusal for
refusal. Then: writers racing an unfinished backfill still leave exact
projections; the state row refuses any other writer; the procedure throttles
and commits; three red controls (a wrong participant key, a Union test
without its Union, a credit week without its week) must each be caught; and
the IO comparison on a production-shaped book (blocks touched per report).

  SEEDS=N          randomized books (default 30), plus 5 clean and 3 refusing
  TIMING_EVENTS=N  events in the IO book (default 150000; 0 skips it)
  GEN_POSTIMAGE=1  apply without postimage checks and print the digests
  TIMING_ONLY=1    only the IO comparison
"""
import glob, json, os, random, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
root = Path(__file__).resolve().parents[2]
fx = root / 'tests/fixtures/union-pnl-narrow-reads'
fast = root / 'tests/fixtures/union-pnl-evidence-fast'
opn = root / 'tests/fixtures/union-pnl-opening-resolution'
flow = root / 'tests/fixtures/union-pnl-flow-scope-seat'
pgbin = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
def mig(slug): return Path(glob.glob(str(root / 'supabase/migrations' / f'*_{slug}*.sql'))[0])
CHAIN = [mig('a_union_close_proves_its_pnl_evidence_once_and_fast'), mig('an_opening_registration_is_resolved_from_its_ledger_entry'),
         mig('a_resolved_opening_registration_is_the_entry_evidence_for_it'), mig('a_cash_out_a_lost_link_and_a_satellite_seat_are_proved_from_')]
MIGRATION = mig('a_union_close_reads_narrow_projections_not_wide_rows')
work = Path(tempfile.mkdtemp(prefix='unr.', dir=os.environ.get('TMPDIR', '/tmp')))
port = os.environ.get('PORT', '55577')
sock = work / 's'; sock.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env.update(LC_ALL='C', LANG='C', PGTZ='UTC')
sys.stdout.reconfigure(line_buffering=True)
started = False
PROD = {  # md5(pg_get_functiondef) live in production, 2026-09-29 04:2x UTC
 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)': '16dcb8e9165ddd478802f24fbd22cab3',
 'fn_union_pnl_boundary(uuid,timestamp with time zone)': '0e1fb7d6826b5a95ce5e637174017ede',
 'fn_union_pnl_close_quality(uuid,timestamp with time zone,timestamp with time zone)': '8b5551d177b27bcbd211b8ecd9ee3a11',
 'fn_union_pnl_qualified_clubs(uuid,timestamp with time zone,timestamp with time zone)': '2fed6a15cdb5186d19e3cee731b8d804',
 'fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)': 'b49d259721d3eb9c1d8ba7061fd28b7e',
 'fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)': '7e443fd75f3b1ece7cd0713a6b8fc0a5',
 'fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)': '0c3a826553e9ef65a03030c3ef78eaaf',
 'fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)': '627c6a7dd232bb8030d5400adf8346f2',
 'fn_union_pnl_satellite_seat_owner(uuid,uuid)': '9f0aff5616730556aa600d1027920433',
 'fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)': 'df92fab5faa87f191ee85f52ce2c82e6',
 'fn_union_pnl_award_owner_resolved(tournament_accounting_credit_receipts,uuid,timestamp with time zone,uuid[])': '639b5a724967f7779f8134275c93dfa1',
 'fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)': '09e6fc21f116c941de74edc8b37be654',
 'fn_union_pnl_tournament_returns(uuid,uuid,timestamp with time zone,timestamp with time zone)': '065c90de9bd14ae893dcb96bff0a3be1',
 'fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)': 'e242c70ffaa62bfe872f30cf7d0e1a5f',
 'fn_union_pnl_inventory_observe()': '11c7c788d943a11375a15819e78873ba',
 'fn_union_pnl_original_frame()': '9a6559774cc1ed4ed49b315a3428abdb',
 'fn_union_pnl_receipt_frame()': 'dd4dbe3a58dc48bd67aab9ac818280d2',
 'fn_union_pnl_inventory_immutable()': '307d83a1ee3d912bade24c48144aa801',
}
DATA = ['cash_funding_application_receipts', 'cash_hand_provenance_receipts', 'cash_participant_funding_receipts', 'tournament_accounting_credit_receipts',
        'tournament_participant_funding_receipts', 'tournament_refund_tranches', 'union_pnl_cash_outcome_resolutions', 'union_pnl_cash_outcomes',
        'union_pnl_inventory_capture', 'union_pnl_inventory_events', 'union_pnl_original_flows', 'union_pnl_transaction_frames', 'union_pnl_weekly_capture',
        'accounting_payable_earning_sources', 'hx_inventory', 'hx_lineage', 'hx_eco', 'hx_rake_basis', 'hx_meta', 'chip_ledger',
        'union_pnl_opening_registration_resolutions', 'union_pnl_cash_outcome_link_resolutions']
def run(args, **kw): return subprocess.run(args, env=env, check=True, capture_output=True, text=True, **kw)
def psql(sql=None, files=(), check=True):
    args = [str(pgbin / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-h', str(sock), '-p', port, '-d', 'postgres', '-At']
    for f in files: args += ['-f', str(f)]
    r = subprocess.run(args, env=env, input=sql, capture_output=True, text=True)
    if check and r.returncode != 0: raise SystemExit(f'psql failed ({r.returncode}):\n{r.stderr[-3000:]}')
    return r
def one(sql): return psql(sql).stdout.strip()
def replace_sql(p): return Path(p).read_text().rstrip('\n').replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 1) + ';\n'
def down(): psql(files=[fx / 'down.sql']); psql(replace_sql(opn / 'new/fn_union_pnl_boundary.sql') + replace_sql(flow / 'new/fn_union_pnl_evidence_report.sql'))
def migration_text(check_post=True, edits=()):
    m = MIGRATION.read_text()
    if not check_post: m = re.sub(r"DO \$post\$.*?END \$post\$;\n", '', m, flags=re.S)
    for a, b in edits:
        if m.count(a) != 1: raise SystemExit(f'red needle found {m.count(a)} times: {a[:80]!r}')
        m = m.replace(a, b)
    return m
def apply(check_post=True, edits=()):
    (work / 'm.sql').write_text(migration_text(check_post, edits)); psql(files=[work / 'm.sql'])
def truncate(): psql('SET session_replication_role=replica;\nTRUNCATE ' + ','.join('public.' + t for t in DATA) + ';\n')
def load(seed, clean=False, brk=0):
    truncate()
    g = work / 'book.sql'
    with g.open('w') as f: subprocess.run([sys.executable, str(fast / 'gen.py'), str(seed), '1'] + (['clean'] if clean else []), stdout=f, check=True)
    psql(files=[g])
    if not clean: psql(f'SELECT public.hx_extras({seed},{brk});')
    psql('ANALYZE;')
def digest(tag):
    full = psql("SELECT label||E'\\t'||body FROM public.hx_digest();\n").stdout
    (work / f'{tag}.txt').write_text(full)
    return [l for l in full.splitlines() if not l.startswith('reports_computed_in_close')]
def backfill(rng, extra=None):
    steps = 0
    while True:
        p = one('SELECT public.fn_union_pnl_projection_build_pending();')
        if not p: return steps
        r = json.loads(one(f"SELECT public.fn_union_pnl_projection_build_step('{p}',{rng.randint(1, 3)});"))
        steps += 1
        if extra and steps == 2: psql(extra)
        if steps > 100000: raise SystemExit('backfill does not terminate')
def status_ready(): return one("SELECT public.fn_union_pnl_projection_status()->>'ready';") == 'true'
def diff(a, b, tag):
    subprocess.run(['diff', str(work / f'{a}.txt'), str(work / f'{b}.txt')])
    raise SystemExit(f'FAIL {tag}; work dir kept at {work}')
try:
    run([str(pgbin / 'initdb'), '-D', str(work / 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-l', str(work / 'server.log'), '-w', 'start',
         '-o', f"-k {sock} -p {port} -h '' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=64MB"
               " -c work_mem=16MB -c max_parallel_workers_per_gather=0 -c max_wal_size=96MB -c min_wal_size=32MB"])
    started = True
    pre = work / 'preimages.sql'
    pre.write_text(''.join(replace_sql(p) for p in sorted((fast / 'preimage').glob('*.sql'))))
    psql(files=[fast / 'prelude.sql', fast / 'schema-tables.sql', fast / 'stubs.sql', opn / 'schema.sql', flow / 'schema.sql', pre, fast / 'runner.sql', fast / 'indexes.sql'])
    psql(files=[CHAIN[0], CHAIN[1], CHAIN[2]])
    (work / 'flowpre.sql').write_text(replace_sql(flow / 'preimage/fn_union_pnl_original_flow_evidence.sql') + replace_sql(flow / 'preimage/fn_cash_original_funding_lineage.sql'))
    psql(files=[work / 'flowpre.sql', CHAIN[3]])
    # the harness lineage (hx_lineage facts), as in union-pnl-evidence-fast
    stub = (fast / 'stubs.sql').read_text()
    i = stub.index('CREATE FUNCTION public.fn_cash_original_funding_lineage'); j = stub.index('$$;', i) + 3
    psql('DROP FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean);\n' + stub[i:j] + '\n')
    psql(files=[fx / 'prod-shape.sql', fx / 'extras.sql', fx / 'timing.sql'])
    bad = []
    for sig, h in PROD.items():
        got = one(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure));")
        if got != h: bad.append(f'{sig}: {got} != production {h}')
    if bad: raise SystemExit('the harness is not production:\n' + '\n'.join(bad))
    print(f'{len(PROD)} production definitions rebuilt by the real migration chain; every md5(pg_get_functiondef) equals production')

    if os.environ.get('GEN_POSTIMAGE') == '1':
        apply(check_post=False)
        names = re.findall(r"'public\.(fn_[a-z_]+\([^']*\))'::regprocedure", MIGRATION.read_text())
        d = {s: one(f"SELECT md5(pg_get_functiondef('public.{s}'::regprocedure));") for s in sorted(set(names)) if 'fn_ca_' not in s}
        print(json.dumps(d, indent=1)); sys.exit(0)

    rng = random.Random(20260929)
    books = [(s, False, 0) for s in range(1, int(os.environ.get('SEEDS', '30')) + 1)] + [(100 + s, True, 0) for s in range(1, 6)] + [(201, False, 1), (202, False, 2), (203, False, 3)]
    st = {}
    if os.environ.get('TIMING_ONLY') == '1': books = []
    for seed, clean, brk in books:
        name = f"{'clean' if clean else 'book'}{seed}" + (f'-break{brk}' if brk else '')
        load(seed, clean, brk)
        d0 = digest(f'{name}-prod')
        apply()
        pending = one("SELECT count(*) FROM public.union_pnl_projection_build WHERE completed_at IS NULL;")
        d1 = digest(f'{name}-unfilled')
        if d1 != d0: diff(f'{name}-prod', f'{name}-unfilled', f'{name}: the migrated report before its backfill differs from production')
        steps = backfill(rng)
        if not status_ready(): raise SystemExit(f'FAIL {name}: backfill finished but the projections are not ready')
        exact = one('SELECT public.hx_projection_exact();')
        ver = json.loads(one('SELECT public.fn_union_pnl_projection_verify(100);'))
        if exact != '0/0/0' or ver.get('ok') is not True: raise SystemExit(f'FAIL {name}: projections differ from their sources ({exact}, {ver})')
        d2 = digest(f'{name}-projected')
        if d2 != d0: diff(f'{name}-prod', f'{name}-projected', f'{name}: the report through the projections differs from production')
        # the capture-time path: migrate an empty book, then write it
        down(); truncate(); apply()
        if not status_ready(): raise SystemExit(f'FAIL {name}: an empty source must need no backfill')
        g = work / 'book.sql'
        with g.open('w') as f: subprocess.run([sys.executable, str(fast / 'gen.py'), str(seed), '1'] + (['clean'] if clean else []), stdout=f, check=True)
        psql(files=[g])
        if not clean: psql(f'SELECT public.hx_extras({seed},{brk});')
        psql('ANALYZE;')
        exact3 = one('SELECT public.hx_projection_exact();')
        d3 = digest(f'{name}-written')
        if exact3 != '0/0/0': raise SystemExit(f'FAIL {name}: the writers left projections that differ ({exact3})')
        if d3 != d0: diff(f'{name}-prod', f'{name}-written', f'{name}: the report through writer-built projections differs from production')
        ev = (work / f'{name}-prod.txt').read_text().split('\n')[0]
        s = re.search(r'"status": "(\w+)"', ev); s = s.group(1) if s else ('error' if 'error:' in ev else '?')
        st[name] = s
        issues = sorted(set(re.findall(r'"reason": "(\w+)"', ev)))
        print(f'PASS {name}: {len(d0)} digests identical before backfill, after {steps} backfill steps ({pending} projections pending at install) and when written at capture; report {s}; issues={issues}' + (f"; refusal={ev.split(':',3)[2][:90]!r}" if s == 'error' else ''))
        down()
    print(f"all {len(books)} books identical ({sum(1 for s in st.values() if s == 'ready')} certified ready, {sum(1 for s in st.values() if s == 'blocked')} blocked, "
          f"{sum(1 for s in st.values() if s == 'error')} refused with an error)")

    if os.environ.get('TIMING_ONLY') != '1':
        # writers racing an unfinished backfill; the guarded state; the procedure
        load(7)
        apply()
        backfill(rng, extra='SELECT public.hx_extras(9007,0);')
        exact = one('SELECT public.hx_projection_exact();')
        if exact != '0/0/0': raise SystemExit(f'FAIL: rows written during the backfill left projections that differ ({exact})')
        print('PASS writers racing an unfinished backfill: every projection exact')
        r = psql("UPDATE public.union_pnl_projection_build SET steps=steps+1;", check=False)
        if r.returncode == 0 or 'written_only_by_its_step' not in r.stderr: raise SystemExit('FAIL: the backfill state accepted a foreign write')
        r = psql("DELETE FROM public.union_pnl_projection_build;", check=False)
        if r.returncode == 0: raise SystemExit('FAIL: the backfill state accepted a delete')
        r = psql("SET app.union_pnl_projection_build='on'; UPDATE public.union_pnl_projection_build SET next_block=0;", check=False)
        if r.returncode == 0: raise SystemExit('FAIL: the backfill state went backwards')
        for t in ('union_pnl_inventory_touches', 'union_pnl_cash_outcome_touches', 'union_pnl_credit_touches'):
            r = psql(f"DELETE FROM public.{t};", check=False)
            if r.returncode == 0: raise SystemExit(f'FAIL: {t} is not immutable')
        again = json.loads(one("SELECT public.fn_union_pnl_projection_build_step('inventory_touches',8);"))
        if again.get('status') != 'complete': raise SystemExit('FAIL: a completed backfill step is not a no-op')
        print('PASS the state refuses foreign, backward and deleting writes; projections are immutable; a finished step is a no-op')
        down(); load(8); apply()
        t0 = time.time(); psql('CALL public.sp_union_pnl_projection_build(1, 5, 60, 100);'); took = time.time() - t0
        n_steps = int(one("SELECT sum(steps) FROM public.union_pnl_projection_build;"))
        if not status_ready() or one('SELECT public.hx_projection_exact();') != '0/0/0':
            raise SystemExit('FAIL: the procedure did not complete the backfill exactly')
        if took < n_steps * 0.005 * 0.9: raise SystemExit(f'FAIL: the procedure did not pause between steps ({n_steps} steps in {took:.2f}s)')
        print(f'PASS the procedure committed {n_steps} one-block steps with a 5 ms pause each ({took:.2f}s) and left exact projections')
        down(); load(9); apply()
        t0 = time.time(); psql('CALL public.sp_union_pnl_projection_build(1, 0, 60, 20);'); took20 = time.time() - t0
        if not status_ready(): raise SystemExit('FAIL: the duty-cycled procedure did not finish')
        print(f'PASS a 20% duty cycle: the backfill took {took20:.2f}s wall for its steps (sleeping about four times each step)')
        down()

        # red controls: each wrong body must be caught
        REDS = [('participants keep the wrong key', ("'observed_stack_delta',e.x->'observed_stack_delta'", "'observed_stack_delta',e.x->'earning_club_id'")),
                ('a Union test without its Union', ("   AND t.row_id::text=p_tournament_id\n   AND t.union_id=p_union_id::text);\n", "   AND t.row_id::text=p_tournament_id);\n")),
                ('a credit week without its week', ("WHERE t.union_id=p_union_id::text AND t.frame_observed_at>=p_start AND t.frame_observed_at<p_end;",
                                                     "WHERE t.union_id=p_union_id::text;"))]
        for label, edit in REDS:
            caught = 0
            for seed in range(1, 11):
                load(seed); d0 = digest(f'red{seed}-prod')
                apply(check_post=False, edits=[edit]); backfill(rng)
                if digest(f'red{seed}-wrong') != d0: caught += 1
                down()
            if caught == 0: raise SystemExit(f'FAIL red control: {label} was not caught')
            print(f'red control: {label} caught in {caught} of 10 books')

    n = int(os.environ.get('TIMING_EVENTS', '150000'))
    if n:
        truncate(); psql(f'SELECT public.hx_timing_book({n},{n // 5},{n // 60}); ANALYZE;')
        size = one("SELECT pg_size_pretty(pg_total_relation_size('public.union_pnl_inventory_events'))||' events, '||"
                   "pg_size_pretty(pg_total_relation_size('public.union_pnl_cash_outcomes'))||' hands, '||"
                   "pg_size_pretty(pg_total_relation_size('public.tournament_accounting_credit_receipts'))||' credits, '||"
                   "pg_size_pretty(pg_total_relation_size('public.tournament_participant_funding_receipts'))||' entries';")
        CALL = "SELECT length(public.fn_union_pnl_evidence_report((SELECT union_id FROM public.hx_meta),'2026-09-21 07:00+00','2026-09-28 07:00+00')::text);"
        WIDE = ('union_pnl_inventory_events', 'union_pnl_cash_outcomes', 'tournament_accounting_credit_receipts', 'tournament_participant_funding_receipts')
        def measure():
            before = {r.split('|')[0]: list(map(int, r.split('|')[1:])) for r in psql("SELECT relname||'|'||heap||'|'||toast||'|'||idx FROM public.hx_blocks;").stdout.split()}
            t0 = time.time(); out = one(CALL); ms = (time.time() - t0) * 1000
            time.sleep(0.6)
            after = {r.split('|')[0]: list(map(int, r.split('|')[1:])) for r in psql("SELECT relname||'|'||heap||'|'||toast||'|'||idx FROM public.hx_blocks;").stdout.split()}
            delta = {k: [a - b for a, b in zip(after[k], before.get(k, [0, 0, 0]))] for k in after}
            wide = sum(sum(delta.get(k, [0, 0, 0])) for k in WIDE)
            return ms, wide, sum(sum(v) for v in delta.values()), out, delta
        o_ms, o_wide, o_all, o_out, o_d = measure()
        apply(); t0 = time.time()
        psql('CALL public.sp_union_pnl_projection_build(512, 0, 3600, 100);'); bf = time.time() - t0
        n_ms, n_wide, n_all, n_out, n_d = measure()
        if o_out != n_out: raise SystemExit('FAIL timing book: report lengths differ')
        print(f'IO book: {size}')
        for k in WIDE: print(f'  {k}: blocks touched per report {sum(o_d.get(k,[0,0,0]))} -> {sum(n_d.get(k,[0,0,0]))}')
        print(f'  wide sources total {o_wide} -> {n_wide} blocks; all relations {o_all} -> {n_all}; wall {o_ms/1000:.2f}s -> {n_ms/1000:.2f}s (warm cache)')
        print(f'  full backfill of this book at 512 blocks/step: {bf:.1f}s')
        down()
    print('GREEN OK')
finally:
    if started: subprocess.run([str(pgbin / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate', 'stop'], env=env, capture_output=True)
    if os.environ.get('KEEP') != '1': shutil.rmtree(work, ignore_errors=True)
