#!/usr/bin/env python3
"""Rehearse installed and proposed blind authorities in disposable local PG17.
No remote connection argument is accepted and no production data is loaded.
Exercises the actual manager method and exact captured SQL, not replicas.
"""
from pathlib import Path
import copy
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
pg = Path(os.environ['POKER_AUDIT_PG_BIN']) if os.environ.get('POKER_AUDIT_PG_BIN') else Path(
    subprocess.check_output(['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-blind-authority-pg17-'))
cluster, sock = root / 'cluster', root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
result_path = Path('/tmp/codex-k01-blind-authority-results.json')
log_path = Path('/tmp/codex-k01-blind-authority-pg17.log')
proposal = repo / 'supabase/migrations/20260910070354_short_format_blinds_continue_their_approved_rules.sql'
captured = json.loads(subprocess.check_output(
    [os.environ.get('POKER_AUDIT_NODE', 'node'), str(repo / 'scripts/dev/blind-authority-runtime.mjs')],
    text=True))
captured['source_commit'] = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
signature = 'public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'
installed_md5 = 'b5769b647e5b106caaf51982ac245ee8'

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def call(structure, index, variant, kind, chips):
    return 'SELECT public.fn_resolve_tournament_blinds(' + ','.join([
        literal(json.dumps(structure)), str(index), literal(variant), literal(kind),
        'NULL' if chips is None else str(chips)]) + ')'

with log_path.open('w') as log:
    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        subprocess.run([str(pg / 'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'],
                       check=True, stdout=log, stderr=log)
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-o',
                        f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'],
                       check=True, stdout=log, stderr=log)
        args = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-h', str(sock), '-p', port, '-d', 'postgres']
        def q(sql, failure=None):
            run = subprocess.run(args + ['-c', sql], text=True, capture_output=True, timeout=30)
            if failure:
                assert run.returncode != 0 and failure in run.stderr, run.stderr
                return run.stderr
            if run.returncode:
                raise RuntimeError(run.stderr)
            return run.stdout.strip()

        installed = (repo / 'scripts/dev/fixtures/blind-authority/installed.sql').read_text()
        q('CREATE ROLE postgres SUPERUSER; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
        def restore():
            q(installed)
            q(f'ALTER FUNCTION {signature} OWNER TO postgres; REVOKE ALL ON FUNCTION {signature} FROM PUBLIC;')
        restore()
        assert q(f"SELECT md5(prosrc) FROM pg_proc WHERE oid='{signature}'::regprocedure") == installed_md5
        generic = []
        structures = [
            [{'level': 1, 'smallBlind': 10, 'bigBlind': 20, 'ante': 0},
             {'level': 2, 'smallBlind': 15, 'bigBlind': 30, 'ante': 5}],
            [{'small_blind': 25, 'big_blind': 50, 'ante': 5},
             {'small_blind': 50, 'big_blind': 100, 'ante': 10}],
            [{'smallBlind': 10, 'bigBlind': 20}, {'isBreak': True}],
            [{'smallBlind': 5000000, 'bigBlind': 10000000, 'ante': 10000000}],
        ]
        for structure in structures:
            for index in [0, 1, 2, 13, 64]:
                for chips in [None, 600, 100000]:
                    sql = call(structure, index, 'standard', 'MTT', chips)
                    generic.append((sql, json.loads(q(sql))))
        for item in captured['rows']:
            item['installed_sql'] = json.loads(q(call(item['structure'], item['level'] - 1,
                item['format'], item['format'].upper(), item['total_chips'])))

        # Review guards must fail before installing any body if the authority
        # disappeared, changed, or gained executable privileges.
        migration = proposal.read_text()
        q(f'DROP FUNCTION {signature};')
        q(migration, 'preflight changed')
        assert q(f"SELECT to_regprocedure('{signature}') IS NULL") == 't'
        restore()
        changed = installed.replace('  v_levels := public.fn_safe_jsonb_array',
                                    '  -- fixture drift\n  v_levels := public.fn_safe_jsonb_array')
        q(changed)
        q(migration, 'preflight changed')
        assert q(f"SELECT md5(prosrc) FROM pg_proc WHERE oid='{signature}'::regprocedure") != installed_md5
        restore()
        q(f'GRANT EXECUTE ON FUNCTION {signature} TO PUBLIC;')
        q(migration, 'preflight changed')
        assert q(f"SELECT md5(prosrc) FROM pg_proc WHERE oid='{signature}'::regprocedure") == installed_md5
        restore()
        q(migration)
        captured['proposal_body_md5'] = q(f"SELECT md5(prosrc) FROM pg_proc WHERE oid='{signature}'::regprocedure")
        assert q(f"SELECT proacl::text FROM pg_proc WHERE oid='{signature}'::regprocedure") == '{postgres=X/postgres}'
        keys = ('small_blind', 'big_blind', 'ante')
        for item in captured['rows']:
            item['proposed_sql'] = json.loads(q(call(item['structure'], item['level'] - 1,
                item['format'], item['format'].upper(), item['total_chips'])))
            for field in ['manager', 'installed_sql', 'proposed_sql']:
                item[field + '_matches_expected'] = all(item[field][key] == item['expected'][key] for key in keys)
            assert item['manager_matches_expected'], item
            assert item['proposed_sql_matches_expected'], item
            assert item['manager']['duration_ms'] == item['expected']['duration_ms'], item
        for sql, before in generic:
            assert json.loads(q(sql)) == before, sql

        stored = copy.deepcopy(captured['rows'][0]['structure'])
        invalid = [None, [], {}, {'version': 99},
                   {'version': 1, 'anchorLevel': 10, 'anchorBigBlind': 210, 'growth': 1, 'roundBigTo': 10},
                   {'version': 1, 'anchorLevel': 10.5, 'anchorBigBlind': 210, 'growth': 1.4, 'roundBigTo': 10},
                   {'version': 1, 'anchorLevel': 10, 'anchorBigBlind': '210', 'growth': 1.4, 'roundBigTo': 10},
                   {'version': 1, 'anchorLevel': 10, 'anchorBigBlind': 210, 'growth': 1.4, 'roundBigTo': 0},
                   {'version': 1, 'anchorLevel': 0, 'anchorBigBlind': 210, 'growth': 1.4, 'roundBigTo': 10},
                   {'version': 1, 'anchorLevel': 10, 'anchorBigBlind': -210, 'growth': 1.4, 'roundBigTo': 10}]
        for continuation in invalid:
            stored[-1]['spinContinuation'] = continuation
            q(call(stored, 12, 'spin', 'SPIN', 900), 'frozen formula')
        # PostgreSQL numeric accepts a wider domain than finite JS numbers.
        for raw in ['1e400', '1e-400']:
            stored[-1]['spinContinuation'] = {'version': 1, 'anchorLevel': 10,
                'anchorBigBlind': '__outside_js_domain__', 'growth': 1.4, 'roundBigTo': 10}
            sql = call(stored, 12, 'spin', 'SPIN', 900).replace(
                '"__outside_js_domain__"', raw)
            q(sql, 'frozen formula')
        stored[-1]['spinContinuation'] = {'version': 1, 'anchorLevel': 10,
            'anchorBigBlind': 210, 'growth': 1e200, 'roundBigTo': 10}
        q(call(stored, 12, 'spin', 'SPIN', 900), 'frozen formula')
        del stored[-1]['spinContinuation']
        assert json.loads(q(call(stored, 12, 'spin', 'SPIN', 900)))['big_blind'] == 580
        for variant, kind in [('sng', 'MTT'), ('standard', 'SNG')]:
            assert json.loads(q(call([{'smallBlind': 1, 'bigBlind': 2}], 12, variant, kind, 600)))['big_blind'] == 560
        captured['installed_catalog_body_md5'] = installed_md5
        captured['proposal_file'] = str(proposal.relative_to(repo))
        captured['production_writes'] = False
        captured['summary'] = {
            'rows_executed': len(captured['rows']),
            'approved_spin_rows': sum(r['format'] == 'spin' and r['tag'] == 'approved-current' for r in captured['rows']),
            'installed_sql_mismatches': sum(not r['installed_sql_matches_expected'] for r in captured['rows']),
            'proposed_sql_mismatches': sum(not r['proposed_sql_matches_expected'] for r in captured['rows']),
            'manager_mismatches': sum(not r['manager_matches_expected'] for r in captured['rows']),
            'generic_mtt_unchanged_cases': len(generic),
            'malformed_receipts_rejected': len(invalid) + 3,
            'preflight_refusals': 3,
            'private_acl_preserved': True,
        }
        result_path.write_text(json.dumps(captured, indent=2) + '\n')
        print(json.dumps({'result': str(result_path), **captured['summary']}, indent=2))
    finally:
        if cluster.exists():
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'immediate', 'stop'],
                           stdout=log, stderr=log)
        shutil.rmtree(root)
