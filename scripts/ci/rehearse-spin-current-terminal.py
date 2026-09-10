#!/usr/bin/env python3
# This is an acceptance probe, not a rollout script. A terminal guard refusal is FAILURE.
from pathlib import Path
import re,hashlib,subprocess,json,datetime,argparse
parser=argparse.ArgumentParser(description='Reproduce the current Spin terminal acceptance gate in one local rollback transaction.')
parser.add_argument('--spin-source',type=Path,required=True)
parser.add_argument('--lane-source',type=Path,required=True)
parser.add_argument('--socket',type=Path,required=True)
parser.add_argument('--port',type=int,required=True)
parser.add_argument('--database',required=True)
parser.add_argument('--psql',default='psql')
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
if args.database!='full_stage1' or not args.socket.is_absolute() or not args.socket.is_dir():
 parser.error('only the existing owned full_stage1 database over an absolute Unix socket is allowed')
repo=Path(__file__).resolve().parents[2]
cmd=[args.psql,'-X','-h',str(args.socket),'-p',str(args.port),'-U','postgres','-d',args.database,'-v','ON_ERROR_STOP=1','-At']
md5=lambda s:hashlib.md5(s.encode()).hexdigest()
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
pat=r"PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;"
def get_definition(path,name,expected,transformed=None):
 s=Path(path).read_text(); ms=list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.'+name+r'\(',s)); assert len(ms)==1
 m=ms[0];t=re.search(r'AS\s+(\$[A-Za-z_]*\$)',s[m.start():],re.I);start=m.start()+t.end();end=s.index(t.group(1),start)
 body=s[start:end]; assert md5(body)==expected,(name,md5(body),expected)
 definition=s[m.start():end+len(t.group(1))+1]
 if transformed:
  body,n=re.subn(pat,'PERFORM public.fn_ca_lock_settlement_lane_global();',body);assert n==1 and md5(body)==transformed,(name,n,md5(body))
  definition,n=re.subn(pat,'PERFORM public.fn_ca_lock_settlement_lane_global();',definition);assert n==1
 return definition
m5=repo/'supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
m4=repo/'supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql'
shared=repo/'supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql'
lane=args.lane_source
assert sha(lane.read_text())=='d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe'
functions=[
 (lane,'fn_ca_lock_settlement_lane_global','343015440ea5c84ee4ca7ae583c73d30',None),
 (m5,'fn_complete_tournament_terminal','589388ad7204fef460a1deebf32ecb69','f4275f9fa8cb2711f19ffdf7b16a04e6'),
 (m5,'fn_resolve_tournament_terminal_outcome','4c151073f56b53e4b0363bdd916b78d4','022c1883533939caf8ebed0cb5699e8c'),
 (m5,'fn_settle_tournament_rake','b945872c72d3414909d4b4b41cfb7849','05a512317bb7bdcecfaec19ef8ee4e63'),
 (m4,'fn_settle_tournament_places','351bfe3e401ad90eeb9b40bad366bb0e','d0262f4928b12eea1cc5e9175cbf2737'),
 (m4,'fn_ca_settle_tournament_place_raw','329237bd65214e17d4ca3298f363f248',None),
 (shared,'fn_settle_tournament_obligation','915f3ebd5c4a2efb97ad3a354dfeb365',None),
]
spin=args.spin_source.read_text()
assert sha(spin)=='0634d1da3856c1db483ea99fb9713838a5c7c5158e1d2f3ee6daf58f335dcf7f'
sql="BEGIN;\nSET LOCAL statement_timeout='45s';\nSET LOCAL lock_timeout='5s';\n"
sql+=re.sub(r'^(BEGIN|COMMIT);$','',spin,flags=re.M)+'\n'
for path,name,before,after in functions:sql+=get_definition(path,name,before,after)+'\n'
sql+="""DO $leaf_guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_attribute_tournament_rake(uuid)'::regprocedure AND md5(prosrc)='45ec1fd0c7499311312e880ff8e99598' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proconfig=ARRAY['search_path=public'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.credit_club_rake_to_treasury(uuid,numeric)'::regprocedure AND md5(prosrc)='472e935f96e8efd1f7cef768e3276f86' AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef AND proconfig=ARRAY['search_path=public'])
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure) IS DISTINCT FROM '68f74f87580ea2c2a1cacbe30f9b4289'
 THEN RAISE EXCEPTION 'current native rake or obligation leaf parity changed'; END IF;
END $leaf_guard$;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid),public.credit_club_rake_to_treasury(uuid,numeric),public.fn_ca_lock_settlement_lane_global() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid),public.credit_club_rake_to_treasury(uuid,numeric),public.fn_ca_lock_settlement_lane_global() TO service_role;
"""
probe=(repo/'scripts/ci/probes/spin-zero-projection-native.sql').read_text();probe=re.sub(r'^BEGIN;$','',probe,flags=re.M); probe,n=re.subn(r'DO \$pass\$ BEGIN RAISE EXCEPTION\n.*?END \$pass\$;\s*$','',probe,flags=re.S);assert n==1
extra=(repo/'scripts/ci/probes/spin-current-terminal-native.sql').read_text()
extra=extra.replace('prize numeric;','v_prize numeric;').replace('INTO prize FROM','INTO v_prize FROM').replace('AND prize=prize)','AND prize=v_prize)').replace('DISTINCT FROM prize','DISTINCT FROM v_prize')
sql+=probe+'\n'+extra
args.output.with_suffix('.sql').write_text(sql)
# Local rehearsal-only state checksum, no row bodies in output.
state_sql="""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'body',md5(prosrc),'definition',md5(pg_get_functiondef(oid)),'owner',proowner,'acl',proacl) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'),'triggers',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'def',pg_get_triggerdef(oid)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE NOT tgisinternal)"""
tables=['auth.users','public.users','public.profiles','public.clubs','public.club_wallets','public.club_members','public.tournaments','public.tournament_players','public.tables','public.table_seats','public.engine_tournament_leases','public.hand_history','public.wallets','public.wallet_transactions','public.wallet_credit_idempotency','public.chip_ledger','public.tournament_escrow','public.rake_records','public.rake_attributions','public.spin_bonus_pools','public.spin_reserve_ledger','public.spin_draw_receipts','public.tournament_launch_receipts','public.tournament_refund_entitlements','public.tournament_finish_receipts','public.tournament_terminal_settlements','public.tournament_rake_settlements','public.tournament_payouts','public.tournament_obligations','public.tournament_place_settlement_batches','public.agent_commissions','public.vip_points_carry','public.player_stats']
# Actual table set is checked first; absent optional table is not silently used.
for table in tables:state_sql+=",'"+table+"',(SELECT jsonb_agg(row ORDER BY row::text) FROM (SELECT to_jsonb(t) row FROM "+table+" t) q)"
state_sql+=');'
def read(sql):return subprocess.run(cmd,input=sql,text=True,capture_output=True,check=True).stdout
connection=json.loads(read("SELECT jsonb_build_object('database',current_database(),'user',current_user,'local',inet_server_addr() IS NULL,'other_sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));"))
if connection!={'database':'full_stage1','user':'postgres','local':True,'other_sessions':0}:
 raise SystemExit('owned idle local connection required')
preimage=read("SELECT md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure));").strip()
if preimage!='1c911e3ada50ffe0493b9b375e3fa9ae':raise SystemExit('Spin preimage differs from the retained rehearsal state')
before=read(state_sql)
run=subprocess.run(cmd,input=sql,text=True,capture_output=True);log=run.stdout+run.stderr
args.output.with_suffix('.log').write_text(log)
after=read(state_sql)
passed=run.returncode==3 and 'AUDIT_TEST_PASS: current native Spin zero-default draw, launch, final cash payout' in run.stderr
print('EXIT',run.returncode,'PASS',passed,'ROLLBACK_EXACT',before==after);print(log[-4500:])
args.output.write_text(json.dumps({'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':passed,'rollback_exact':before==after,'before_sha256':sha(before),'after_sha256':sha(after),'tables':tables,'source_definitions':[{'name':name,'before':b,'after':a or b} for _,name,b,a in functions],'native_exit':run.returncode},indent=2)+'\n')
if not passed or before!=after:raise SystemExit(1)
