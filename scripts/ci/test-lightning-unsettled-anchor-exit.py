#!/usr/bin/env python3
"""Real PostgreSQL stop/reaper/live-hand/anchor guards; no production writes.

Exact installed preimages are hash checked. Configuration and RG eligibility
are explicit fixture boundaries. Terminal instance states are supplied directly;
this verifies departure ownership, not a substitute settlement implementation.
"""
import argparse, json, os, pathlib, shutil, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT/'artifacts/lightning-unsettled-anchor')
out = parser.parse_args().output
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = pathlib.Path(tempfile.mkdtemp(prefix='lua-'))
sock = cluster/'s'; sock.mkdir()
owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
if owner: shutil.chown(cluster, 'postgres'); shutil.chown(sock, 'postgres')
env = dict(os.environ, LC_ALL='C', LANG='C')
psql = [pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '55849', '-U', 'postgres', '-d', 'postgres']
checks = []
def cmd(args, sql=None, fail=False):
    p = subprocess.run(list(map(str,args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if (p.returncode != 0) != fail: raise RuntimeError(p.stdout+p.stderr)
    return p.stdout.strip()
def q(sql, fail=False): return cmd(psql, sql, fail)
def check(name, passed):
    checks.append({'name': name, 'passed': bool(passed)})
    if not passed: raise AssertionError(name)
def uid(n): return f'00000000-0000-4000-8000-{n:012d}'
C,U,S,P,H,T,R = [uid(n) for n in range(1,8)]
def reset(fold='normal', reservation='released', state='dealing'):
    q(f"""TRUNCATE cash_games,table_seats,lightning_pool_session,lightning_pool_slot,
      lightning_instance,lightning_reservation,lightning_hand_player,cash_cluster_events,responsible_gaming_limits;
      INSERT INTO cash_games VALUES('{C}','lightning');
      INSERT INTO table_seats VALUES('{S}','{T}','{U}',NULL,now(),160.52);
      INSERT INTO lightning_pool_session VALUES('{P}','{C}',1,'{U}','{S}','active',now(),NULL,NULL,NULL,NULL,NULL,NULL,now());
      INSERT INTO lightning_pool_slot VALUES('{R}','{P}',now(),NULL,NULL,now());
      INSERT INTO lightning_instance VALUES('{H}','{H}','{C}','{state}',now());
      INSERT INTO lightning_reservation VALUES('{H}','{C}','{U}','{reservation}');
      INSERT INTO lightning_hand_player VALUES('{H}','{U}','{fold}',now(),1,160.52);
      SELECT set_config('test.uid','{U}',false);""")
def stop(): return json.loads(q(f"SELECT set_config('test.uid','{U}',false); SELECT fn_lightning_stop_playing('{C}')").splitlines()[-1])
def reap(): return json.loads(q(f"SELECT fn_lightning_reap_expired_disconnects('{C}',clock_timestamp(),200)"))
def is_open(): return q('SELECT exited_at IS NULL FROM lightning_pool_session') == 't'
started = False
try:
    cmd(owner+[pg/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    cmd(owner+[pg/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55849 -c listen_addresses='' -c shared_buffers=16MB",'-w','start']); started=True
    q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
      CREATE TABLE cash_games(id uuid PRIMARY KEY,cluster_mode text);
      CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,left_at timestamptz,joined_at timestamptz,stack numeric);
      CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY,cluster_id uuid,cluster_epoch integer,player_id uuid,anchor_seat_id uuid,state text,entered_at timestamptz,exited_at timestamptz,exit_reason text,stop_requested_at timestamptz,disconnected_at timestamptz,ending_stack numeric,unused text,updated_at timestamptz);
      CREATE TABLE lightning_pool_slot(id uuid,pool_session_id uuid,opened_at timestamptz,closed_at timestamptz,close_reason text,updated_at timestamptz);
      CREATE TABLE lightning_instance(id uuid PRIMARY KEY,hand_id uuid,cluster_id uuid,state text,created_at timestamptz);
      CREATE TABLE lightning_reservation(lightning_instance_id uuid,cluster_id uuid,player_id uuid,state text);
      CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,fold_type text,folded_at timestamptz,committed_at_fold numeric,stack_before numeric);
      CREATE TABLE lightning_settlement_marker(txid xid8,seat_id uuid);
      CREATE TABLE responsible_gaming_limits(user_id uuid);
      CREATE TABLE cash_cluster_events(game_id uuid,table_id uuid,kind text,payload jsonb,cluster_epoch integer);
      CREATE FUNCTION fn_lightning_config(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"disconnect_timeout_ms":1000}'::jsonb$$;
      CREATE FUNCTION fn_rg_require_not_excluded(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":false}'::jsonb$$;
      SET check_function_bodies=off;''')
    defs = json.loads((ROOT/'scripts/ci/fixtures/lightning-unsettled-anchor-preimages.json').read_text())
    for d in defs:
        q('SET check_function_bodies=off;'+d['definition'])
        sig = d['proname']+'('+','.join(x.strip().split(' ',1)[1] for x in d['args'].split(','))+')' if d['args'] else d['proname']+'()'
        check('exact-preimage-'+d['proname'], q(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure))") == d['md5'])
    q("CREATE TRIGGER anchor_delete BEFORE DELETE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard(); CREATE TRIGGER anchor_update BEFORE UPDATE OF stack,left_at,user_id ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();")
    q('REVOKE ALL ON FUNCTION fn_lightning_stop_playing(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_lightning_stop_playing(uuid) TO authenticated,service_role; REVOKE ALL ON FUNCTION fn_lightning_reap_expired_disconnects(uuid,timestamptz,integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION fn_lightning_reap_expired_disconnects(uuid,timestamptz,integer) TO service_role;')
    acl_sql = "SELECT jsonb_agg(jsonb_build_array(proname,proowner,proacl,prosecdef,proconfig) ORDER BY proname) FROM pg_proc WHERE oid IN ('fn_lightning_stop_playing(uuid)'::regprocedure,'fn_lightning_reap_expired_disconnects(uuid,timestamptz,integer)'::regprocedure)"
    original_acl = q(acl_sql)
    reset(); r=stop(); check('RED-before-stop-closes-released-folder',r['exited'] and not is_open())
    q('DELETE FROM table_seats'); check('RED-before-closed-session-loses-anchor',q('SELECT count(*) FROM table_seats')=='0')
    reset(); q('UPDATE lightning_pool_session SET stop_requested_at=now()'); check('RED-before-reaper-closes-released-folder',reap()['expired']==1 and not is_open())
    migration = list((ROOT/'supabase/migrations').glob('*_lightning_retains_the_anchor_until_every_original_hand_is_te*.sql'))
    if len(migration)!=1: raise RuntimeError('one exact anchor-exit migration required')
    q(migration[0].read_text())
    check('unchanged-owner-acl-security-and-search-path',q(acl_sql)==original_acl)
    for fold in ['normal','fast']:
        for terminal in ['complete','abandoned']:
            reset(fold); r=stop(); check(f'{fold}-{terminal}-stop-retains-live-anchor',not r['exited'] and is_open())
            check(f'{fold}-{terminal}-reaper-retains-live-anchor',reap()['expired']==0 and is_open())
            q('DELETE FROM table_seats',True); q('UPDATE table_seats SET stack=0',True)
            check(f'{fold}-{terminal}-guards-still-protect-anchor',q('SELECT stack FROM table_seats')=='160.52')
            # Supply the original settlement's private marker only in the
            # disposable fixture. An abandoned hand never performs this debit.
            if terminal=='complete':
                q(f"BEGIN; INSERT INTO lightning_settlement_marker VALUES(pg_current_xact_id(),'{S}'); UPDATE table_seats SET stack=159.52; DELETE FROM lightning_settlement_marker; COMMIT;")
            q(f"UPDATE lightning_instance SET state='{terminal}'")
            check(f'{fold}-{terminal}-terminal-exit-once',reap()['expired']==1 and not is_open() and reap()['expired']==0)
            check(f'{fold}-{terminal}-exit-keeps-final-authoritative-stack',q('SELECT ending_stack FROM lightning_pool_session')==('159.52' if terminal=='complete' else '160.52'))
            check(f'{fold}-{terminal}-idempotent-stop',stop()['exited'] and q("SELECT count(*) FROM cash_cluster_events WHERE kind='pool_player_left'")=='1')
    for reservation in ['pending','committed']:
        reset('none',reservation,'forming'); q('DELETE FROM lightning_hand_player')
        check(reservation+'-reservation-still-protected',not stop()['exited'] and reap()['expired']==0 and is_open())
    reset('fast'); stop()
    h2=uid(20)
    q(f"INSERT INTO lightning_instance VALUES('{h2}','{h2}','{C}','dealing',now()); INSERT INTO lightning_hand_player VALUES('{h2}','{U}','normal',now(),2,159.52); UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
    check('earlier-completion-retains-second-original-hand',reap()['expired']==0 and is_open())
    q(f"UPDATE lightning_instance SET state='abandoned' WHERE id='{h2}'")
    check('last-original-terminal-permits-exit',reap()['expired']==1 and not is_open())
    for reason in ['disconnect','rg']:
        reset('fast');
        if reason=='disconnect': q("UPDATE lightning_pool_session SET disconnected_at=now()-interval '1 minute'")
        else: q(f"INSERT INTO responsible_gaming_limits VALUES('{U}')")
        check(reason+'-retains-unsettled-folder',reap()['expired']==0 and is_open())
        q("UPDATE lightning_instance SET state='complete'")
        check(reason+'-exits-after-terminal',reap()['expired']==1 and not is_open())
    reset(); q("UPDATE cash_games SET cluster_mode='frozen'; UPDATE lightning_instance SET state='complete'")
    check('frozen-evidence-remains-protected',not stop()['exited'] and reap()['expired']==0 and is_open())
    for line in migration[0].read_text().splitlines():
        if line.startswith('-- @live-proof: '): check('installed-'+line[16:55],q('SELECT '+line[16:])=='t')
    q(migration[0].read_text(),True)
    check('migration-replay-refuses-without-changing-authority',q(acl_sql)==original_acl)
    print(json.dumps({'checks':checks,'production_mutations':False},indent=2))
finally:
    (out/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2)+'\n')
    if started: cmd(owner+[pg/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
