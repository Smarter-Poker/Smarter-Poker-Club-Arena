#!/usr/bin/env python3
# This is an acceptance probe, not a rollout script. Preserve the seat authority wrapper.
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
parser.add_argument('--composition',choices=['guarded','guarded-uncontracted','overwritten-wrapper'],default='guarded',
 help='guarded proves the modern batch behind the native seat wrapper; the other modes reproduce prior batch and wrapper refusals')
parser.add_argument('--bubble-state',choices=['unpaid','partial','paid'],
 help='exercise only the normal 9+1 Bubble cash batch with a real paid-before credit')
args=parser.parse_args()
if args.bubble_state and args.composition!='guarded':
 parser.error('Bubble cash proof requires the guarded canonical composition')
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
 (m4,'fn_ca_settle_tournament_bubble_raw','3a5a0f079b7884a5bd2e6bfe6a15ccb7',None),
 (m4,'fn_ca_settle_final_table_deal_share_raw','58e2768644b692f23a9a071a8a5d1ee8',None),
 (shared,'fn_settle_tournament_obligation','915f3ebd5c4a2efb97ad3a354dfeb365',None),
]
stage_b_matches=list((repo/'supabase/migrations').glob('*_stage_b_current_postimage_contraction.sql'))
assert len(stage_b_matches)==1,stage_b_matches
seat_stage_b=stage_b_matches[0]
seat_move=repo/'supabase/migrations/20260910051447_the_seat_move_door_the_engine_calls_exists.sql'
seat_source_sha256={
 str(seat_stage_b.relative_to(repo)):sha(seat_stage_b.read_text()),
 str(seat_move.relative_to(repo)):sha(seat_move.read_text()),
}
assert seat_source_sha256[str(seat_stage_b.relative_to(repo))]=='1f1c28e1ca437839271c0e21ba64d395d9f15f33dfe366e03e3df67a040e3e94'
assert seat_source_sha256[str(seat_move.relative_to(repo))]=='b3f1bb62152627444b33c82b806c00ba3587aeebbe3d13800faf69fae7809ea2'
seat_functions=[
 ('fn_complete_tournament_terminal','uuid,uuid,text','098ae780395481eaf3b4f273a97b6aa5','2b237a636306fa1c95eb227b522aafd1'),
 ('fn_ca_open_tournament_seat_exit_authority','uuid,text,uuid','25cf8792d0d7b4ebf1d383072ca2834c','ad9a7af4abc4d2b1614f715be049a4b2'),
 ('fn_ca_close_tournament_seat_exit_authority','uuid,boolean','0811b7a7795234ed8bc84c606d9a5a62','df0e8e155ca789f10bd49007fc9d13a6'),
 ('fn_tournament_live_seat_exit_requires_authority','','74c1a1a6b2c9ccbf8fe04f875bfba2e2','b128af26b36dff84e9a12666a2a7e957'),
]
# Authenticate the tracked active wrapper/helpers; the strict fixture adds G+B below.
seat_sources={
 'fn_complete_tournament_terminal':seat_stage_b,
 'fn_ca_open_tournament_seat_exit_authority':seat_move,
 'fn_ca_close_tournament_seat_exit_authority':seat_move,
 'fn_tournament_live_seat_exit_requires_authority':seat_stage_b,
}
for name,signature,body,full in seat_functions:get_definition(seat_sources[name],name,body)
native_prerequisites=seat_functions+[
 ('fn_complete_tournament_terminal_pre_seat_guard','uuid,uuid,text','589388ad7204fef460a1deebf32ecb69','abc4701e65b366394414ac39def60ffe')
]
prerequisite_sql="DO $seat_prerequisites$ BEGIN\n"
for name,signature,body,full in native_prerequisites:
 prerequisite_sql+=f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.{name}({signature})') AND md5(prosrc)='{body}' AND md5(pg_get_functiondef(oid))='{full}' AND pg_get_userbyid(proowner)='postgres' AND proacl IS NULL) THEN RAISE EXCEPTION 'native seat authority prerequisite changed: {name}'; END IF;\n"
