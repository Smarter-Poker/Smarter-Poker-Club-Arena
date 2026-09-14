#!/usr/bin/env python3
"""Scoped native mystery creation and activation locks; no production URL.

Uses captured creator/contract guard with explicit auth/delegated-creation
stand-ins. This is not a funded ledger, HTTP, dealer or provider certificate.
"""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, time

repo = Path(__file__).resolve().parents[2]
fixtures = repo / 'scripts/dev/fixtures/mystery-creation'
baseline = json.loads((fixtures / 'baseline.json').read_text())['authorities']
migration = next((repo / 'supabase/migrations').glob('*_mystery_options_commit_with_tournament_creation.sql'))
pg = Path(os.environ['POKER_AUDIT_PG_BIN']) if os.environ.get('POKER_AUDIT_PG_BIN') else Path(subprocess.check_output(['brew','--prefix','postgresql@17'],text=True).strip())/'bin'
owned = Path(tempfile.mkdtemp(prefix='ca-mc-')); cluster=owned/'db'; sock=owned/'s'; sock.mkdir()
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=str(35000+os.getpid()%10000), PGUSER='postgres', PGDATABASE='postgres')
club='ca270000-0000-4000-8000-000000000001'; user='ca270000-0000-4000-8000-000000000002'
custom={'type':'mystery_bounty','payoutPercent':20,'mysteryBountyProfile':'jackpot','mysteryBountyActivation':'player_count','mysteryBountyActivationValue':12,'mysteryBountyPoolPercent':66.6,'mysteryBountyTopPercent':30}
expected={'mystery_bounty_profile':'jackpot','mystery_bounty_activation':'player_count','mystery_bounty_activation_value':12,'mystery_bounty_pool_percent':66.6,'mystery_bounty_regular_pool_percent':33.4,'mystery_bounty_top_percent':30}
psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1']
passed=[]; started=False; children=[]
def lit(value): return "'"+json.dumps(value).replace("'","''")+"'"
with (owned/'results.log').open('w') as log:
    def q(sql,error=None):
        r=subprocess.run(psql,input=sql+'\n',capture_output=True,text=True,env=env,timeout=20)
        log.write(r.stdout+r.stderr);log.flush()
        if error: assert r.returncode and error in r.stderr,r.stderr
        else: assert r.returncode==0,r.stderr
        return r.stdout.strip()
    def ok(label): passed.append(label);print('PASS '+label,flush=True)
    def call(config,uid=user,allowed=True,mode='',error=None):
        return q(f"SET ROLE authenticated; SET test.uid='{uid}'; SET test.allowed='{str(allowed).lower()}'; SET test.mode='{mode}'; SELECT fn_create_tournament('{club}',{lit(config)});",error)
    def reset(): q('TRUNCATE tournaments,tournament_players,creation_effects;')
    def no_effects(): assert q('SELECT (SELECT count(*) FROM tournaments)+(SELECT count(*) FROM creation_effects);')=='0'
    def start_sql(sql):
        child=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
        children.append(child);child.stdin.write(sql+'\n');child.stdin.close();return child
    try:
        assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
        subprocess.run([str(pg/'initdb'),'-D',str(cluster),'-U','postgres','--auth=trust','--no-locale'],stdout=log,stderr=log,check=True,timeout=40)
        subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f"-k {sock} -p {env['PGPORT']} -c listen_addresses=",'-w','start'],stdout=log,stderr=log,check=True,timeout=40);started=True
        q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA extensions;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.role',true),''),'authenticated')$$;
        CREATE FUNCTION fn_can_create_games(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.allowed',true)='true'$$;
        CREATE FUNCTION is_club_admin(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
        CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,payout_percent smallint DEFAULT 10,status text DEFAULT 'REGISTERING',
          is_mystery_bounty boolean DEFAULT false,mystery_bounty_stage text DEFAULT 'pending',
          mystery_bounty_profile text DEFAULT 'classic',mystery_bounty_activation text DEFAULT 'at_the_money',
          mystery_bounty_activation_value numeric,mystery_bounty_pool_percent numeric DEFAULT 50,
          mystery_bounty_regular_pool_percent numeric DEFAULT 50,mystery_bounty_top_percent numeric DEFAULT 20);
        CREATE TABLE tournament_players(tournament_id uuid,user_id uuid);
        CREATE TABLE creation_effects(id uuid);
        CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
        CREATE FUNCTION fn_create_tournament_governed_legacy(p_club_id uuid,p_config jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
        DECLARE event uuid:=gen_random_uuid();
        BEGIN
          IF p_config->>'fixture'='refused' THEN RETURN jsonb_build_object('success',false,'error','fixture_refused'); END IF;
          INSERT INTO tournaments(id,club_id,is_mystery_bounty) VALUES(event,p_club_id,p_config->>'type'='mystery_bounty');
          INSERT INTO creation_effects VALUES(event);
          RETURN jsonb_build_object('success',true,'tournament_id',event,'buy_in',4.5,'buy_in_fee',0.5);
        END $$;
        CREATE FUNCTION fixture_contract_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('test.mode',true)='write_failure' THEN RAISE EXCEPTION 'fixture write failed'; END IF;
          IF current_setting('test.mode',true)='write_skipped' THEN RETURN NULL; END IF;
          IF current_setting('test.mode',true)='write_replaced' THEN NEW.mystery_bounty_profile:='balanced'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fixture_write BEFORE UPDATE OF mystery_bounty_profile ON tournaments FOR EACH ROW EXECUTE FUNCTION fixture_contract_write();
        CREATE FUNCTION fixture_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('test.mode',true)='after_write' AND pg_trigger_depth()=1 THEN
            UPDATE tournaments SET mystery_bounty_top_percent=11 WHERE id=NEW.id;
          END IF; RETURN NEW;
        END $$;
        CREATE TRIGGER fixture_after AFTER UPDATE OF mystery_bounty_profile ON tournaments FOR EACH ROW EXECUTE FUNCTION fixture_after_write();
        """)
        q((fixtures/'managed-contract.sql').read_text())
        q((fixtures/'managed-lifecycle.sql').read_text())
        q('CREATE TRIGGER trg_tournaments_managed_lifecycle_guard BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle();')
        for name in ['fn_guard_registered_tournament_contract()','fn_create_tournament(uuid,jsonb)','fn_apply_mystery_bounty_config(uuid,jsonb)']:
            q(next(row['definition'] for row in baseline if row['name']==name))
        q('CREATE TRIGGER registered_contract BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_registered_tournament_contract(); REVOKE ALL ON FUNCTION fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_create_tournament(uuid,jsonb) TO authenticated,service_role;')
        metadata="SELECT jsonb_build_array(proacl,proconfig,proowner,prosecdef,prolang)::text FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure;"
        before=q(metadata)
        call(custom); assert q('SELECT mystery_bounty_profile FROM tournaments;')=='classic'
        print('REPRODUCED original creator acknowledged custom options but stored defaults',flush=True);reset()
        q(migration.read_text());q(migration.read_text());assert q(metadata)==before
        actual=q("SELECT pg_get_functiondef('public.fn_create_tournament(uuid,jsonb)'::regprocedure);")
        assert actual.strip()==(fixtures/'candidate.sql').read_text().strip()
        ok('repeatable migration, exact creator postimage, preserved authority metadata')
        for cfg,document in [(custom,expected),({'type':'mystery_bounty'},dict(expected,mystery_bounty_profile='classic',mystery_bounty_activation='at_the_money',mystery_bounty_activation_value=None,mystery_bounty_pool_percent=50,mystery_bounty_regular_pool_percent=50,mystery_bounty_top_percent=20))]:
            reset();receipt=json.loads(call(cfg));assert receipt['mystery_config']==document
            assert receipt['buy_in']==4.5 and receipt['buy_in_fee']==0.5
            assert receipt['tournament_id']==q('SELECT id FROM tournaments;')
            ok('atomic custom/default exact terms, decimal complement, unchanged entry receipt')
        invalid=[{'mysteryBountyProfile':'other'},{'mysteryBountyActivation':'never'},
          {'mysteryBountyActivationValue':2.5},{'mysteryBountyActivationValue':True},
          {'mysteryBountyPoolPercent':'50'},{'mysteryBountyPoolPercent':100.1},
          {'mysteryBountyPoolPercent':66.666},{'mysteryBountyTopPercent':0},
          {'mysteryBountyActivation':'percent_field','mysteryBountyActivationValue':101}]
        for delta in invalid:
            reset();call(dict(custom,**delta),error='Invalid mystery bounty');no_effects()
        ok('nine malformed selected contracts refuse with no delegated effects')
        for mode,err in [('write_failure','fixture write failed'),('write_skipped','does not identify'),('write_replaced','not persisted'),('after_write','not persisted')]:
            reset();call(custom,mode=mode,error=err);no_effects()
        ok('failed, skipped, changed and AFTER-trigger writes roll back event and effects')
        reset();assert json.loads(call(custom,uid=''))['error']=='not_authenticated';no_effects()
        assert json.loads(call(custom,allowed=False))['error']=='not_authorised';no_effects()
        assert json.loads(call(dict(custom,fixture='refused')))['error']=='fixture_refused';no_effects()
        q(f"SET ROLE anon; SELECT fn_create_tournament('{club}',{lit(custom)});",'permission denied')
        ok('authentication, club permission, delegated refusal and anonymous denial preserved')
        reset();receipt=json.loads(call({'type':'mtt','payoutPercent':15}));assert 'mystery_config' not in receipt
        assert q('SELECT payout_percent FROM tournaments;')=='15';ok('ordinary MTT paid depth and creation are unchanged')
        reset();eid=json.loads(call(custom))['tournament_id'];q(f"INSERT INTO tournament_players VALUES('{eid}','{user}');")
        q(f"SET ROLE authenticated; SET test.uid='{user}'; UPDATE tournaments SET mystery_bounty_top_percent=25 WHERE id='{eid}';",'permission denied')
        # Direct browser UPDATE is not granted; invoke the actual definer guard under a fixture owner write.
        q(f"SET test.uid='{user}'; UPDATE tournaments SET mystery_bounty_top_percent=25 WHERE id='{eid}';",'cannot be modified')
        ok('captured registered-contract guard rejects post-registration edits')
        q(f"DELETE FROM tournament_players; UPDATE tournaments SET mystery_bounty_stage='active' WHERE id='{eid}';")
        for patch in ["mystery_bounty_top_percent=25","is_mystery_bounty=false"]:
            q(f"UPDATE tournaments SET {patch} WHERE id='{eid}';",'cannot change after activation')
        q(f"UPDATE tournaments SET payout_percent=15 WHERE id='{eid}';")
        ok('active inventory rejects metadata edits and format disabling; unrelated progress allowed')
        reset();eid=json.loads(call(custom))['tournament_id']
        holder=start_sql(f"SET application_name='mystery_activation_holder'; BEGIN; UPDATE tournaments SET mystery_bounty_stage='active' WHERE id='{eid}'; SELECT pg_sleep(1.5); COMMIT;")
        for _ in range(80):
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='mystery_activation_holder' AND wait_event='PgSleep';")=='1':break
            time.sleep(0.02)
        else:raise AssertionError('activation holder did not enter its owned wait')
        rival=start_sql(f"SET application_name='mystery_config_rival'; SET ROLE authenticated; SET test.uid='{user}'; SET test.allowed='true'; SELECT fn_apply_mystery_bounty_config('{eid}', '{{\"topPercent\":25}}');")
        for _ in range(80):
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='mystery_config_rival' AND wait_event_type='Lock';")=='1':break
            time.sleep(0.02)
        else:raise AssertionError('configuration rival never waited on the exact row')
        holder.wait(timeout=10);rival.wait(timeout=10);assert holder.returncode==0
        assert rival.returncode!=0 and 'cannot change after activation' in rival.stderr.read()
        assert q(f"SELECT mystery_bounty_top_percent FROM tournaments WHERE id='{eid}';")=='30'
        ok('actual concurrent activation wins row lock and captured legacy configuration setter rolls back')
        q(actual.replace('  v_saved_pct smallint;','  v_saved_pct integer;'))
        q(migration.read_text(),'Unreviewed tournament creator source')
        ok('unreviewed creator source refuses the complete migration transaction')
    finally:
        for child in children:
            if child.poll() is None:child.terminate();child.wait(timeout=10)
        if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','fast','-w','stop'],stdout=log,stderr=log,check=True,timeout=30)
        shutil.rmtree(cluster,ignore_errors=True)
(owned/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'cluster_removed':not cluster.exists(),'scope':'Captured wrapper/registered guard and actual migration; explicit auth and delegated-create stand-ins, no money/provider/dealer proof'},indent=2)+'\n')
print(f'{len(passed)} groups passed; evidence: {owned / "results.json"}',flush=True)
