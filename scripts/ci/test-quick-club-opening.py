#!/usr/bin/env python3
"""Exercise the actual current opening function before/after reserve-reuse repair."""
import os, re, subprocess, tempfile, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
WORK=Path(os.environ.get('QUICK_CLUB_TEST_WORK', '/Volumes/SmarterWork/agent-work' if Path('/Volumes/SmarterWork').is_mount() else tempfile.gettempdir()))
if os.uname().sysname == 'Darwin' and not Path('/Volumes/SmarterWork').is_mount():
 raise RuntimeError('SmarterWork SSD Must Be Mounted')
cluster=Path(tempfile.mkdtemp(prefix='opening-pg-',dir=WORK)); sock=cluster/'socket';sock.mkdir()
port='55483'
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
def command(args,sql=None):
 r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=60)
 if r.returncode: raise RuntimeError(r.stderr[-4000:])
 return r.stdout.strip()
def sql(s):return command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p',port,'-U','postgres','-d','postgres'],s)
try:
 command([PG/'initdb','-D',cluster/'data','-U','postgres','--auth=trust','--no-locale'])
 command([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'postgres.log','-o',f'-k {sock} -p {port} -h 127.0.0.1','-w','start'])
 base=(ROOT/'supabase/migrations/20261021174448_midway_cash_rake_policy_two_point_five_bb.sql').read_text()
 definition=base.split('EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup',1)[1].split('$definition$;',1)[0]
 definition='CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup'+definition
 schema='''CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.sub',true)::uuid$$;
 CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS $$SELECT ARRAY[]::text[]$$;
 CREATE TABLE clubs(id uuid PRIMARY KEY, owner_id uuid,club_id bigint,is_union boolean DEFAULT false,union_id uuid,chip_treasury numeric,promo_balance numeric DEFAULT 0,tagline text,default_rake_percent numeric,rake_cap numeric,bbj_enabled boolean,bbj_rake_enabled boolean,spins_enabled boolean,spins_preseed_amount numeric,spins_wallet_funding text,updated_at timestamptz);
 CREATE TABLE promotions(id uuid PRIMARY KEY);
 CREATE TABLE club_welcome_package_receipts(club_id uuid PRIMARY KEY,economics jsonb);
 CREATE TABLE leaderboard_reward_program_versions(club_id uuid,version integer);
 CREATE FUNCTION fn_spin_required_seed(numeric) RETURNS numeric LANGUAGE sql AS $$SELECT 200::numeric$$;
 CREATE FUNCTION fn_spin_activate(uuid,numeric,numeric,text,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN UPDATE clubs SET chip_treasury=chip_treasury-$2 WHERE id=$1; RETURN jsonb_build_object('ok',true,'balance',$2);END$$;
 CREATE FUNCTION fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":true}'::jsonb$$;
 CREATE TABLE bbj_pools(id uuid DEFAULT gen_random_uuid(),club_id uuid,union_id uuid,main_balance numeric,backup_balance numeric,promo_balance numeric,pool_amount numeric,status text,created_at timestamptz DEFAULT now(),updated_at timestamptz);
 '''
 original=(ROOT/'supabase/migrations/20260901073000_club_opening_setup_wizard.sql').read_text()
 tables=original[original.index('CREATE TABLE IF NOT EXISTS public.club_opening_setups'):original.index('ALTER TABLE public.club_opening_setups ENABLE')]
 tables=re.sub(r'REFERENCES public\.\w+\(id\) ON DELETE (?:CASCADE|RESTRICT|SET NULL)','',tables)
 sql(schema+tables+definition)
 actor='11111111-1111-4111-8111-111111111111';club='22222222-2222-4222-8222-222222222222';op='33333333-3333-4333-8333-333333333333'
 sql(f"INSERT INTO clubs(id,owner_id,club_id,chip_treasury) VALUES('{club}','{actor}',123,99700); INSERT INTO club_welcome_package_receipts VALUES('{club}','{{\"bbj_seed\":100,\"spin_seed\":200,\"spin_max_stake\":1}}'); INSERT INTO bbj_pools(club_id,main_balance,status) VALUES('{club}',100,'active');")
 call=f"SELECT fn_complete_club_opening_setup('{club}','{op}','Good Friends. Great Poker.',-1,-1,true,100,true,200,1,false,'high_hand','','',0,false,'profit',0,false);"
 before=sql(f"BEGIN; SET LOCAL request.jwt.claim.sub='{actor}'; {call} SELECT chip_treasury FROM clubs WHERE id='{club}'; ROLLBACK;")
 assert '99400' in before, before
 print('FAIL-BEFORE reproduced: funded welcome club debited 300 again')
 migration=ROOT/'supabase/migrations/20261022201306_restore_welcome_reserve_reuse_for_quick_club_opening.sql'
 sql(migration.read_text())
 after=sql(f"SET request.jwt.claim.sub='{actor}'; {call} SELECT chip_treasury||'|'||(SELECT main_balance FROM bbj_pools WHERE club_id='{club}')||'|'||(SELECT count(*) FROM club_opening_setup_funding) FROM clubs WHERE id='{club}';")
 assert '99700|100|0' in after,after
 assert '"allocated": 0' in after,after
 replay=sql(f"SET request.jwt.claim.sub='{actor}'; {call} SELECT chip_treasury FROM clubs WHERE id='{club}';")
 assert '"already_completed": true' in replay and '99700' in replay,replay
 try:sql(f"SET request.jwt.claim.sub='44444444-4444-4444-8444-444444444444'; {call}")
 except RuntimeError as e:assert 'Only The Club Owner' in str(e)
 else:raise AssertionError('non-owner accepted')
 assert sql('SELECT fn_club_opening_defaults_ready()') == 't'
 assert sql("SELECT has_function_privilege('anon','fn_club_opening_defaults_ready()','EXECUTE')||'|'||has_function_privilege('authenticated','fn_club_opening_defaults_ready()','EXECUTE')") == 'false|true'
 second='55555555-5555-4555-8555-555555555555'
 sql(f"INSERT INTO clubs(id,owner_id,club_id,chip_treasury) VALUES('{second}','{actor}',124,99700); INSERT INTO club_welcome_package_receipts VALUES('{second}','{{\"bbj_seed\":100,\"spin_seed\":200,\"spin_max_stake\":1}}');")
 mismatch=call.replace(club,second).replace('true,100,true','true,500,true')
 try:sql(f"SET request.jwt.claim.sub='{actor}'; {mismatch}")
 except RuntimeError as e:assert 'Reuse Their Recorded Baseline' in str(e)
 else:raise AssertionError('mismatched welcome seed accepted')
 assert sql(f"SELECT chip_treasury FROM clubs WHERE id='{second}'") == '99700'
 print('PASS-AFTER: zero additional debit/funding rows, replay unchanged, non-owner and mismatched seeds refused, capability/ACL verified')
finally:
 subprocess.run([str(PG/'pg_ctl'),'-D',str(cluster/'data'),'-m','immediate','stop'],capture_output=True)
 shutil.rmtree(cluster)