prerequisite_sql+="""IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='zy_tournament_live_seat_exit_requires_authority' AND tgfoid='public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)
 OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.tournament_seat_exit_authorizations'::regclass AND pg_get_userbyid(relowner)='postgres' AND relacl IS NULL AND relrowsecurity)
 OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations)
 THEN RAISE EXCEPTION 'native seat guard or capability table prerequisite changed'; END IF;
END $seat_prerequisites$;
"""
spin=args.spin_source.read_text()
assert sha(spin)=='0634d1da3856c1db483ea99fb9713838a5c7c5158e1d2f3ee6daf58f335dcf7f'
sql="BEGIN;\nSET LOCAL statement_timeout='45s';\nSET LOCAL lock_timeout='5s';\n"
sql+=prerequisite_sql
sql+=re.sub(r'^(BEGIN|COMMIT);$','',spin,flags=re.M)+'\n'
for path,name,before,after in functions:
 definition=get_definition(path,name,before,after)
 if name=='fn_complete_tournament_terminal' and args.composition!='overwritten-wrapper':
  # The seat migration captures the current implementation under this owner-only
  # name. Updating its core preserves the exact public capability wrapper.
  definition=definition.replace('CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(',
   'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(',1)
 sql+=definition+'\n'
# The retained schema-only dump omitted ACLs. Exercise the exact tracked ACLs
# only inside this rollback transaction, then compare the original catalog.
sql+="""REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text),
 public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid),
 public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO service_role;
REVOKE ALL ON TABLE public.tournament_seat_exit_authorizations FROM PUBLIC,anon,authenticated,service_role;
DO $seat_runtime_contract$ DECLARE v_name text; BEGIN
 FOREACH v_name IN ARRAY ARRAY[
  'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
  'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
  'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)']
 LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=v_name::regprocedure AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'seat helper is not owner-only: %',v_name; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('anon','public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_complete_tournament_terminal(uuid,uuid,text)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid='public.tournament_seat_exit_authorizations'::regclass AND a.grantee<>c.relowner)
 THEN RAISE EXCEPTION 'seat public wrapper or token table ACL differs'; END IF;
END $seat_runtime_contract$;
"""
if args.composition!='overwritten-wrapper':
 sql+="""DO $seat_composition$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure)<>'098ae780395481eaf3b4f273a97b6aa5'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure)<>'f4275f9fa8cb2711f19ffdf7b16a04e6'
 THEN RAISE EXCEPTION 'guarded terminal composition differs'; END IF;
END $seat_composition$;
"""
sql+="""DO $leaf_guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_attribute_tournament_rake(uuid)'::regprocedure AND md5(prosrc)='45ec1fd0c7499311312e880ff8e99598' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proconfig=ARRAY['search_path=public'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.credit_club_rake_to_treasury(uuid,numeric)'::regprocedure AND md5(prosrc)='472e935f96e8efd1f7cef768e3276f86' AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef AND proconfig=ARRAY['search_path=public'])
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure) IS DISTINCT FROM '68f74f87580ea2c2a1cacbe30f9b4289'
 THEN RAISE EXCEPTION 'current native rake or obligation leaf parity changed'; END IF;
END $leaf_guard$;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid),public.credit_club_rake_to_treasury(uuid,numeric),public.fn_ca_lock_settlement_lane_global() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid),public.credit_club_rake_to_treasury(uuid,numeric),public.fn_ca_lock_settlement_lane_global() TO service_role;
"""

# Strict retained fixture: acquire the complete money lane before seat rows.
if args.composition!='overwritten-wrapper':
 strict_wrapper=get_definition(seat_stage_b,'fn_complete_tournament_terminal','098ae780395481eaf3b4f273a97b6aa5')
 strict_wrapper=strict_wrapper.replace('  v_token:=public.fn_ca_open_tournament_seat_exit_authority(',
  '  PERFORM public.fn_ca_lock_settlement_lane_global();\n  v_token:=public.fn_ca_open_tournament_seat_exit_authority(',1)
 match=re.search(r'AS\s+(\$[A-Za-z_]*\$)',strict_wrapper,re.I)
 a=match.end();b=strict_wrapper.index(match.group(1),a)
 assert md5(strict_wrapper[a:b])=='96a61ea5e16560735bcb70b355aa79ab'
 sql+=strict_wrapper+'\n'
