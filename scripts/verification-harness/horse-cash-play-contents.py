"""Connected native phase, invoked by the existing settlement retention owner.
Every database is cloned from its new isolated PG17 source; no production access.
"""
from pathlib import Path
import json,subprocess
from satellite_qualifier_fixture import sha
MIG='supabase/migrations/20261012162707_settled_horse_cash_provenance_erases_original_play_contents.sql'
FIX='scripts/verification-harness/fixtures/horse-cash-play-contents'
H="ARRAY['c2000000-0000-4000-8000-000000000001'::uuid]"
P="'c1000000-0000-4000-8000-000000000001',1000001"
def qualify(e,template):
 root=e.root;passed=[]
 e.report['source_sha256'].update({str(p.relative_to(root)):sha(p) for p in [root/MIG,Path(__file__),*(root/FIX).iterdir()]})
 def check(db,sql,label,want='t'):
  _,actual,_=e.sql(db,sql,label='cash-'+label);assert actual.strip()==want,(label,actual);passed.append(label)
 base=e.database(template)
 # Exact current original outcome schema. Only its original ready rows qualify;
 # blocked/missing links keep the raw evidence needed by their repair consumers.
 source=(root/'supabase/migrations/20260917234315_union_weekly_pnl_uses_original_qualified_basis.sql').read_text()
 schema=source[source.index('CREATE TABLE public.union_pnl_transaction_frames'):source.index('CREATE FUNCTION public.fn_union_pnl_original_frame')]
 e.sql(base,schema,label='cash-original-outcome-schema')
 e.sql(base,(root/FIX/'immutable-preimage.sql').read_text()+';REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM PUBLIC,anon,authenticated,service_role;',label='cash-exact-immutable-preimage')
 seed=(root/FIX/'seed.sql').read_text()+"INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),now(),now()); INSERT INTO public.union_pnl_cash_outcomes(table_id,hand_number,hand_id,transaction_id,recognized_at,payload_hash,game_scope,evidence) SELECT a.table_id,a.hand_number,a.hand_id,pg_current_xact_id(),a.committed_at,a.payload_hash,p.game_scope,public.fn_pnl_cash_hand_evidence(a.table_id,a.hand_number) FROM public.hand_atomic_commits a JOIN public.cash_hand_provenance_receipts p USING(table_id,hand_number);"
 # The two seed inserts must share the original transaction identity.
 seed='BEGIN;'+seed+'COMMIT;'
 before=e.database(base);e.sql(before,seed,label='cash-before-seed');e.sql(before,"SELECT public.sp_prune_hand_history(250);",label='cash-before-original-prune');check(before,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL FROM public.cash_hand_provenance_receipts;",'raw-play-copy-remains-before');e.discard(before)
 e.sql(base,file=root/MIG,label='cash-candidate-install')
 code,_,err=e.sql(base,file=root/MIG,label='cash-migration-replay-refused',check=False);assert code and 'ALREADY_INSTALLED' in err;passed.append('migration-replay-refused')
 case=e.database(base);e.sql(case,seed,label='cash-certified-original-seed')
 check(case,"SELECT public.fn_pnl_cash_hand_evidence("+P+")->>'status';",'original-financial-ready','ready')
 snapshot="SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence("+P+"),'result',a.stack_result,'money',(SELECT jsonb_agg(to_jsonb(l)) FROM public.chip_ledger l),'manifest',(SELECT jsonb_agg(to_jsonb(m)) FROM public.cash_hand_participant_manifests m),'funding',(SELECT jsonb_agg(to_jsonb(f)) FROM public.cash_participant_funding_receipts f)) FROM public.hand_atomic_commits a;"
 _,original,_=e.sql(case,snapshot,label='cash-original-money-response-evidence')
 _,original_size,_=e.sql(case,"SELECT octet_length(accepted_request::text) FROM public.cash_hand_provenance_receipts;",label='cash-original-raw-bytes')
 e.sql(case,'SELECT smarter_private.compact_horse_settlement_keys('+H+');',label='cash-key-predecessor')
 rollback=e.database(case);e.sql(rollback,'BEGIN;SELECT smarter_private.compact_horse_cash_play_contents('+H+');ROLLBACK;',label='cash-original-transition-rollback');check(rollback,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates) FROM public.cash_hand_provenance_receipts;",'rollback-preserves-raw-and-no-certificate');e.discard(rollback)
 for name,change in [('reported',"UPDATE public.hand_history SET reported=true;"),('history-human',"UPDATE public.hand_history SET has_human=true;"),('history-unknown',"UPDATE public.hand_history SET has_human=NULL;"),('young',"UPDATE public.hand_history SET created_at=now();"),('unfinished',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL;"),('blocked-original-outcome',"UPDATE public.union_pnl_cash_outcomes SET evidence=jsonb_build_object('status','blocked','basis_certified',false);"),('missing-original-outcome','DELETE FROM public.union_pnl_cash_outcomes;')]:
  child=e.database(case);e.sql(child,change,label='cash-'+name+'-change');check(child,'SELECT smarter_private.compact_horse_cash_play_contents('+H+');',name+'-retained','0');e.discard(child)
 boundary=e.database(case);check(boundary,"BEGIN;UPDATE public.hand_history SET created_at=now()-interval '8 days';SELECT smarter_private.compact_horse_cash_play_contents("+H+");ROLLBACK;",'exact-eight-day-boundary-retained','0');e.discard(boundary)
 snapshot_race=e.database(case);argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',snapshot_race,'-v','ON_ERROR_STOP=1']
 reader=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  reader.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT public.fn_pnl_cash_hand_evidence("+P+");SELECT 'held';\n");reader.stdin.flush();old_view=json.loads(reader.stdout.readline());assert old_view['status']=='ready' and reader.stdout.readline().strip()=='held'
  check(snapshot_race,'SELECT smarter_private.compact_horse_cash_play_contents('+H+');','concurrent-writer-compacts','1')
  reader.stdin.write("SELECT public.fn_pnl_cash_hand_evidence("+P+");COMMIT;\n");reader.stdin.flush();same_view=json.loads(reader.stdout.readline());reader.stdin.close();reader.wait(timeout=10);assert reader.returncode==0 and old_view==same_view
  _,new_view,_=e.sql(snapshot_race,"SELECT public.fn_pnl_cash_hand_evidence("+P+");",label='cash-new-reader-after-commit');assert json.loads(new_view)==old_view;passed.append('old-and-new-accounting-snapshots-identical');e.report['cash_snapshot_race']={'repeatable_read_preserved':True,'new_committed_read_identical':True}
 finally:
  if reader.poll() is None:reader.terminate();reader.wait(timeout=10)
 e.discard(snapshot_race)
 check(case,'SELECT smarter_private.compact_horse_cash_play_contents('+H+');','qualified-play-copy-erased','1')
 check(case,"SELECT accepted_request#>'{hand_row,actions}' IS NULL AND accepted_request#>'{hand_row,hole_cards}' IS NULL AND accepted_request#>'{hand_row,board}' IS NULL AND accepted_request#>'{hand_row,players}' IS NULL AND accepted_request#>'{hand_row,showdown}' IS NULL AND accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}' IS NULL AND atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL FROM public.cash_hand_provenance_receipts;",'raw-cards-actions-players-stats-erased')
 _,final,_=e.sql(case,snapshot,label='cash-final-money-response-evidence');assert json.loads(original)==json.loads(final);passed.append('live-money-manifest-funding-response-evidence-identical')
 check(case,'SELECT smarter_private.compact_horse_cash_play_contents('+H+');','repeat-noop','0')
 _,sizes,_=e.sql(case,"SELECT jsonb_build_object('original_hash_preserved',c.original_request_sha256=p.payload_hash,'stored_request_bytes',octet_length(p.accepted_request::text)) FROM public.cash_hand_provenance_receipts p JOIN smarter_private.horse_cash_payload_certificates c USING(table_id,hand_number);",label='cash-erased-payload-size');e.report['cash_payload_size']=dict(json.loads(sizes),original_request_bytes=int(original_size.strip()))
 # Exact original replay survives both accepted-request and stats copy erasure.
 call="SELECT public.fn_ca_settle_hand_stacks_absolute('c1000000-0000-4000-8000-000000000001',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0);"
 _,response,_=e.sql(case,call,label='cash-replay');assert json.loads(response)==dict(json.loads(original)['result'],replay=True);passed.append('exact-original-replay-after-erasure')
 code,_,err=e.sql(case,call.replace("0,0,'',0","1,0,'',0"),label='cash-changed-replay-refused',check=False);assert code and 'different payload' in err;passed.append('different-payload-replay-refused')
 for name,change in [('original-request-human',lambda x:x.replace('"has_human":false','"has_human":true')),('original-request-unknown',lambda x:x.replace('"has_human":false','"has_human":null')),('original-request-mixed',lambda x:x.replace('"is_horse":true','"is_horse":false',1))]:
  child=e.database(base);e.sql(child,change(seed),label='cash-'+name+'-seed');e.sql(child,'SELECT smarter_private.compact_horse_settlement_keys('+H+');',label='cash-'+name+'-key');check(child,'SELECT smarter_private.compact_horse_cash_play_contents('+H+');',name+'-retained','0');e.discard(child)
 for name,sql in [('identity',"UPDATE public.cash_hand_provenance_receipts SET payload_hash=repeat('0',64);"),('restore',"UPDATE public.cash_hand_provenance_receipts SET accepted_request=jsonb_set(accepted_request,'{hand_row,actions}','[]');"),('financial-change',"UPDATE public.cash_hand_provenance_receipts SET rake=1;"),('delete','DELETE FROM public.cash_hand_provenance_receipts;'),('truncate','TRUNCATE public.cash_hand_provenance_receipts;'),('certificate-delete','DELETE FROM smarter_private.horse_cash_payload_certificates;'),('unauthorized',"SET ROLE service_role; SELECT smarter_private.compact_horse_cash_play_contents("+H+");")]:
  code,_,err=e.sql(case,sql,label='cash-refuse-'+name,check=False);assert code and ('immutable' in err.lower() or 'permission denied' in err);passed.append('refuse-'+name)
 integrated=e.database(base);e.sql(integrated,seed,label='cash-integrated-seed');check(integrated,'SELECT public.sp_prune_hand_history(250);','original-prune-invokes-play-erasure','1');check(integrated,"SELECT public.fn_pnl_cash_hand_evidence("+P+")->>'status';",'financial-ready-after-history-deletion','ready');check(integrated,"SELECT NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits) AND NOT EXISTS(SELECT 1 FROM public.hand_history) AND accepted_request#>'{hand_row,actions}' IS NULL FROM public.cash_hand_provenance_receipts;",'integrated-prune-erases-all-targeted-play-copies');e.discard(integrated)
 tampered=e.database(case);e.sql(tampered,"ALTER TABLE public.cash_hand_provenance_receipts DISABLE TRIGGER cash_hand_provenance_immutable;UPDATE public.cash_hand_provenance_receipts SET accepted_request=jsonb_set(accepted_request,'{rake}','1'::jsonb);",label='cash-isolated-hash-tamper');check(tampered,"SELECT public.fn_pnl_cash_hand_evidence("+P+")->>'status';",'certificate-conflicting-financial-copy-blocked','blocked');e.discard(tampered)
 _,catalog,_=e.sql(base,"SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'secdef',p.prosecdef,'config',p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure,'public.fn_cash_provenance_immutable()'::regprocedure,'smarter_private.compact_horse_cash_play_contents(uuid[])'::regprocedure,'smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure,'smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)'::regprocedure]);",label='cash-qualified-postimage');e.report['cash_qualified_postimage']=json.loads(catalog)
 e.discard(case);e.discard(base);e.report['cash_play_contents_proven']=passed
 return passed
