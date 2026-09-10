#!/usr/bin/env python3
"""Rehearse installed and proposed booked Spin authority in disposable local PG17.
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
root = Path(tempfile.mkdtemp(prefix='ca-booked-spin-authority-pg17-'))
cluster, sock = root / 'cluster', root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
result_path = Path('/tmp/codex-booked-spin-authority-results.json')
log_path = Path('/tmp/codex-booked-spin-authority-pg17.log')
proposal = repo / 'supabase/migrations/20260910132723_booked_spin_continuation_preserves_floating_point_rounding.sql'
captured = json.loads(subprocess.check_output(
    [os.environ.get('POKER_AUDIT_NODE', 'node'), str(repo / 'scripts/dev/booked-spin-authority-runtime.mjs')],
    text=True))
expected_errors = [r for r in captured['rows'] if 'expected_error' in r]
captured['rows'] = [r for r in captured['rows'] if 'expected_error' not in r]
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

        installed = (repo / 'scripts/dev/fixtures/booked-spin-authority/installed.sql').read_text()
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
        unchanged_short_formats=[]
        for format in ['sng','spin']:
            for stack in [600,2000]:
                for index in [0,1,12,13,19,31]:
                    sql=call([{'smallBlind':10,'bigBlind':20,'ante':0,'duration':180}],index,format,format.upper(),stack)
                    unchanged_short_formats.append((sql,json.loads(q(sql))))
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
        for sql,before in unchanged_short_formats:
            assert json.loads(q(sql))==before,sql
        # Remove only the new local declarations and booked Spin branch.
        # The remainder must match the entire installed resolver byte for byte.
        new_body = migration.split('AS $function$')[1].split('$function$;')[0]
        old_body = installed.split('AS $function$')[2].split('$function$;')[0]
        declarations = new_body[new_body.index('  v_continuation jsonb;'):new_body.index('  v_tail_count integer;')]
        branch = new_body[new_body.index('    -- A funded draw freezes'):new_body.index('    -- spinBlindsForLevel(index+1)')]
        assert new_body.replace(declarations, '', 1).replace(branch, '', 1) == old_body
        captured['entire_installed_body_preserved_except_new_spin_branch_and_locals'] = True
        captured['unchanged_legacy_short_format_cases']=len(unchanged_short_formats)
        for item in expected_errors:
            q(call(item['structure'],item['level']-1,'spin','SPIN',900),item['expected_error'])
        captured['rounding_zero_refusals'] = len(expected_errors)

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
        raw_number_cases=[]
        canonical=copy.deepcopy(captured['rows'][0]['structure'])
        canonical[-1]['spinContinuation']={'version':1,'anchorLevel':12,'anchorBigBlind':100,'growth':1.15,'roundBigTo':10}
        for key,raw,should_refuse in [('growth','1.000000000000000000001',True),('version','1.000000000000000000001',False),('anchorLevel','12.000000000000000000001',False)]:
            test=copy.deepcopy(canonical);test[-1]['spinContinuation'][key]='__raw_number__'
            sql=call(test,12,'spin','SPIN',900).replace('"__raw_number__"',raw)
            if should_refuse:q(sql,'frozen formula')
            else:assert json.loads(q(sql))['big_blind']==110
            raw_number_cases.append({'field':key,'raw_json_number':raw,'refused':should_refuse})
        captured['raw_number_cases']=raw_number_cases
        captured['installed_catalog_body_md5'] = installed_md5
        captured['proposal_file'] = str(proposal.relative_to(repo))
        captured['production_writes'] = False
        captured['summary'] = {
            'rows_executed': len(captured['rows']),
            'rounding_rows': sum(r['tag']=='frozen-number-rounding' for r in captured['rows']),
            'rounding_zero_refusals': len(expected_errors),
            'approved_spin_rows': sum(r['format'] == 'spin' and r['tag'] == 'approved-current' for r in captured['rows']),
            'installed_sql_mismatches': sum(not r['installed_sql_matches_expected'] for r in captured['rows']),
            'proposed_sql_mismatches': sum(not r['proposed_sql_matches_expected'] for r in captured['rows']),
            'manager_mismatches': sum(not r['manager_matches_expected'] for r in captured['rows']),
            'generic_mtt_unchanged_cases': len(generic),
            'legacy_hu_and_spin_unchanged_cases':len(unchanged_short_formats),
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