retry=(repo/'scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql').read_text()
assert sha(retry)=='f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c'
sql+="""REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text) TO service_role;
"""
sql+=re.sub(r'^(BEGIN|COMMIT);$','',retry,flags=re.M)+'\n'
if args.composition=='guarded':
 stage=(repo/'scripts/deploy/phase-three-strict-tournament-cutover.sql').read_text()
 sql+="""REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid),
 public.trg_tournament_atomic_place_completion_guard(),public.trg_freeze_batched_tournament_place() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid),
 public.trg_tournament_atomic_place_completion_guard(),public.trg_freeze_batched_tournament_place() TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_finish_readiness(uuid,uuid),
 public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric),
 public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric),
 public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric),
 public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
"""
 for marker,digest in [
  ('CANONICAL TERMINAL PLACE BATCH CONTRACT','5463368592ace44854fe970e8dbc2c12499e82328e9bc7c49986a68d0d922692'),
  ('CANONICAL TERMINAL READINESS DISPATCH','1e910a42e4eee077584b662eaed4fdd777026be7bb3904106b2062f279950521')]:
  a=stage.index('-- BEGIN '+marker);b=stage.index('-- END '+marker,a)+len('-- END '+marker)
  block=stage[a:b]+'\n';assert sha(block)==digest,(marker,sha(block))
  sql+=block
 a=stage.index('DO $contract_cash_batch_payers$')
 b=stage.index('$contract_cash_batch_payers$;',a)+len('$contract_cash_batch_payers$;')
 block=stage[a:b];assert sha(block)=='5a74950603c140919592fe3d75d8ded02b0b3e992f2642ad3a2b9dc554e88e8c'
 sql+=block+'\n'
 sql+=get_definition(repo/'scripts/deploy/phase-three-strict-tournament-cutover.sql',
  'fn_settle_tournament_obligation','7e4c7398d7daa25518b6737197fa3172')+'\n'

# Capture catalog metadata AFTER every prepared source/ACL composition. These
# runtime pins are distinct from the intermediate source bodies listed below.
runtime_signatures=[
 'fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)',
 'fn_ca_lock_settlement_lane_global()',
 'fn_complete_tournament_terminal(uuid,uuid,text)',
 'fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
 'fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
 'fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
 'fn_ca_close_tournament_seat_exit_authority(uuid,boolean)',
 'fn_tournament_live_seat_exit_requires_authority()',
 'fn_settle_tournament_rake(uuid,text)',
 'fn_attribute_tournament_rake(uuid)',
 'credit_club_rake_to_treasury(uuid,numeric)',
 'fn_settle_tournament_places(uuid,uuid)',
 'fn_ca_verify_terminal_place_batch(uuid,boolean)',
 'trg_tournament_atomic_place_completion_guard()',
 'trg_freeze_batched_tournament_place()',
 'fn_stamp_tournament_terminal_evidence_markers()',
 'fn_tournament_finish_readiness(uuid,uuid)',
 'fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
 'fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
 'fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
 'fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
 'fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
]
runtime_oids=','.join("to_regprocedure('public."+sig+"')" for sig in runtime_signatures)
sql+="SELECT 'NATIVE_COMPOSITION=' || jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'body_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'security_definer',p.prosecdef) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN ("+runtime_oids+")),'guards',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '(atomic.*(place|deal)|financial.*certif|completing.*claim|seat_exit|terminal_receipt|pending_bounty)'),'seat_authority_table',(SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl,'rls',relrowsecurity) FROM pg_class WHERE oid='public.tournament_seat_exit_authorizations'::regclass))::text;\n"

if args.bubble_state:
 probe=(repo/'scripts/ci/probes/canonical-bubble-cash-native.sql').read_text()
 probe=probe.replace('@BUBBLE_STATE@',args.bubble_state).replace('@BUBBLE_INITIAL_AMOUNT@',
  {'unpaid':'0','partial':'0.40','paid':'1.00'}[args.bubble_state])
 sql+=probe
else:
 probe=(repo/'scripts/ci/probes/spin-zero-projection-native.sql').read_text();probe=re.sub(r'^BEGIN;$','',probe,flags=re.M); probe,n=re.subn(r'DO \$pass\$ BEGIN RAISE EXCEPTION\n.*?END \$pass\$;\s*$','',probe,flags=re.S);assert n==1
 extra=(repo/'scripts/ci/probes/spin-current-terminal-native.sql').read_text()
 sql+=probe+'\n'+extra
