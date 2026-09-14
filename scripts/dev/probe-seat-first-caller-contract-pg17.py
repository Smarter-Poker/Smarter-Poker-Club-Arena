#!/usr/bin/env python3
"""Actual seat-first caller payloads against the captured current atomic SQL.

Private PostgreSQL17 only. No network listener or production URL. This selected
schema isolates request acceptance, pair atomicity and replay; it does not
qualify full production triggers, target admission, funding, or dealer play.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
fixtures = repo / 'scripts/dev/fixtures/seat-first-caller-contract'
baseline = json.loads((fixtures / 'baseline.json').read_text())
payloads = json.loads((fixtures / 'actual-caller-payloads.json').read_text())
assert len(payloads) == 12
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-sf-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port, PGUSER='postgres', PGDATABASE='postgres')
started = False
passed = []
result = {'passed': passed, 'source_md5': baseline['source_md5'], 'sampled_at': baseline['sampled_at'], 'payload_sha256': hashlib.sha256((fixtures / 'actual-caller-payloads.json').read_bytes()).hexdigest(), 'limits': 'selected captured column types, synthetic defaults and empty-purchase-freeze stand-in; no production trigger graph, target admission, funding, JWT/HTTP or gameplay'}
with (root / 'results.log').open('w') as log:
    def command(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)

    def q(sql, error=None):
        r = subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True, env=env, timeout=15)
        log.write(r.stdout + r.stderr)
        log.flush()
        if error:
            assert r.returncode and error in r.stderr, r.stderr
        else:
            assert r.returncode == 0, r.stderr
        return r.stdout.strip()

    def ok(name):
        passed.append(name)
        print('PASS ' + name, flush=True)

    def event(i):
        return f'c6000000-0000-4000-8000-{i:012d}'

    def call(i, cfg, error=None, settings=''):
        encoded = json.dumps(cfg).replace("'", "''")
        return q(f"SET ROLE service_role; {settings} SELECT public.fn_create_seat_first_game_atomic('{event(i)}','{encoded}'::jsonb);", error)

    def counts():
        return q('SELECT (SELECT count(*) FROM tournaments)||\',\'||(SELECT count(*) FROM tables);')

    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        command([str(pg / 'initdb'), '-D', str(cluster), '-U', 'postgres', '--auth=trust', '--no-locale'])
        command([str(pg / 'pg_ctl'), '-D', str(cluster), '-o', f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        q("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.frozen',true),'false')='true' $$;")
        for table in ['tournaments', 'tables']:
            cols = []
            for c in baseline['columns']:
                if c['table'] != table:
                    continue
                assert re.fullmatch('[a-zA-Z_][a-zA-Z_0-9]*', c['name'])
                assert re.fullmatch('[a-zA-Z0-9_ (),]+', c['type'])
                default = ' PRIMARY KEY DEFAULT gen_random_uuid()' if c['name']=='id' else ' DEFAULT now()' if c['name']=='created_at' else ' DEFAULT false' if c['name']=='is_deleted' else ' DEFAULT 10' if c['name']=='payout_percent' else ''
                cols.append('"' + c['name'] + '" ' + c['type'] + default)
            q('CREATE TABLE public.' + table + '(' + ','.join(cols) + ');')
        q(baseline['definition'])
        q('REVOKE ALL ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) TO service_role;')
        pin = "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure;"
        assert q(pin) == baseline['source_md5'] == 'b40dd95b7a87019070a8abf0fcc4fff3'
        ok('unchanged captured current atomic creator compiles and exact body matches')
        for i, payload in enumerate(payloads, 1):
            cfg = payload['config']
            receipt = json.loads(call(i,cfg))
            assert receipt['ok'] is True and receipt['replayed'] is False
            assert receipt['tournament']['id'] == event(i)
            assert receipt['tournament']['starting_chips'] == cfg['starting_chips']
            if cfg['tournament_type']=='SATELLITE':
                assert receipt['tournament']['satellite_target_id'] == cfg['satellite_target_id']
                assert receipt['tournament']['satellite_seats'] == 1
            replay = json.loads(call(i,cfg))
            assert replay['ok'] is True and replay['replayed'] is True and replay['table_id'] == receipt['table_id']
        assert counts() == '12,12'
        ok('twelve actual caller payloads each create one committed pair and replay its exact identity')
        for i, payload in enumerate(payloads, 101):
            if payload['config']['tournament_type'] == 'SPIN':
                continue
            call(i, {**payload['config'], 'payout_percent':20}, 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY')
        assert counts() == '12,12'
        ok('eight original heads-up and satellite payloads reproduce the unknown-key refusal without writes')
        sat_index = next(i for i,p in enumerate(payloads,1) if p['config']['tournament_type']=='SATELLITE')
        sat = payloads[sat_index-1]['config']
        call(sat_index,{**sat,'satellite_target_id':event(300)},'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH')
        assert counts() == '12,12'
        ok('same event identity cannot be replayed against another satellite target')
        refused = json.loads(call(400,payloads[0]['config'],settings="SET test.frozen='true';"))
        assert refused['ok'] is False and refused['reason']=='platform_frozen' and counts()=='12,12'
        ok('purchase freeze refuses before creating either row')
        q("SET ROLE anon; SELECT public.fn_create_seat_first_game_atomic(null,null);",'permission denied')
        q("SET ROLE authenticated; SELECT public.fn_create_seat_first_game_atomic(null,null);",'permission denied')
        ok('browser roles cannot execute the creator')
        q("CREATE FUNCTION public.fixture_table_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_late_table_write'; END $$; CREATE TRIGGER fixture_table_failure BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION public.fixture_table_failure();")
        call(500,sat,'fixture_late_table_write')
        assert counts() == '12,12'
        assert q(f"SELECT count(*) FROM tournaments WHERE id='{event(500)}';")=='0'
        ok('late table insertion failure rolls back the tournament row too')
        assert q(pin) == baseline['source_md5']
        ok('qualification did not replace the production creator body')
        result['ok'] = True
    except BaseException as error:
        result['ok'] = False
        result['failure'] = str(error)
        raise
    finally:
        try:
            if started:
                command([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'immediate', '-w', 'stop'])
                result['cluster_stopped'] = not (cluster / 'postmaster.pid').exists()
            if cluster.exists():
                shutil.rmtree(cluster)
            if sock.exists():
                shutil.rmtree(sock)
            result['cluster_removed'] = not cluster.exists() and not sock.exists()
        finally:
            (root / 'results.json').write_text(json.dumps(result,indent=2)+'\n')
            print(str(root / 'results.json'),flush=True)
