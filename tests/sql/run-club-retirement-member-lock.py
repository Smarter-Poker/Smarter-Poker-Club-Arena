#!/usr/bin/env python3
"""Current retained retirement authority against the real compound membership key."""
import os, subprocess, tempfile, shutil, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
scratch = Path(tempfile.mkdtemp(prefix='cr-', dir=os.environ.get('TMPDIR')))
socket = scratch / 's'; socket.mkdir()
port = '55754'
started = False
def command(args, sql=None):
    return subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True, timeout=60)
def query(sql, error=None):
    r = command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres'], sql)
    if error:
        assert r.returncode and error in r.stderr, r.stderr+r.stdout
    else:
        assert r.returncode == 0, r.stderr+r.stdout
    return r.stdout.strip()
owner='00000000-0000-4000-8000-000000000001'
club='10000000-0000-4000-8000-000000000001'
def retire():
    return f"SELECT public.fn_retire_settled_club_core_20260906('{club}','Fixture','qualification');"
try:
    r=command([PG/'initdb','-D',scratch/'d','-U','postgres','--auth=trust','--no-locale']); assert r.returncode == 0, r.stderr
    r=command([PG/'pg_ctl','-D',scratch/'d','-l',scratch/'pg.log','-o',f'-k {socket} -p {port} -h ""','-w','start']); assert r.returncode == 0,r.stderr
    started=True
    query("CREATE SCHEMA auth; CREATE ROLE service_role NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;")
    query("""CREATE TABLE clubs(id uuid PRIMARY KEY,name text,owner_id uuid,lifecycle_status text DEFAULT 'active',retired_at timestamptz,retired_by uuid,retirement_reason text,is_public boolean DEFAULT false,requires_approval boolean DEFAULT true,updated_at timestamptz,union_id uuid,is_union boolean DEFAULT false);
CREATE TABLE unions(id uuid PRIMARY KEY); CREATE TABLE union_clubs(id uuid PRIMARY KEY,club_id uuid,union_id uuid);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY);
CREATE TABLE tournament_players(id uuid PRIMARY KEY,tournament_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE club_wallets(id uuid PRIMARY KEY,club_id uuid);
CREATE TABLE club_diamond_wallets(club_id uuid PRIMARY KEY); CREATE TABLE bbj_pools(club_id uuid PRIMARY KEY);
CREATE TABLE spin_bonus_pools(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE club_opening_setups(club_id uuid PRIMARY KEY);
CREATE TABLE promo_vault_inventory(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE cashout_requests(id uuid PRIMARY KEY,club_id uuid);
CREATE TABLE chip_requests(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE chip_escrow_holds(id uuid PRIMARY KEY,club_id uuid);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY,club_id uuid); CREATE TABLE settlement_periods(id uuid PRIMARY KEY,club_id uuid);
CREATE TABLE credit_invoices(id uuid PRIMARY KEY,agent_id uuid); CREATE TABLE chip_escrow(id uuid PRIMARY KEY,cashout_request_id uuid);
CREATE TABLE fixture_impact(value jsonb); INSERT INTO fixture_impact VALUES('{}');
CREATE FUNCTION fn_club_retirement_impact(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM fixture_impact$$;
CREATE TABLE audit_trail(actor_id uuid,actor_role text,action text,target_type text,target_id uuid,club_id uuid,before_state jsonb,after_state jsonb,reason text);
CREATE TABLE fixture_events(kind text);
CREATE FUNCTION fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb) RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_events VALUES($1)$$;
""")
    query((ROOT/'tests/sql/fixtures/club-retirement-member-lock-authority.sql').read_text())
    query('REVOKE ALL ON FUNCTION fn_retire_settled_club_core_20260906(uuid,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_retire_settled_club_core_20260906(uuid,text,text) TO service_role;')
    query(f"INSERT INTO clubs(id,name,owner_id) VALUES('{club}','Fixture','{owner}'); INSERT INTO club_members VALUES('{club}','{owner}');")
    query(f"SET request.jwt.claim.sub='{owner}';"+retire(), 'column "id" does not exist')
    assert query('SELECT lifecycle_status FROM clubs')=='active'
    migration=list((ROOT/'supabase/migrations').glob('*_club_retirement_locks_the_current_member_identity.sql'))
    assert len(migration)==1, migration
    query(migration[0].read_text())
    query(migration[0].read_text(),'retirement core preimage changed')
    query('BEGIN; SET LOCAL ROLE authenticated;'+retire()+' ROLLBACK;', 'permission denied')
    for actor, name, impact, union, error in [
      ('', 'Fixture', {}, False, 'Authentication Required'),
      ('00000000-0000-4000-8000-000000000002','Fixture',{},False,'Only The Club Owner'),
      (owner,'Wrong',{},False,'name confirmation'),
      (owner,'Fixture',{},True,'Leave The Union'),
      *[(owner,'Fixture',{k:1},False,msg) for k,msg in [('running_tables','Close Every Running'),('active_tournaments','Complete Or Cancel'),('wallet_chips','Settle Every'),('diamonds','Redeem Or Transfer'),('inventory_items','Grant Or Resolve'),('open_obligations','Resolve Every')]],
    ]:
        claim=actor.replace("'","''"); payload=json.dumps(impact).replace("'","''")
        raw=query(f"BEGIN; SET LOCAL request.jwt.claim.sub='{claim}'; UPDATE clubs SET is_union={str(union).lower()}; UPDATE fixture_impact SET value='{payload}'; SELECT fn_retire_settled_club_core_20260906('{club}','{name}','qualification'); ROLLBACK;")
        result=json.loads(raw.splitlines()[-1]); assert result.get('success') is False and error.lower() in result.get('error','').lower(),result
        assert query('SELECT count(*) FROM audit_trail')=='0'
    result=json.loads(query(f"SET request.jwt.claim.sub='{owner}';"+retire()))
    assert result['success'] and result['records_retained']
    assert query('SELECT count(*) FROM club_members')=='1'
    assert query('SELECT count(*) FROM audit_trail')=='1'
    assert query('SELECT count(*) FROM fixture_events')=='1'
    replay=json.loads(query(f"SET request.jwt.claim.sub='{owner}';"+retire())); assert replay['already_retired']
    assert query('SELECT count(*) FROM audit_trail')=='1'
    print('PASS current core compound membership lock; preimage/refusals/retained retirement/replay/ACL')
    print(query("SELECT md5(pg_get_functiondef('public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure));"))
finally:
    if started:
        r=command([PG/'pg_ctl','-D',scratch/'d','-m','fast','-w','stop']); assert r.returncode==0,r.stderr
    if not (scratch/'d/postmaster.pid').exists(): shutil.rmtree(scratch)
