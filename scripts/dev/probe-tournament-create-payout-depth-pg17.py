#!/usr/bin/env python3
"""Native wrapper contract, using explicit authorization/creator stand-ins.

No production URL is accepted. Exercises actual SQL receipt handling and
transaction rollback, not underlying financial creation or tournament play.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import hashlib

repo = Path(__file__).resolve().parents[2]
fixtures = repo / 'scripts/dev/fixtures/tournament-create-payout-depth'
baseline = json.loads((fixtures / 'baseline.json').read_text())
migration = next((repo / 'supabase/migrations').glob('*_tournament_creator_keeps_selected_payout_depth.sql'))
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-cp-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='postgres', PGDATABASE='postgres')
club = 'c4000000-0000-4000-8000-000000000001'
user = 'c4000000-0000-4000-8000-000000000002'
other = 'c4000000-0000-4000-8000-000000000003'
passed = []
started = False
with (root / 'results.log').open('w') as log:
    def command(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)

    def q(sql, error=None):
        with tempfile.TemporaryFile(mode='w+') as request:
            request.write(sql + '\n')
            request.seek(0)
            result = subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                                    stdin=request, capture_output=True, text=True, env=env, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def ok(name):
        passed.append(name)
        print('PASS ' + name, flush=True)

    def call(config, uid=user, allowed=True, error=None, mode=''):
        payload = json.dumps(config).replace("'", "''")
        return q(f"SET ROLE authenticated; SET test.uid='{uid}'; SET test.allowed='{str(allowed).lower()}'; SET test.mode='{mode}'; SELECT public.fn_create_tournament('{club}','{payload}');", error)

    def reset():
        q('TRUNCATE tournaments, creation_effects;')

    def no_effects():
        assert q('SELECT (SELECT count(*) FROM tournaments)+(SELECT count(*) FROM creation_effects);') == '0'

    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        command([str(pg / 'initdb'), '-D', str(cluster), '-U', 'postgres', '--auth=trust', '--no-locale'])
        command([str(pg / 'pg_ctl'), '-D', str(cluster), '-o', f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
          CREATE SCHEMA auth; CREATE SCHEMA extensions;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
          CREATE FUNCTION public.fn_can_create_games(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.allowed',true)='true'$$;
          CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid,payout_percent smallint DEFAULT 10 CHECK(payout_percent IN(10,15,20)));
          CREATE TABLE public.creation_effects(event_id uuid);
          CREATE FUNCTION public.fn_create_tournament_governed_legacy(p_club_id uuid,p_config jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
          DECLARE event uuid:=gen_random_uuid(); response jsonb;
          BEGIN
            IF p_config->>'receipt'='refusal' THEN RETURN jsonb_build_object('success',false,'error','fixture_refusal'); END IF;
            INSERT INTO public.tournaments(id,club_id) VALUES(event,CASE WHEN p_config->>'receipt'='wrong_club' THEN 'c4000000-0000-4000-8000-000000000003'::uuid ELSE p_club_id END);
            INSERT INTO public.creation_effects VALUES(event);
            response:=jsonb_build_object('success',true,'tournament_id',event,'buy_in',100,'buy_in_fee',10,'status','REGISTERING');
            IF p_config->>'receipt'='missing_id' THEN RETURN response-'tournament_id'; END IF;
            IF p_config->>'receipt'='bad_id' THEN RETURN response||jsonb_build_object('tournament_id','wrong'); END IF;
            IF p_config->>'receipt'='wrong_id' THEN RETURN response||jsonb_build_object('tournament_id',gen_random_uuid()); END IF;
            IF p_config->>'receipt'='legacy_id' THEN RETURN (response-'tournament_id')||jsonb_build_object('id',event); END IF;
            IF p_config->>'receipt'='null' THEN RETURN NULL; END IF;
            IF p_config->>'receipt'='missing_success' THEN RETURN response-'success'; END IF;
            IF p_config->>'receipt'='string_success' THEN RETURN response||jsonb_build_object('success','true'); END IF;
            RETURN response;
          END $$;
          CREATE FUNCTION public.fixture_contract_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF current_setting('test.mode',true)='write_failure' THEN RAISE EXCEPTION 'fixture contract failed'; END IF;
            IF current_setting('test.mode',true)='write_skipped' THEN RETURN NULL; END IF;
            IF current_setting('test.mode',true)='write_replaced' THEN NEW.payout_percent:=10; END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER fixture_contract_write BEFORE UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fixture_contract_write();
        """)
        q(baseline['definition'])
        q('REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid,jsonb) TO authenticated,service_role;')
        meta = "SELECT jsonb_build_array(proacl,proconfig,proowner,prosecdef,prolang)::text FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure;"
        before_meta = q(meta)
        assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure;") == baseline['source_md5']
        for depth in [15,20]:
            reset()
            assert json.loads(call({'payoutPercent': depth}))['success'] is True
            assert q('SELECT payout_percent FROM tournaments;') == '10'
            print(f'REPRODUCED old successful {depth}% request persisted 10%', flush=True)
        reset()
        call({'payoutPercent':20, 'receipt':'legacy_id'}, mode='write_failure')
        assert q('SELECT count(*) FROM creation_effects;') == '1'
        print('REPRODUCED old contract error swallowed after delegated insert', flush=True)
        reset()
        q(migration.read_text())
        q(migration.read_text())
        assert q(meta) == before_meta
        actual = q("SELECT pg_get_functiondef('public.fn_create_tournament(uuid,jsonb)'::regprocedure);")
        assert actual.strip() == (fixtures / 'candidate.sql').read_text().strip()
        ok('migration is repeatable and preserves owner grants search path and security')
        for depth in [10,15,20,'10','15','20',None,'',False,0,-1,25,'bad',{},[],999999999999999999999999]:
            reset()
            receipt = json.loads(call({'payoutPercent':depth}))
            expected = int(depth) if depth in [10,15,20,'10','15','20'] else 10
            assert q('SELECT payout_percent FROM tournaments;') == str(expected)
            assert receipt['success'] is True and receipt['buy_in']==100 and receipt['buy_in_fee']==10
            assert receipt['tournament_id'] == q('SELECT id FROM tournaments;')
            ok('selected depth or unchanged 10% fallback: '+repr(depth))
        reset()
        assert json.loads(call({}))['success'] is True
        assert q('SELECT payout_percent FROM tournaments;')=='10'
        ok('omitted depth retains default 10')
        for receipt,error in [('missing_id','no tournament_id'),('legacy_id','no tournament_id'),('bad_id','invalid input syntax'),('wrong_id','does not identify'),('wrong_club','does not identify'),('null','unconfirmed receipt'),('missing_success','unconfirmed receipt'),('string_success','unconfirmed receipt')]:
            reset()
            call({'payoutPercent':20,'receipt':receipt},error=error)
            no_effects()
            ok('unconfirmed '+receipt+' rolls delegated creation back')
        for mode,error in [('write_failure','fixture contract failed'),('write_skipped','does not identify'),('write_replaced','not persisted')]:
            reset()
            call({'payoutPercent':20},mode=mode,error=error)
            no_effects()
            ok(mode+' rolls all delegated effects back')
        reset()
        assert json.loads(call({},uid=''))['error']=='not_authenticated'
        no_effects()
        assert json.loads(call({},allowed=False))['error']=='not_authorised'
        no_effects()
        assert json.loads(call({'receipt':'refusal'}))['error']=='fixture_refusal'
        no_effects()
        q(f"SET ROLE anon; SELECT public.fn_create_tournament('{club}','{{}}');",'permission denied')
        ok('authentication club authorization delegated refusals and anon ACL remain intact')
        q(actual.replace('  v_saved_pct smallint;', '  v_saved_pct integer;'))
        q(migration.read_text(),'Unreviewed tournament creator source')
        ok('unreviewed source is refused without replacement')
        # R43: qualify the currently installed wrapper, whose later mystery
        # configuration additions are outside this non-mystery creator scope.
        current = json.loads((fixtures / 'current-sep14.json').read_text())
        assert hashlib.md5(current['definition'].split('$function$')[1].encode()).hexdigest() == current['body_md5']
        q(current['definition'] + ';')
        for kind in ['mtt', 'bounty', 'satellite']:
            for depth in [10, 15, 20]:
                reset()
                receipt = json.loads(call({'type':kind,'payoutPercent':depth}))
                assert receipt['success'] is True
                assert q('SELECT payout_percent FROM tournaments;') == str(depth)
                assert receipt['buy_in']==100 and receipt['buy_in_fee']==10
                ok(f'current installed wrapper persists manual {kind} depth {depth}')
        reset()
        assert json.loads(call({'type':'mtt'}))['success'] is True
        assert q('SELECT payout_percent FROM tournaments;') == '10'
        ok('current wrapper reproduces missing manual depth defaulting to10')
        for mode,error in [('write_failure','fixture contract failed'),('write_skipped','does not identify'),('write_replaced','not persisted')]:
            reset()
            call({'type':'mtt','payoutPercent':20},mode=mode,error=error)
            no_effects()
            ok('current wrapper preserves atomic rollback: '+mode)
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],stdout=log,stderr=log,check=True,timeout=30)
        shutil.rmtree(cluster,ignore_errors=True)

(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'scope':'Exact wrapper with controlled delegated creator and authorization; no actual financial creation or MTT gameplay'},indent=2)+'\n')
print(f'{len(passed)} groups passed; evidence: {root / "results.json"}')