args.output.with_suffix('.sql').write_text(sql)
# Local rehearsal-only state checksum, no row bodies in output.
state_sql="""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'body',md5(prosrc),'definition',md5(pg_get_functiondef(oid)),'owner',proowner,'acl',proacl) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'),'triggers',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'def',pg_get_triggerdef(oid)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE NOT tgisinternal)"""
tables=['auth.users','public.users','public.profiles','public.clubs','public.club_wallets','public.club_members','public.tournaments','public.tournament_players','public.tables','public.table_seats','public.engine_tournament_leases','public.hand_history','public.wallets','public.wallet_transactions','public.wallet_credit_idempotency','public.chip_ledger','public.tournament_escrow','public.rake_records','public.rake_attributions','public.spin_bonus_pools','public.spin_reserve_ledger','public.spin_draw_receipts','public.tournament_launch_receipts','public.tournament_refund_entitlements','public.tournament_finish_receipts','public.tournament_terminal_settlements','public.tournament_rake_settlements','public.tournament_payouts','public.tournament_obligations','public.tournament_place_settlement_batches','public.agent_commissions','public.vip_points_carry','public.player_stats','public.tournament_seat_exit_authorizations']
# Actual table set is checked first; absent optional table is not silently used.
for table in tables:state_sql+=",'"+table+"',(SELECT jsonb_agg(row ORDER BY row::text) FROM (SELECT to_jsonb(t) row FROM "+table+" t) q)"
state_sql+=", 'authority_table_catalog',(SELECT jsonb_build_object('owner',relowner,'acl',relacl,'rls',relrowsecurity) FROM pg_class WHERE oid='public.tournament_seat_exit_authorizations'::regclass));"
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
expected_pass=('AUDIT_TEST_PASS: canonical Bubble cash paid-before' if args.bubble_state else
 'AUDIT_TEST_PASS: current native Spin zero-default draw, launch, final cash payout')
passed=run.returncode==3 and expected_pass in run.stderr
negative_passed=run.returncode==3 and not passed and (
 (args.composition=='overwritten-wrapper' and 'TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' in run.stderr)
 or (args.composition=='guarded-uncontracted' and 'cannot complete without a settled atomic place batch' in run.stderr))
runtime_rows=[line.removeprefix('NATIVE_COMPOSITION=') for line in run.stdout.splitlines() if line.startswith('NATIVE_COMPOSITION=')]
runtime_catalog=json.loads(runtime_rows[0]) if len(runtime_rows)==1 else None
terminal_rows=[line.removeprefix('NATIVE_TERMINAL_EVIDENCE=') for line in run.stdout.splitlines() if line.startswith('NATIVE_TERMINAL_EVIDENCE=')]
terminal_evidence=json.loads(terminal_rows[0]) if len(terminal_rows)==1 else None
bubble_rows=[line.removeprefix('NATIVE_BUBBLE_EVIDENCE=') for line in run.stdout.splitlines() if line.startswith('NATIVE_BUBBLE_EVIDENCE=')]
bubble_evidence=json.loads(bubble_rows[0]) if len(bubble_rows)==1 else None
runtime_complete=runtime_catalog is not None and (args.composition!='guarded' or len(runtime_catalog['functions'])==len(runtime_signatures))
verified=(passed if args.composition=='guarded' else negative_passed) and before==after and runtime_complete and (not passed or (bubble_evidence if args.bubble_state else terminal_evidence) is not None)
verified_checkpoints=[
 'Exact tracked source hashes and original native seat function/ACL prerequisites',
 'Final exercised runtime catalog captured after all prepared function and ACL composition',
 'Native zero-default Spin draw and launch assertions from spin-zero-projection-native.sql',
 'Genuine finish claim enters COMPLETING',
 'Late receipt fault follows fully paid prize, exact rake attribution, zero closed custody and released seats',
 'Late receipt fault rolls back the complete observed state including the new immutable place batch',
 'Successful terminal call returns fully settled COMPLETED',
 'Exact recipient amounts from the immutable draw contract exhaust the funded prize and settle all obligations',
 'Actual settled version-2 canonical batch passes its complete money and terminal verifier',
 'Exact per-seat authority rows are minted and consumed, with no retained rows',
 'Terminal wrapper clears both capability settings',
 'Completed terminal replay returns the byte-identical receipt without state changes',
 'Resolver reports committed with the identical stored receipt',
 'All deferred constraints pass SET CONSTRAINTS ALL IMMEDIATE',
 'Outer transaction restores all public function metadata, all triggers, authority table metadata and 34 table states',
] if verified and passed else []
if args.bubble_state and verified and passed:
 verified_checkpoints=bubble_evidence['assertions']+[
  'Final exercised runtime catalog captured after every prepared source and ACL composition',
  'Exact rollback of public function metadata, all triggers and 34 tracked table states',
 ]
