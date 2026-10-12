"""Native lifetime count/time retention proof; real captured published RPC.
No production access. Called by the existing connected retention harness.
"""
import json,subprocess,time
from pathlib import Path
from satellite_qualifier_fixture import sha,lit
MIG='supabase/migrations/20261012165344_horse_hand_retention_preserves_lifetime_index_totals.sql'
FIX='scripts/verification-harness/fixtures/horse-lifetime-retention'
U="d1000000-0000-4000-8000-000000000001"
H="d2000000-0000-4000-8000-000000000001"
def qualify(e,template,connected=True):
 root=e.root; passed=[]; db=e.database(template)
 paths=[root/MIG,Path(__file__),*(root/FIX).iterdir()]
 e.report.setdefault('source_sha256',{}).update({str(p.relative_to(root)):sha(p) for p in paths})
 def check(d,q,label,want='t'):
  _,got,_=e.sql(d,q,label='lifetime-'+label);assert got.strip()==want,(label,got);passed.append(label)
 # Exact captured dependency columns; existing connected cash relations keep
 # their original definitions and acquire only missing stats-read columns.
 columns=json.loads((root/FIX/'dependency-columns.json').read_text())
 schema=''
 for name in sorted({c['relname'] for c in columns}):
  schema+='CREATE TABLE IF NOT EXISTS public.'+name+'();\n'
  for c in [c for c in columns if c['relname']==name]:
   schema+='ALTER TABLE public.'+name+' ADD COLUMN IF NOT EXISTS "'+c['attname']+'" '+c['type']+';\n'
 schema+="INSERT INTO public.ca_hand_player_idx_state(id,backfill_complete) VALUES(true,true);ALTER TABLE public.ca_hand_player_idx ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL,ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips',ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();ALTER TABLE public.ca_hand_player_idx ADD CONSTRAINT lifetime_idx_pk PRIMARY KEY(user_id,hand_id);"
 e.sql(db,schema,label='lifetime-captured-dependencies')
 asset=json.loads((root/FIX/'asset-guard.json').read_text())
 e.sql(db,asset['definition']+";REVOKE ALL ON FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset() FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset() TO service_role;CREATE TRIGGER ca_hand_player_idx_takes_its_hands_asset BEFORE INSERT OR UPDATE OF asset,hand_id ON public.ca_hand_player_idx FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset();"+(root/FIX/'rpc-preimage.sql').read_text()+";REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid,integer,text,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid,integer,text,text) TO service_role;",label='lifetime-real-published-rpc-and-trigger')
 seed="INSERT INTO public.hand_history(id,has_human,created_at) VALUES('"+H+"',false,'2026-01-01'),('d2000000-0000-4000-8000-000000000002',true,'2026-01-02'),('d2000000-0000-4000-8000-000000000003',false,'2026-01-03');INSERT INTO public.ca_hand_player_idx(user_id,hand_id,asset,created_at) VALUES('"+U+"','"+H+"','chips','2026-01-01'),('"+U+"','d2000000-0000-4000-8000-000000000002','chips','2026-01-02'),('"+U+"','d2000000-0000-4000-8000-000000000003','diamonds','2026-01-03');"
 call="public.ca_player_stats_full('"+U+"',NULL,'UTC','chips')"
 arr="ARRAY['"+H+"'::uuid]"
 before=e.database(db);e.sql(before,seed,label='lifetime-before-seed');check(before,'SELECT '+call+"#>>'{lifetime,hands}';",'before-count','2');e.sql(before,"DELETE FROM public.ca_hand_player_idx WHERE hand_id='"+H+"';",label='lifetime-old-delete');check(before,'SELECT '+call+"#>>'{lifetime,hands}';",'old-retention-loses-count','1');e.discard(before)
 e.sql(db,file=root/MIG,label='lifetime-install')
 code,_,err=e.sql(db,file=root/MIG,label='lifetime-replay-refused',check=False);assert code and 'ALREADY_INSTALLED' in err;passed.append('migration-replay-refused')
 case=e.database(db);e.sql(case,seed,label='lifetime-certified-seed');_,original,_=e.sql(case,'SELECT '+call+';',label='lifetime-original-response')
 rollback=e.database(case);e.sql(rollback,'BEGIN;SELECT smarter_private.archive_pruned_hand_index('+arr+');ROLLBACK;',label='lifetime-rollback');check(rollback,"SELECT count(*)=3 AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_index_retention_totals) FROM public.ca_hand_player_idx;",'rollback-keeps-index-and-totals');e.discard(rollback)
 check(case,'SELECT smarter_private.archive_pruned_hand_index('+arr+');','archive-one','1')
 _,after,_=e.sql(case,'SELECT '+call+';',label='lifetime-after-response')
 a=json.loads(original);b=json.loads(after);a.pop('generated_at');b.pop('generated_at');assert a==b;passed.append('actual-rpc-all-fields-identical-after-archive')
 check(case,'SELECT smarter_private.archive_pruned_hand_index('+arr+');','duplicate-noop','0')
 check(case,"SELECT "+call+"#>>'{lifetime,historical_complete}';",'historical-gap-honest','false')
 check(case,"SELECT public.ca_player_stats_full('"+U+"',NULL,'UTC','diamonds')#>>'{lifetime,hands}';",'asset-isolation','1')
 for name,change in [('human','true'),('unknown','NULL')]:
  child=e.database(db);e.sql(child,seed+"UPDATE public.hand_history SET has_human="+change+" WHERE id='"+H+"';",label='lifetime-'+name+'-seed');code,_,err=e.sql(child,'SELECT smarter_private.archive_pruned_hand_index('+arr+');',label='lifetime-'+name+'-refused',check=False);assert code and 'BOUNDARY_REQUIRED' in err;passed.append(name+'-refused');check(child,'SELECT count(*)=3 FROM public.ca_hand_player_idx;',name+'-index-preserved');e.discard(child)
 # A late original index writer blocks on the history row, then observes the
 # committed deletion and returns NULL; no archived hand can reappear.
 race=e.database(db);e.sql(race,seed,label='lifetime-race-seed')
 argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',race,'-v','ON_ERROR_STOP=1']
 holder=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);writer=None
 try:
  holder.stdin.write('BEGIN;SELECT smarter_private.archive_pruned_hand_index('+arr+");SELECT 'held';\n");holder.stdin.flush();assert holder.stdout.readline().strip()=='1' and holder.stdout.readline().strip()=='held'
  writer=subprocess.Popen(argv+['-c',"SET application_name='lifetime_late_writer';INSERT INTO public.ca_hand_player_idx(user_id,hand_id,asset,created_at) VALUES('"+U+"','"+H+"','chips','2026-01-01');"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  waited=False
  for _ in range(40):
   _,v,_=e.sql(race,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='lifetime_late_writer' AND wait_event_type='Lock');",label='lifetime-race-observe')
   if v.strip()=='t':waited=True;break
   time.sleep(.025)
  assert waited
  holder.stdin.write("DELETE FROM public.hand_history WHERE id='"+H+"';COMMIT;\n");holder.stdin.close();holder.wait(timeout=10);o,err=writer.communicate(timeout=10);assert holder.returncode==0 and writer.returncode==0,(o,err)
  passed.append('late-original-writer-fenced-by-history-lock')
  check(race,"SELECT NOT EXISTS(SELECT 1 FROM public.ca_hand_player_idx WHERE hand_id='"+H+"') AND (SELECT hands=1 FROM smarter_private.hand_index_retention_totals WHERE user_id='"+U+"' AND asset='chips');",'late-replay-no-double-count')
 finally:
  for proc in [holder,writer]:
   if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 e.discard(race)
 check(case,"BEGIN;SET ROLE service_role;SELECT "+call+"#>>'{lifetime,hands}';ROLLBACK;",'original-rpc-authority-preserved','2')
 for name,q in [('helper',"SET ROLE service_role;SELECT smarter_private.archive_pruned_hand_index("+arr+");"),('private-read','SET ROLE service_role;SELECT * FROM smarter_private.hand_index_retention_totals;')]:
  code,_,err=e.sql(case,q,label='lifetime-'+name+'-denied',check=False);assert code and 'permission denied' in err;passed.append(name+'-denied')
 if connected:
  # Same v2 original stats agreement as the fact-basis qualification. Hashes
  # are calculated by the real retained seed after the literal substitution.
  cashhand='c2000000-0000-4000-8000-000000000001';cashtable='c1000000-0000-4000-8000-000000000001';cashuser='c5000000-0000-4000-8000-000000000001'
  stats=json.dumps({'version':2,'facts':[{'hand_id':cashhand,'table_id':cashtable,'user_id':cashuser,'hole_cards':['As','Kd'],'net':0,'rake_paid':0,'vpip':True}],'transfers':[]},separators=(',',':'))
  cashseed=(root/'scripts/verification-harness/fixtures/horse-cash-play-contents/seed.sql').read_text().replace('{"version":1,"private_holding":["As","Kd"]}',stats)
  cashseed="BEGIN;INSERT INTO public.hand_history_retention_policy(horse_retention_days) VALUES(8);"+cashseed+"INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),now(),now());INSERT INTO public.union_pnl_cash_outcomes(table_id,hand_number,hand_id,transaction_id,recognized_at,payload_hash,game_scope,evidence) SELECT a.table_id,a.hand_number,a.hand_id,pg_current_xact_id(),a.committed_at,a.payload_hash,p.game_scope,public.fn_pnl_cash_hand_evidence(a.table_id,a.hand_number) FROM public.hand_atomic_commits a JOIN public.cash_hand_provenance_receipts p USING(table_id,hand_number);COMMIT;"
  cash=e.database(db);e.sql(cash,cashseed+"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash,retained_at) SELECT hand_id,table_id,hand_number,'settled-native','9b300000-0000-4000-8000-000000000001',jsonb_build_object('p_stacks',accepted_request->'stacks','p_hand_row',accepted_request->'hand_row'),repeat('a',64),now()-interval '30 days' FROM cash_hand_provenance_receipts;INSERT INTO public.ca_hand_player_idx(user_id,hand_id,created_at,asset) SELECT '"+cashuser+"',id,created_at,'chips' FROM hand_history;",label='lifetime-connected-valid-v2-basis-seed')
  rpc="public.ca_player_stats_full('"+cashuser+"',NULL,'UTC','chips')"
  _,original_rpc,_=e.sql(cash,'SELECT '+rpc+';',label='lifetime-connected-original-rpc')
  rollback=e.database(cash);e.sql(rollback,"BEGIN;SET request.jwt.claim.role='service_role';SET app.smarter_data_actor='service';SELECT sp_prune_hand_history(250);ROLLBACK;",label='lifetime-connected-owner-rollback');check(rollback,"SELECT EXISTS(SELECT 1 FROM hand_history) AND EXISTS(SELECT 1 FROM ca_hand_player_idx) AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_index_retention_totals) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis);",'connected-prune-all-retention-effects-rollback');e.discard(rollback)
  e.sql(cash,"SET request.jwt.claim.role='service_role';SET app.smarter_data_actor='service';SELECT sp_prune_hand_history(250);",label='lifetime-connected-original-prune')
  check(cash,"SELECT NOT EXISTS(SELECT 1 FROM hand_history) AND NOT EXISTS(SELECT 1 FROM ca_hand_player_idx) AND (SELECT hands=1 FROM smarter_private.hand_index_retention_totals) AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id='"+cashhand+"' AND b.compact_stats#>'{facts,0,hole_cards}' IS NULL) AND (SELECT accepted_request#>'{hand_row,actions}' IS NULL FROM cash_hand_provenance_receipts);",'connected-owner-erases-raw-preserves-stats-and-lifetime')
  _,final_rpc,_=e.sql(cash,'SELECT '+rpc+';',label='lifetime-connected-final-rpc');a=json.loads(original_rpc);b=json.loads(final_rpc);a.pop('generated_at');b.pop('generated_at');assert a==b;passed.append('connected-original-prune-actual-rpc-identical')
  e.sql(cash,"SET request.jwt.claim.role='service_role';SET app.smarter_data_actor='service';SELECT sp_prune_hand_history(250);",label='lifetime-connected-repeat');check(cash,'SELECT '+rpc+"#>>'{lifetime,hands}';",'connected-repeat-keeps-exact-count','1');e.discard(cash)
 _,catalog,_=e.sql(case,"SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.ca_player_stats_full(uuid,integer,text,text)'::regprocedure,'public.fn_ca_hand_player_row_takes_its_hands_asset()'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure,'smarter_private.archive_pruned_hand_index(uuid[])'::regprocedure]);",label='lifetime-postimages')
 e.report['lifetime_qualified_postimage']=json.loads(catalog);e.report['lifetime_proven']=passed
 e.discard(case);e.discard(db)
 return passed
