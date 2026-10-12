"""Real accepted stats vs earlier cash snapshot; original owners only, native PG.
Called after the maintained facts/snapshot/lifetime qualification template.
No production access, invented live witness or financial restoration.
"""
from pathlib import Path
import json,subprocess
from satellite_qualifier_fixture import module,sha
MIG=Path('supabase/migrations/20261012174519_horse_cash_retention_uses_its_original_completed_boundary.sql')
T='c1000000-0000-4000-8000-000000000001';H='c2000000-0000-4000-8000-000000000001';U='c5000000-0000-4000-8000-000000000001'
IDS="ARRAY['"+H+"'::uuid]"; P="'"+T+"',1000001"
def qualify(e,template):
 root=e.root;passed=[];base=e.database(template)
 _,batch_hash,_=e.sql(base,"SELECT md5(pg_get_functiondef('smarter_private.compact_horse_fact_cards(uuid[])'::regprocedure));",label='actual-batch-parent-identity');assert batch_hash.strip()=='05dc7e667f5d8353c63212c708103c58';e.report['cash_phase_batch_parent_md5']=batch_hash.strip()
 e.report.setdefault('source_sha256',{}).update({str(MIG):sha(root/MIG),'scripts/verification-harness/horse-cash-producer-phase-retention.py':sha(Path(__file__))})
 old=module(root/'scripts/ci/test-hand-submission-retention-disposal.py','cash_phase_old')
 def yes(d,q,label):
  _,v,_=e.sql(d,q,label='cashphase-'+label);assert v.strip()=='t',(label,v);passed.append(label)
 def read(d,q,label):return e.sql(d,q,label='cashphase-'+label)[1].strip()
 stats=json.dumps({'version':2,'facts':[{'hand_id':H,'table_id':T,'user_id':U,'hole_cards':['As','Kd'],'net':0,'rake_paid':0,'vpip':True}],'transfers':[]},separators=(',',':'))
 raw=(root/'scripts/verification-harness/fixtures/horse-cash-play-contents/seed.sql').read_text().replace('{"version":1,"private_holding":["As","Kd"]}',stats)
 # Actual receipt phase: the live atomic owner later completes accepted facts.
 # The immutable CASH snapshot was captured earlier with these columns NULL.
 snapshot="to_jsonb(a)||jsonb_build_object('post_commit_payload',NULL,'post_commit_completed_at',NULL,'post_commit_result',NULL,'post_commit_request_hash',NULL,'post_commit_payload_hash',NULL)"
 assert raw.count("to_jsonb(a),to_jsonb(k),to_jsonb(c)")==1
 raw=raw.replace("to_jsonb(a),to_jsonb(k),to_jsonb(c)",snapshot+",to_jsonb(k),to_jsonb(c)")
 # The previous synchronous fixture made both rows equal and never exercised
 # the real outer completion seal. Derive it by the actual owner's contract.
 seal_live="UPDATE public.hand_atomic_commits SET post_commit_payload_hash=encode(extensions.digest(convert_to(post_commit_payload::text,'UTF8'),'sha256'),'hex'),post_commit_request_hash=encode(extensions.digest(convert_to((post_commit_payload-'accepted_hand_facts')::text,'UTF8'),'sha256'),'hex'),post_commit_result=jsonb_build_object('ok',true,'hand_id',hand_id,'hand_number',hand_number);"
 assert raw.count('INSERT INTO public.cash_hand_provenance_receipts(')==1
 raw=raw.replace('INSERT INTO public.cash_hand_provenance_receipts(',seal_live+'INSERT INTO public.cash_hand_provenance_receipts(')
 seal="INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),now(),now());INSERT INTO public.union_pnl_cash_outcomes(table_id,hand_number,hand_id,transaction_id,recognized_at,payload_hash,game_scope,evidence) SELECT a.table_id,a.hand_number,a.hand_id,pg_current_xact_id(),a.committed_at,a.payload_hash,p.game_scope,public.fn_pnl_cash_hand_evidence(a.table_id,a.hand_number) FROM public.hand_atomic_commits a JOIN public.cash_hand_provenance_receipts p USING(table_id,hand_number);"
 request="INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash,retained_at) SELECT hand_id,table_id,hand_number,'settled-native','9b300000-0000-4000-8000-000000000001',jsonb_build_object('p_stacks',accepted_request->'stacks','p_hand_row',accepted_request->'hand_row'),repeat('a',64),now()-interval '30 days' FROM cash_hand_provenance_receipts;"
 seed="BEGIN;INSERT INTO public.hand_history_retention_policy(horse_retention_days) VALUES(8);"+raw+seal+request+'COMMIT;'
 snap="INSERT INTO public.hand_state_snapshots(id,table_id,hand_number,state_json,config_json,dealer_seat,players_json,created_at,updated_at,is_complete) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','"+T+"',1000001,'{\"cards\":[\"As\"],\"actions\":[{\"action\":\"call\"}]}','{}',1,jsonb_build_array(jsonb_build_object('user_id','"+U+"','is_horse',true)),now()-interval '40 days',now()-interval '40 days',true);"
 financial="SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence("+P+"),'money',(SELECT jsonb_agg(to_jsonb(l)) FROM public.chip_ledger l),'manifest',(SELECT jsonb_agg(to_jsonb(m)) FROM cash_hand_participant_manifests m),'funding',(SELECT jsonb_agg(to_jsonb(f)) FROM cash_participant_funding_receipts f));"
 original=e.database(base);e.sql(original,seed+snap,label='real-original-producer-phase')
 yes(original,"SELECT accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}' IS NOT NULL AND atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL FROM cash_hand_provenance_receipts;",'real-request-stats-present-earlier-cash-snapshot-stats-absent')
 yes(original,"SELECT public.fn_pnl_cash_hand_evidence("+P+")->>'status'='ready';",'real-original-accounting-ready')
 money=read(original,financial,'original-financial-all-rows')
 retired=e.database(original);e.sql(retired,old.AUTHORITY+'SELECT public.sp_prune_hand_history(250);',label='old-real-phase-prune')
 yes(retired,"SELECT NOT EXISTS(SELECT 1 FROM hand_history) AND NOT EXISTS(SELECT 1 FROM hand_atomic_commits) AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates) AND EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates) AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates) AND accepted_request#>'{hand_row,actions}' IS NOT NULL FROM cash_hand_provenance_receipts;",'fail-before-original-boundary-deleted-cash-copy-never-compacted')
 yes(retired,'SELECT smarter_private.compact_horse_cash_play_contents('+IDS+')=0;','fail-before-later-compaction-cannot-use-missing-live-boundary')
 # The candidate must retain both future live originals and the separate
 # independently certified post-prune route, without a new live-row hash.
 e.sql(base,file=root/MIG,label='candidate-install')
 code,_,err=e.sql(base,file=root/MIG,label='migration-replay',check=False);assert code and 'ALREADY_INSTALLED' in err;passed.append('migration-replay-refused')
 e.sql(retired,file=root/MIG,label='existing-certified-retirement-successor')
 rollback=e.database(retired);e.sql(rollback,'BEGIN;SELECT smarter_private.compact_horse_cash_play_contents('+IDS+');ROLLBACK;',label='post-prune-rollback')
 yes(rollback,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates) FROM cash_hand_provenance_receipts;",'rollback-preserves-original-cash-and-no-new-certificate');e.discard(rollback)
 for name,change in [('missing-original-certificate','ALTER TABLE smarter_private.horse_adaptive_disposal_certificates DISABLE TRIGGER USER;DELETE FROM smarter_private.horse_adaptive_disposal_certificates;ALTER TABLE smarter_private.horse_adaptive_disposal_certificates ENABLE TRIGGER USER;'),('missing-original-basis','ALTER TABLE smarter_private.horse_retained_stats_basis DISABLE TRIGGER USER;DELETE FROM smarter_private.horse_retained_stats_basis;ALTER TABLE smarter_private.horse_retained_stats_basis ENABLE TRIGGER USER;'),('blocked-original-seal',"UPDATE union_pnl_cash_outcomes SET evidence='{\"status\":\"blocked\",\"basis_certified\":false}';"),('missing-key-certificate','ALTER TABLE smarter_private.horse_settlement_key_certificates DISABLE TRIGGER USER;DELETE FROM smarter_private.horse_settlement_key_certificates;ALTER TABLE smarter_private.horse_settlement_key_certificates ENABLE TRIGGER USER;'),('new-report',"INSERT INTO bbj_payouts VALUES('"+T+"',1000001);"),('present-conflicting-snapshot-stats',"ALTER TABLE cash_hand_provenance_receipts DISABLE TRIGGER USER;UPDATE cash_hand_provenance_receipts SET atomic_receipt=jsonb_set(atomic_receipt,'{post_commit_payload}','{\"accepted_hand_facts\":{\"stats_facts\":{\"version\":1}}}');ALTER TABLE cash_hand_provenance_receipts ENABLE TRIGGER USER;")]:
  case=e.database(retired);e.sql(case,change,label=name+'-isolated-negative-fixture');yes(case,'SELECT smarter_private.compact_horse_cash_play_contents('+IDS+')=0;',name+'-refuses-erasure');yes(case,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates) FROM cash_hand_provenance_receipts;",name+'-original-bytes-remain');e.discard(case)
 race=e.database(retired);argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',race,'-v','ON_ERROR_STOP=1']
 reader=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  reader.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ;"+financial+"SELECT 'held';\n");reader.stdin.flush();old_view=json.loads(reader.stdout.readline());assert reader.stdout.readline().strip()=='held'
  yes(race,'SELECT smarter_private.compact_horse_cash_play_contents('+IDS+')=1;','concurrent-real-post-prune-compaction')
  reader.stdin.write(financial+'COMMIT;\n');reader.stdin.flush();assert json.loads(reader.stdout.readline())==old_view;reader.stdin.close();reader.wait(timeout=10);assert reader.returncode==0
  assert json.loads(read(race,financial,'new-accounting-reader'))==old_view;passed.append('old-repeatable-reader-and-new-committed-reader-financial-evidence-identical')
 finally:
  if reader.poll() is None:reader.terminate();reader.wait(timeout=10)
 e.discard(race)
 yes(retired,'SELECT smarter_private.compact_horse_cash_play_contents('+IDS+')=1;','independently-certified-post-prune-copy-compacts')
 assert json.loads(read(retired,financial,'post-prune-financial'))==json.loads(money);passed.append('all-original-money-funding-manifest-accounting-evidence-identical')
 yes(retired,"SELECT accepted_request#>'{hand_row,actions}' IS NULL AND accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}' IS NULL AND EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates) FROM cash_hand_provenance_receipts;",'separate-original-boundary-certificate-no-invented-live-atomic-hash')
 yes(retired,'SELECT smarter_private.compact_horse_cash_play_contents('+IDS+')=0;','post-prune-repeat-noop')
 replay="SELECT public.fn_ca_settle_hand_stacks_absolute('"+T+"',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0);"
 expected=json.loads(read(retired,'SELECT result FROM key_test.original;','original-stack-response'));assert json.loads(read(retired,replay,'exact-replay'))==dict(expected,replay=True);passed.append('exact-original-replay-after-post-prune-retirement')
 code,_,err=e.sql(retired,replay.replace("0,0,'',0","1,0,'',0"),label='changed-replay',check=False);assert code and 'different payload' in err;passed.append('changed-payload-replay-refused')
 for q in ['UPDATE smarter_private.horse_cash_postprune_certificates SET original_boundary_sha256=repeat(\'0\',64);','DELETE FROM smarter_private.horse_cash_postprune_certificates;','TRUNCATE smarter_private.horse_cash_postprune_certificates;','SET ROLE service_role;SELECT smarter_private.compact_horse_cash_play_contents('+IDS+');']:
  code,_,err=e.sql(retired,q,label='certificate-or-helper-authority',check=False);assert code and ('IMMUTABLE' in err or 'permission denied' in err);passed.append('post-prune-certificate-or-helper-mutation-refused')
 forward=e.database(base);e.sql(forward,seed+snap,label='future-original-producer-phase');future_money=read(forward,financial,'future-original-financial-before');yes(forward,'SELECT smarter_private.horse_cash_retention_accounting_ready('+P+');','forward-ready-cash-eligible-before-disposal');e.sql(forward,old.AUTHORITY+'SELECT sp_prune_hand_history(250);',label='future-original-owner')
 yes(forward,"SELECT NOT EXISTS(SELECT 1 FROM hand_history) AND NOT EXISTS(SELECT 1 FROM hand_atomic_commits) AND EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates) AND accepted_request#>'{hand_row,actions}' IS NULL FROM cash_hand_provenance_receipts;",'forward-real-phase-compacts-cash-before-original-deletion')
 assert json.loads(read(forward,financial,'future-financial'))==json.loads(future_money);passed.append('future-original-financial-evidence-identical')
 e.sql(forward,'SELECT sp_prune_hand_state_snapshots(250);',label='ready-snapshot-owner');yes(forward,'SELECT NOT EXISTS(SELECT 1 FROM hand_state_snapshots);','ready-cash-snapshot-qualifies-after-retention');e.discard(forward)
 # A missing cash receipt is unavailable accounting, never a non-cash default.
 missing=e.database(base);e.sql(missing,seed+'ALTER TABLE cash_hand_provenance_receipts DISABLE TRIGGER USER;DELETE FROM cash_hand_provenance_receipts;ALTER TABLE cash_hand_provenance_receipts ENABLE TRIGGER USER;',label='missing-cash-receipt-fixture');yes(missing,'SELECT NOT smarter_private.horse_cash_retention_accounting_ready('+P+');','missing-cash-provenance-protects-original-boundary');e.sql(missing,old.AUTHORITY+'SELECT sp_prune_hand_history(250);',label='missing-cash-original-owner');yes(missing,"SELECT EXISTS(SELECT 1 FROM hand_history) AND EXISTS(SELECT 1 FROM hand_atomic_commits) AND request<>'{}'::jsonb FROM smarter_private.hand_submissions;",'missing-cash-all-original-owners-retained');e.discard(missing)
 yes(base,"SELECT smarter_private.horse_cash_retention_accounting_ready(NULL,NULL) AND NOT smarter_private.horse_cash_retention_accounting_ready('00000000-0000-4000-8000-000000000009',1);",'unattached-only-default-unknown-table-protected')
 e.sql(base,"INSERT INTO public.tournaments(id,status) VALUES('00000000-0000-4000-8000-000000000007','COMPLETED');INSERT INTO public.tables(id,name,game_type,tournament_id) VALUES('00000000-0000-4000-8000-000000000008','Native original tournament owner','tournament','00000000-0000-4000-8000-000000000007');",label='verified-tournament-owner-fixture')
 yes(base,"SELECT smarter_private.horse_cash_retention_accounting_ready('00000000-0000-4000-8000-000000000008',1);",'verified-tournament-owner-does-not-require-cash-receipt')
 # Change only the isolated original accepted funding classification before
 # sealing it; this is a failed original source, not a manufactured ready seal.
 blocked=e.database(base);e.sql(blocked,seed+snap+'ALTER TABLE cash_hand_provenance_receipts DISABLE TRIGGER USER;UPDATE cash_hand_provenance_receipts SET status=\'uncertified\',funding_provenance_complete=false,issues=\'["game_asset_or_union_scope_unproven"]\';ALTER TABLE cash_hand_provenance_receipts ENABLE TRIGGER USER;ALTER TABLE cash_hand_participant_manifests DISABLE TRIGGER USER;UPDATE cash_hand_participant_manifests SET funding_provenance_complete=false,issues=\'["game_asset_or_union_scope_unproven"]\';ALTER TABLE cash_hand_participant_manifests ENABLE TRIGGER USER;UPDATE union_pnl_cash_outcomes SET evidence=public.fn_pnl_cash_hand_evidence('+P+');',label='original-unproven-funding-fixture')
 yes(blocked,'SELECT NOT smarter_private.horse_cash_retention_accounting_ready('+P+');','original-unproven-funding-protected')
 code,_,err=e.sql(blocked,old.AUTHORITY+'SELECT smarter_private.hand_submission_retention_disposal('+IDS+',\'Native original accounting custody proof\');',label='blocked-direct-disposal-owner-refuses',check=False)
 assert code and 'immutable' in err.lower();passed.append('blocked-direct-disposal-cannot-bypass-raw-owner-custody')
 # Retained immutable certificates may predate the stronger custody gate.
 # Reproduce their real original insert before invoking the new prune owner.
 data=json.loads((root/'scripts/verification-harness/horse-fact-card-preimage.json').read_text())
 source=next(f['definition'] for f in data['functions'] if f['signature'].startswith('smarter_private.hand_submission_retention_disposal'))
 start=source.index('  INSERT INTO smarter_private.hand_submission_disposals');end=source.index('  GET DIAGNOSTICS',start)
 insert=source[start:end].replace('p_hand_ids',IDS).replace('p_reason',"'Native earlier original settled-hand disposal accounting proof'")
 e.sql(blocked,insert+'SELECT smarter_private.capture_horse_adaptive_disposals('+IDS+');SELECT smarter_private.capture_horse_stats_basis('+IDS+');SELECT sp_prune_hand_history(250);SELECT sp_prune_hand_state_snapshots(250);',label='unproven-funding-original-owners')
 yes(blocked,"SELECT EXISTS(SELECT 1 FROM hand_history) AND EXISTS(SELECT 1 FROM hand_atomic_commits) AND EXISTS(SELECT 1 FROM hand_state_snapshots) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates) AND (SELECT request<>'{}'::jsonb FROM smarter_private.hand_submissions) AND accepted_request#>'{hand_row,actions}' IS NOT NULL FROM cash_hand_provenance_receipts;",'blocked-accounting-keeps-raw-history-atomic-snapshot-cash-originals')
 e.discard(blocked);e.discard(original);e.discard(retired)
 _,cat,_=e.sql(base,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'config',proconfig)) FROM pg_proc p WHERE p.oid=ANY(ARRAY['smarter_private.horse_cash_retention_accounting_ready(uuid,bigint)'::regprocedure,'smarter_private.horse_cash_retained_boundary_digest(uuid,bigint)'::regprocedure,'smarter_private.horse_cash_postprune_certificate_immutable()'::regprocedure,'smarter_private.compact_horse_cash_play_contents(uuid[])'::regprocedure,'smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure,'smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)'::regprocedure,'public.fn_cash_provenance_immutable()'::regprocedure,'smarter_private.hand_submission_immutable()'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure,'smarter_private.horse_snapshot_disposable(uuid)'::regprocedure]);",label='final-qualified-postimages')
 e.report['cash_producer_phase_postimages']=json.loads(cat);e.report['cash_producer_phase_proven']=passed;e.discard(base);return passed