print('COMPOSITION',args.composition,'EXIT',run.returncode,'PASS',passed,'NEGATIVE_REGRESSION_PASS',negative_passed,'ROLLBACK_EXACT',before==after);print(log[-4500:])
args.output.write_text(json.dumps({'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'composition':args.composition,'fixture':'normal-bubble-cash' if args.bubble_state else 'spin-terminal','bubble_state':args.bubble_state,'negative_regression_passed':negative_passed,'verified':verified,'seat_source_sha256':seat_source_sha256,'seat_source_fingerprints':[{'name':n,'body_md5':b,'original_full_md5':f} for n,_,b,f in native_prerequisites],'original_seat_acl':'NULL schema-only dump ACL; preserved exactly after rollback','exercised_seat_acl':'tracked owner-only private core/open/close and token table; postgres+service_role public wrapper','passed':passed,'rollback_exact':before==after,'before_sha256':sha(before),'after_sha256':sha(after),'tables':tables,'base_source_definitions':[{'name':name,'source_body_md5':b,'intermediate_composed_body_md5':a or b} for _,name,b,a in functions],'terminal_evidence':terminal_evidence,'cash_evidence':cash_evidence,'exercised_runtime_catalog':runtime_catalog,'runtime_catalog_complete':runtime_complete,'prepared_blocks_sha256':{'canonical_place_batch':'5463368592ace44854fe970e8dbc2c12499e82328e9bc7c49986a68d0d922692','canonical_readiness':'1e910a42e4eee077584b662eaed4fdd777026be7bb3904106b2062f279950521','cash_batch_payers':'5a74950603c140919592fe3d75d8ded02b0b3e992f2642ad3a2b9dc554e88e8c'} if args.composition=='guarded' else {},'composed_sql_sha256':sha(sql),'input_file_sha256':{str(p.relative_to(repo)):sha(p.read_text()) for p in [Path(__file__).resolve(),args.spin_source.resolve(),args.lane_source.resolve(),seat_stage_b,seat_move,m4,m5,shared,repo/'scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql',repo/'scripts/deploy/phase-three-strict-tournament-cutover.sql',repo/'scripts/ci/probes/spin-zero-projection-native.sql',repo/'scripts/ci/probes/spin-current-terminal-native.sql',repo/'scripts/ci/probes/canonical-bubble-cash-native.sql']},'verified_checkpoint_count':len(verified_checkpoints),'verified_checkpoints':verified_checkpoints,'scope_limits':(['Local rollback-only synthetic opening custody and standings; all payments and paid-before amounts use the actual native payer.','The normal Bubble proof stops at COMPLETING with prize escrow zero; it does not claim terminal closure.','Paid-before Bubble variants cover 0, 0.40 and 1.00 only; this is not the broader payout/rounding matrix.','Final-deal version-2 helper/writer remains blocked and absent; its readiness branch is pending.','Whole Stage B remains undeployed.'] if args.bubble_state else ['Local rollback-only synthetic custody fixture; registration was not exercised.','Native guarded seat wrapper is a strict fixture composition, not a production requirement.','This Spin terminal run covers the one-winner payout path. Bubble paid-before cash coverage is recorded separately; zero-pool and sparse/rounded ladder variants remain unverified.','No two-session hand/terminal concurrency proof is claimed by this runner.','Final-deal version-2 helper/writer was blocked by automatic approval review and remains absent; readiness dispatch for it is pending and unexercised.','Stage B was not applied to production.']),'native_exit':run.returncode},indent=2)+'\n')
if not verified:raise SystemExit(1)
