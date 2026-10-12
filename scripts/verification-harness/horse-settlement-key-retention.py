#!/usr/bin/env python3
"""Native PG17 key compaction with real captured replay/P&L consumers.
Empty dependency columns captured 2026-10-12; no financial function stubs.
All scratch belongs to supplied evidence directory; never production.
"""
import argparse,json,sys,datetime,subprocess,time
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,lit,sha
FIX=ROOT/'scripts/verification-harness/fixtures/horse-settlement-key'
MIG=ROOT/'supabase/migrations/20261012161313_settled_horse_settlement_keys_retain_compact_replay_certificates.sql'
def extract(path,start,end):
 s=(ROOT/path).read_text();return s[s.index(start):s.index(end,s.index(start))]
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--pg-bin',type=Path,required=True);parser.add_argument('--evidence',type=Path,required=True);args=parser.parse_args()
 out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False);sock=out.parent/'sock';sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','horse_key_native');e=native.Execution(ROOT,out,args.pg_bin.resolve(),out,300,socket_parent=str(sock));e.report['source_sha256']={str(p.relative_to(ROOT)):sha(p) for p in [MIG,Path(__file__),*FIX.iterdir()]};passed=[]
 def check(db,sql,label,want='t'):
  _,val,_=e.sql(db,sql,label=label);assert val.strip()==want,(label,val);passed.append(label)
 try:
  e.start();db=e.database();e.sql(db,file=ROOT/'scripts/ci/fixtures/hand-submission-retention-disposal/world.sql',label='retained-hand-schema')
  columns=json.loads((FIX/'cash-columns.json').read_text());schema=''
  for name in sorted(set(c['relname'] for c in columns)):
   cols=[]
   for c in [c for c in columns if c['relname']==name]:
    # Epoch creation default is not invoked by retained seeded rows; all
    # other current column types/order/default/nullability are unchanged.
    expr=c['default_expr'];expr=None if expr=='fn_ca_current_epoch()' else expr
    cols.append('"'+c['attname']+'" '+c['type']+(' NOT NULL' if c['attnotnull'] else '')+(' DEFAULT '+expr if expr else ''))
   schema+='CREATE TABLE public.'+name+'('+','.join(cols)+');\n'
  schema+="CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text); CREATE TABLE public.lightning_settlement_marker(txid xid8,player_id uuid,anchor_table_id uuid,host_table_id uuid,hand_number bigint); ALTER TABLE public.tournaments ADD COLUMN bounty_pool numeric,ADD COLUMN bounty_pool_paid numeric; CREATE TABLE public.tournament_escrow(tournament_id uuid,closed_at timestamptz); CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;"
  e.sql(db,schema,label='current-cash-dependency-columns')
  e.sql(db,file=ROOT/'supabase/migrations/20260428000003_settlement_idempotency_keys.sql',label='real-key-schema')
  funcs=extract('supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql','CREATE FUNCTION public.fn_cash_provenance_immutable()','ALTER TABLE public.cash_funding_application_receipts ENABLE ROW LEVEL SECURITY;')
  e.sql(db,funcs,label='original-cash-immutable-guards')
  matching=extract('supabase/migrations/20260918004443_cash_pnl_validates_the_finalized_original_atomic_receipt.sql','CREATE FUNCTION public.fn_cash_atomic_original_matches','DO $reader$')
  lightning=extract('supabase/migrations/20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql','CREATE OR REPLACE FUNCTION public.fn_lightning_settlement_seats','-- ===========================================================================\n-- 4.')
  unresolved=extract('supabase/migrations/20260921023215_unresolved_hand_permits_retain_their_original_hand_history.sql','CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved','REVOKE ALL ON FUNCTION smarter_private.f06_hand_cards_unresolved')
  movement=extract('supabase/migrations/20260925210126_a_live_table_keeps_the_boundary_its_movement_reads.sql','CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained','REVOKE ALL ON FUNCTION smarter_private.f06_movement_boundary_retained')
  e.sql(db,matching+lightning+unresolved+movement,label='real-original-read-and-f06-helpers')
  disposal_schema=extract('supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql','CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_disposals','CREATE OR REPLACE FUNCTION public.fn_ca_dispose_superseded_hand_submissions')
  raw_helpers=extract('supabase/migrations/20261012153428_settled_horse_request_payloads_age_out_with_their_history.sql','CREATE FUNCTION smarter_private.horse_request_payload_disposable','-- Append one compaction call')
  raw_helpers=raw_helpers.replace(" IF s.request#>>'{p_hand_row,has_human}'='true'", " IF (s.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb")
  e.sql(db,disposal_schema+raw_helpers+(FIX/'disposal.sql').read_text()+';',label='real-current-disposal-and-original-request-helpers')
  for name in ['stack','evidence','prune','cents']:e.sql(db,(FIX/(name+'.sql')).read_text()+';',label='exact-current-'+name)
  e.sql(db,"REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric),public.fn_pnl_cash_hand_evidence(uuid,bigint),public.sp_prune_hand_history(integer) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;",label='current-authority-acls')
  beforecase=e.database(db);e.sql(beforecase,file=FIX/'seed.sql',label='naive-before-seed');e.sql(beforecase,"UPDATE public.settlement_idempotency_keys SET result=result-'request';",label='naive-compaction-before');check(beforecase,"SELECT public.fn_pnl_cash_hand_evidence('c1000000-0000-4000-8000-000000000001',1000001)->>'status';",'naive-compaction-breaks-accounting','blocked');check(beforecase,"SELECT public.fn_ca_settle_hand_stacks_absolute('c1000000-0000-4000-8000-000000000001',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),1,0,'',0)->>'success';",'naive-compaction-loses-different-payload-rejection','true');e.discard(beforecase)
  e.sql(db,file=MIG,label='candidate-install')
  code,_,err=e.sql(db,file=MIG,label='reinstall-refused',check=False);assert code and 'ALREADY_INSTALLED' in err;passed.append('reinstall-refused')
  empty=e.database(db)
  integrated=e.database(empty);e.sql(integrated,file=FIX/'seed.sql',label='integrated-prune-seed');check(integrated,"SELECT public.sp_prune_hand_history(250);",'existing-prune-compacts-before-delete','1');check(integrated,"SELECT NOT result ? 'request' AND NOT EXISTS(SELECT 1 FROM public.hand_history) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits) FROM public.settlement_idempotency_keys;",'prune-key-compact-history-erased');check(integrated,"SELECT public.fn_pnl_cash_hand_evidence('c1000000-0000-4000-8000-000000000001',1000001)->>'status';",'financial-evidence-ready-after-history-erasure','ready');e.discard(integrated)
  for name,seedchange in [('original-mixed',lambda x:x.replace('"is_horse":true','"is_horse":false',1)),('original-unknown',lambda x:x.replace('"is_horse":true','"is_horse":null',1))]:
   case=e.database(empty);e.sql(case,seedchange((FIX/'seed.sql').read_text()),label=name+'-seed');check(case,"SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);",name+'-retained','0');e.discard(case)
  e.discard(empty)
  e.sql(db,file=FIX/'seed.sql',label='original-cash-proof-seed')
  check(db,"SELECT public.fn_pnl_cash_hand_evidence('c1000000-0000-4000-8000-000000000001',1000001)->>'status';",'original-financial-evidence-ready','ready')
  _,before,_=e.sql(db,"SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence('c1000000-0000-4000-8000-000000000001',1000001),'key',result,'money',(SELECT jsonb_agg(to_jsonb(l)) FROM public.chip_ledger l)) FROM public.settlement_idempotency_keys;",label='original-response-money-evidence')
  for name,change in [('human',"UPDATE public.hand_history SET has_human=true;"),('original-history-unknown',"UPDATE public.hand_history SET has_human=NULL;"),('young',"UPDATE public.hand_history SET created_at=now();"),('unfinished',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL;"),('recently-complete',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=now();"),('reported',"UPDATE public.hand_history SET reported=true;"),('blocked',"UPDATE public.settlement_idempotency_keys SET status='failed';")]:
   case=e.database(db);e.sql(case,change,label=name+'-change');check(case,"SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);",name+'-retained','0');e.discard(case)
  boundary=e.database(db);check(boundary,"BEGIN;UPDATE public.hand_history SET created_at=now()-interval '8 days';SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);ROLLBACK;",'exact-eight-day-boundary-retained','0');e.discard(boundary)
  rollback=e.database(db);e.sql(rollback,"BEGIN;SELECT public.sp_prune_hand_history(250);ROLLBACK;",label='original-prune-rollback');check(rollback,"SELECT result ? 'request' AND EXISTS(SELECT 1 FROM public.hand_history) AND EXISTS(SELECT 1 FROM public.hand_atomic_commits) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates) FROM public.settlement_idempotency_keys;",'prune-compaction-rollback-atomic');e.discard(rollback)
  race=e.database(db);argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',race,'-v','ON_ERROR_STOP=1']
  replay_sql="SELECT public.fn_ca_settle_hand_stacks_absolute('c1000000-0000-4000-8000-000000000001',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0);"
  holder=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  racer=None
  try:
   holder.stdin.write("BEGIN;"+replay_sql+"SELECT 'locked';\n");holder.stdin.flush();replayed=json.loads(holder.stdout.readline());assert replayed==dict(json.loads(before)['key'],replay=True);assert holder.stdout.readline().strip()=='locked'
   racer=subprocess.Popen(argv+['-c',"SET application_name='horse_key_compaction_race'; SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   waited=False
   for _ in range(40):
    _,observed,_=e.sql(race,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='horse_key_compaction_race' AND wait_event_type='Lock');",label='observe-original-replay-lock')
    if observed.strip()=='t':waited=True;break
    time.sleep(.025)
   assert waited,'compaction must wait for original replay transaction'
   holder.stdin.write('COMMIT;\n');holder.stdin.close();holder.wait(timeout=10);out_race,err_race=racer.communicate(timeout=10);assert racer.returncode==0 and out_race.strip()=='1' and not err_race
   passed.append('replay-compaction-original-lock-order');e.report['race']={'observed_lock_wait':True,'replay_response_identical':True,'compaction_count':1}
  finally:
   for process in [holder,racer]:
    if process is not None and process.poll() is None:process.terminate();process.wait(timeout=10)
  e.discard(race)
  check(db,"SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);",'old-certified-horse-compacted','1')
  check(db,"SELECT NOT result ? 'request' FROM public.settlement_idempotency_keys;",'stored-duplicate-request-erased')
  _,after,_=e.sql(db,"SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence('c1000000-0000-4000-8000-000000000001',1000001),'key',smarter_private.horse_settlement_original_result(table_id,hand_id,result),'money',(SELECT jsonb_agg(to_jsonb(l)) FROM public.chip_ledger l)) FROM public.settlement_idempotency_keys;",label='resolved-response-money-evidence');assert json.loads(before)==json.loads(after);passed.append('financial-evidence-response-money-identical')
  check(db,"SELECT smarter_private.compact_horse_settlement_keys(ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]);",'repeat-noop','0')
  call="SELECT public.fn_ca_settle_hand_stacks_absolute('c1000000-0000-4000-8000-000000000001',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0)"
  _,reply,_=e.sql(db,call+';',label='same-payload-replay');assert json.loads(reply)==dict(json.loads(before)['key'],replay=True);passed.append('exact-replay-response')
  code,_,err=e.sql(db,call.replace("0,0,'',0","1,0,'',0")+';',label='different-payload-rejected',check=False);assert code and 'different payload' in err;passed.append('different-payload-rejected')
  for name,sql in [('certificate-update','UPDATE smarter_private.horse_settlement_key_certificates SET original_result_sha256=repeat(\'0\',64);'),('certificate-delete','DELETE FROM smarter_private.horse_settlement_key_certificates;'),('certificate-truncate','TRUNCATE smarter_private.horse_settlement_key_certificates;'),('key-delete','DELETE FROM public.settlement_idempotency_keys;'),('key-truncate','TRUNCATE public.settlement_idempotency_keys;'),('key-identity',"UPDATE public.settlement_idempotency_keys SET hand_id=gen_random_uuid();"),('key-status',"UPDATE public.settlement_idempotency_keys SET status='failed';"),('unauthorized-compaction',"SET ROLE service_role; SELECT smarter_private.compact_horse_settlement_keys(ARRAY[]::uuid[]);")]:
   code,_,err=e.sql(db,sql,label=name,check=False);assert code and ('IMMUTABLE' in err or 'PERMANENT' in err or 'permission denied' in err);passed.append(name)
  case=e.database(db);e.sql(case,"ALTER TABLE public.settlement_idempotency_keys DISABLE TRIGGER horse_settlement_key_guard;UPDATE public.settlement_idempotency_keys SET result=result||'{\"tampered\":true}';",label='tamper-compact');code,_,err=e.sql(case,call+';',label='tamper-refused',check=False);assert code and 'COMPACT_ORIGINAL_CONFLICT' in err;passed.append('tamper-refused');e.discard(case)
  case=e.database(db);e.sql(case,"ALTER TABLE public.settlement_idempotency_keys DISABLE TRIGGER horse_settlement_key_guard;UPDATE public.settlement_idempotency_keys SET status='failed';",label='tamper-status');code,_,err=e.sql(case,call+';',label='tamper-status-refused',check=False);assert code and 'COMPACT_STATUS_CONFLICT' in err;passed.append('tampered-status-cannot-reapply');e.discard(case)
  _,catalog,_=e.sql(db,"SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure,'public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure,'smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)'::regprocedure,'smarter_private.compact_horse_settlement_keys(uuid[])'::regprocedure,'smarter_private.horse_settlement_key_guard()'::regprocedure,'smarter_private.horse_settlement_certificate_immutable()'::regprocedure]);",label='qualified-postimage-catalog');e.report['qualified_postimage']=json.loads(catalog)
  e.report['status']='passed';e.report['proven']=passed
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(status='failed',cleanup_failure=repr(exc))
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
