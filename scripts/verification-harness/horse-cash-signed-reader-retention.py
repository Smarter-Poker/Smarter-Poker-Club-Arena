"""Original signed accounting reader vs exact retained cash certificate. Native only."""
from pathlib import Path
import sys,json,argparse,datetime,re
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012194340_original_cash_reader_accepts_certified_retention.sql')
def extract(path,anchor):
 s=path.read_text();start=s.index(anchor);tag=s.index('AS $function$',start)+len('AS $function$');end=s.index('$function$',tag)+len('$function$');return s[start:end]+';\n'
def prepare_fixture(e):
 F=ROOT/'tests/fixtures/original-unchanged-stack';OLD=ROOT/'tests/fixtures/union-pnl-blocked-resolution'
 base=e.database();files=[OLD/'schema.sql',F/'schema-additions.sql',F/'cents-preimage.sql',OLD/'captured-preimages.sql',OLD/'seed.sql',ROOT/'supabase/migrations/20260928050509_a_late_seat_credit_is_resolved_from_its_receipts_not_forgive.sql',F/'lineage-preimage.sql',F/'seed-original.sql',ROOT/'supabase/migrations/20261012161442_an_original_unchanged_stack_is_proved_from_its_accepted_pred.sql']
 setup=';\n'.join(p.read_text() for p in files).replace("2026-10-06 15:33:07+00","2026-10-01 15:33:07+00")
 e.sql(base,setup,label='maintained-foreign-native-originals')
 # Current production service has SELECT on these six original sources;
 # the foreign isolated fixture omitted those pre-existing role privileges.
 e.sql(base,'GRANT SELECT ON cash_hand_provenance_receipts,cash_hand_participant_manifests,union_pnl_cash_outcome_resolutions,cash_participant_funding_receipts,cash_funding_application_receipts,chip_ledger TO service_role;',label='captured-original-service-reader-select')
 e.sql(base,"""UPDATE cash_hand_provenance_receipts p SET accepted_request=accepted_request||jsonb_build_object('hand_row',jsonb_build_object('has_human',false,'tournament_id',NULL,'actions',jsonb_build_array(jsonb_build_object('action','call')),'hole_cards',jsonb_build_array('As','Kd'))) WHERE hand_number=199;
 UPDATE cash_hand_provenance_receipts SET payload_hash=encode(extensions.digest(convert_to(accepted_request::text,'UTF8'),'sha256'),'hex') WHERE hand_number=199;
 UPDATE cash_hand_provenance_receipts p SET atomic_receipt=jsonb_set(jsonb_set(atomic_receipt,'{payload_hash}',to_jsonb(payload_hash)),'{stack_result,request}',accepted_request-'hand_row') WHERE hand_number=199;
 UPDATE cash_hand_provenance_receipts SET stack_claim=jsonb_set(stack_claim,'{result}',atomic_receipt->'stack_result') WHERE hand_number=199;
 ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;UPDATE union_pnl_cash_outcomes o SET payload_hash=p.payload_hash FROM cash_hand_provenance_receipts p WHERE p.table_id=o.table_id AND p.hand_number=o.hand_number AND o.hand_number=199;ALTER TABLE union_pnl_cash_outcomes ENABLE TRIGGER original_pnl_immutable;""",label='bounded-original-horse-predecessor-constructor')
 table=ROOT/'supabase/migrations/20261012162707_settled_horse_cash_provenance_erases_original_play_contents.sql';s=table.read_text();start=s.index('CREATE TABLE smarter_private.horse_cash_payload_certificates');end=s.index('CREATE TRIGGER horse_cash_payload_certificate_immutable',start);oldcert=s[start:end]
 s=(ROOT/'supabase/migrations/20261012180419_horse_cash_retention_uses_its_original_completed_boundary.sql').read_text();start=s.index('CREATE TABLE smarter_private.horse_cash_postprune_certificates');end=s.index('CREATE FUNCTION smarter_private.horse_cash_postprune_certificate_immutable',start);newcert=s[start:end]
 def func(name):
  s=table.read_text();start=s.index('CREATE FUNCTION smarter_private.'+name);tag=s.index('AS $$',start)+len('AS $$');end=s.index('$$;',tag)+3;return s[start:end]
 e.sql(base,'CREATE SCHEMA smarter_private;'+oldcert+newcert+func('horse_cash_compact_request')+func('horse_cash_compact_atomic')+extract(ROOT/'supabase/migrations/20261012180419_horse_cash_retention_uses_its_original_completed_boundary.sql','CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retained_request_matches')+'REVOKE ALL ON FUNCTION smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;',label='exact-current-private-certificate-and-matcher')
 _,baseline,_=e.sql(base,"SELECT public.fn_union_pnl_prove_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200);",label='raw-original-new-consumer-baseline');assert json.loads(baseline)['status']=='proven'
 cert="""INSERT INTO smarter_private.horse_cash_payload_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,original_atomic_sha256,compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,live_atomic_sha256,accounting_evidence_sha256,accepted_at,settled_at)
 SELECT p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),encode(extensions.digest(convert_to(smarter_private.horse_cash_compact_request(p.accepted_request)::text,'UTF8'),'sha256'),'hex'),encode(extensions.digest(convert_to(smarter_private.horse_cash_compact_atomic(p.atomic_receipt)::text,'UTF8'),'sha256'),'hex'),encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),repeat('a',64),encode(extensions.digest(convert_to(o.evidence::text,'UTF8'),'sha256'),'hex'),p.accepted_at,p.accepted_at FROM cash_hand_provenance_receipts p JOIN union_pnl_cash_outcomes o USING(table_id,hand_number) WHERE p.hand_number=199;
 UPDATE cash_hand_provenance_receipts SET accepted_request=smarter_private.horse_cash_compact_request(accepted_request),atomic_receipt=smarter_private.horse_cash_compact_atomic(atomic_receipt) WHERE hand_number=199;"""
 e.sql(base,cert,label='native-original-sealed-retained-output-constructor')
 _,valid,_=e.sql(base,"SELECT smarter_private.horse_cash_retained_request_matches(table_id,hand_number,payload_hash,accepted_request) FROM cash_hand_provenance_receipts WHERE hand_number=199;",label='actual-private-certificate-validates-retained-output');assert valid.strip()=='t'
 _,failure,_=e.sql(base,"SELECT public.fn_union_pnl_prove_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200);",label='actual-foreign-consumer-rejects-legal-retained-predecessor');e.report['fail_before']=json.loads(failure);assert e.report['fail_before']['status']=='refused' and e.report['fail_before']['reason']=='predecessor_signed_stack_unproven'
 e.report['signed_reader_constructor_limit']='Uses native sealed retained-output constructor and unchanged real private certificate matcher; original cash compaction admission is independently qualified by retained41-case owner proof, not rerun here.'
 return base,baseline
def qualify(e):
 base,baseline=prepare_fixture(e);passed=['actual-reader-fails-before-certified-retained-predecessor'];before_definition=e.sql(base,"SELECT pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure);",label='exact-original-reader')[1]
 def read(d,q,label):return e.sql(d,q,label=label)[1].strip()
 def yes(d,q,label):
  v=read(d,q,label);assert v=='t',(label,v);passed.append(label)
 bridge='public.fn_cash_signed_retained_request_matches'
 q="SELECT public.fn_union_pnl_prove_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200);"
 money="SELECT jsonb_build_object('outcomes',(SELECT jsonb_agg(to_jsonb(o) ORDER BY hand_number) FROM union_pnl_cash_outcomes o),'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chip_ledger l),'manifests',(SELECT jsonb_agg(to_jsonb(m) ORDER BY hand_number) FROM cash_hand_participant_manifests m),'funding',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM cash_participant_funding_receipts f),'receipts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY hand_number) FROM cash_hand_provenance_receipts p));"
 proofs=re.findall(r'^-- @live-proof: (.+)$',(ROOT/MIGRATION).read_text(),re.M);assert len(proofs)==2
 for i,proof in enumerate(proofs):yes(base,'SELECT NOT COALESCE('+proof+',false);','new-postimage-proof-before-'+str(i))
 original_money=read(base,money,'original-financial-evidence');helper_before=read(base,"SELECT md5(pg_get_functiondef('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure));",'unchanged-original-helper-preimage')
 rollback=e.database(base);source=(ROOT/MIGRATION).read_text();e.sql(rollback,source.replace('COMMIT;','ROLLBACK;'),label='successor-install-rollback');yes(rollback,"SELECT to_regprocedure('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)') IS NULL AND md5(pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure))='d206687c92bd2e66c94bde8bcb63dbb9';",'installation-rollback-preserves-original-owner');e.discard(rollback)
 e.sql(base,file=ROOT/MIGRATION,label='exact-signed-reader-successor');code,_,err=e.sql(base,file=ROOT/MIGRATION,label='successor-replay-refusal',check=False);assert code and 'SIGNED_CASH_RETAINED_READER_PREIMAGE_CHANGED' in err;passed.append('successor-replay-refuses')
 for i,proof in enumerate(proofs):yes(base,'SELECT '+proof+';','new-postimage-proof-after-'+str(i))
 actual=json.loads(read(base,q,'certified-retained-predecessor-proven'));assert actual==json.loads(baseline);passed.append('same-exact-financial-proof-after-legal-content-compaction')
 assert read(base,money,'after-proof-financial-evidence')==original_money;passed.append('all-original-financial-evidence-byte-identical')
 # Independently show every original accounting clause is unchanged. Reversing
 # just the two qualified request checks recreates the exact original function.
 after_definition=e.sql(base,"SELECT pg_get_functiondef('public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure);",label='exact-successor-reader')[1]
 current="encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p.payload_hash";previous="encode(extensions.digest(convert_to(prev_receipt.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM prev_receipt.payload_hash"
 assert after_definition.replace('NOT public.fn_cash_signed_retained_request_matches(p_table_id,p_hand_number,p.payload_hash,p.accepted_request)',current).replace('NOT public.fn_cash_signed_retained_request_matches(p_table_id,prev_hn,prev_receipt.payload_hash,prev_receipt.accepted_request)',previous)==before_definition;passed.append('every-other-reader-byte-and-accounting-clause-unchanged')
 assert read(base,"SELECT md5(pg_get_functiondef('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure));",'unchanged-original-helper-postimage')==helper_before;passed.append('private-certificate-owner-byte-identical')
 yes(base,"SET ROLE service_role;SELECT bool_and(public.fn_cash_signed_retained_request_matches(table_id,hand_number,payload_hash,accepted_request)) FROM cash_hand_provenance_receipts;",'service-validates-full-current-and-certified-retained-original')
 yes(base,"SELECT NOT has_table_privilege('service_role','union_pnl_cash_outcomes','SELECT') AND NOT has_table_privilege('service_role','cash_seat_move_receipts','SELECT') AND NOT has_table_privilege('service_role','union_pnl_transaction_frames','SELECT');",'original-restricted-accounting-source-grants-unexpanded')
 for label,expression in [('unknown-pair',"'00000000-0000-4000-8000-000000000001',199,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a','{}'::jsonb"),('null-table',"NULL,hand_number,payload_hash,accepted_request"),('null-number',"table_id,NULL,payload_hash,accepted_request"),('null-hash',"table_id,hand_number,NULL,accepted_request"),('null-request',"table_id,hand_number,payload_hash,NULL"),('changed-hash',"table_id,hand_number,repeat('0',64),accepted_request"),('changed-json',"table_id,hand_number,payload_hash,accepted_request||'{\"rake\":1}'::jsonb")]:
  yes(base,'SET ROLE service_role;SELECT NOT '+bridge+'('+expression+') FROM cash_hand_provenance_receipts WHERE hand_number=199;',label+'-does-not-claim-original-authority')
 for role in ['anon','authenticated']:
  code,_,err=e.sql(base,'SET ROLE '+role+';SELECT '+bridge+"('10000000-0000-0000-0000-000000000001',199,repeat('a',64),'{}');",label=role+'-denied',check=False);assert code and 'permission denied' in err;passed.append(role+'-cannot-execute-private-evidence-bridge')
 for label,change in [('financial-seal',"UPDATE cash_hand_provenance_receipts SET rake=1 WHERE hand_number=199;"),('retained-json',"UPDATE cash_hand_provenance_receipts SET accepted_request=accepted_request||'{\"rake\":1}' WHERE hand_number=199;"),('missing-certificate',"DELETE FROM smarter_private.horse_cash_payload_certificates;")]:
  d=e.database(base);e.sql(d,change,label=label+'-isolated-negative');yes(d,'SET ROLE service_role;SELECT NOT '+bridge+'(table_id,hand_number,payload_hash,accepted_request) FROM cash_hand_provenance_receipts WHERE hand_number=199;',label+'-retained-original-refused');r=json.loads(read(d,q,label+'-reader-refuses'));assert r['status']=='refused';passed.append(label+'-accounting-proof-remains-refused');e.discard(d)
 # An unready current hand is still full; removing raw content without its
 # original qualified certificate is not a supported signed representation.
 unready=e.database(base);e.sql(unready,"UPDATE cash_hand_provenance_receipts SET accepted_request=accepted_request||'{\"hand_row\":{}}' WHERE hand_number=200;",label='unqualified-current-retention-negative');r=json.loads(read(unready,q,'unqualified-current-refused'));assert r['status']=='refused';passed.append('unready-current-no-certificate-stays-refused');e.discard(unready)
 e.report['signed_reader_postimages']=json.loads(read(base,"SELECT jsonb_object_agg(oid::regprocedure::text,jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'config',proconfig)) FROM pg_proc WHERE oid=ANY(ARRAY['public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure,'public.fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)'::regprocedure,'smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure]);",'signed-reader-final-metadata'))
 e.report['signed_reader_proven']=passed;e.report.setdefault('source_sha256',{}).update({str(MIGRATION):sha(ROOT/MIGRATION),'scripts/verification-harness/horse-cash-signed-reader-retention.py':sha(Path(__file__))});e.discard(base);return passed

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args();out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','signed_retained_native');sock='/Volumes/SmarterWork/agent-work/ahr-20261012-socket' if sys.platform=='darwin' else '/tmp';e=native.Execution(ROOT,out,a.pg_bin.resolve(),out,300,socket_parent=sock)
 try:e.start();qualify(e);e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:e.close();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(e.report.get('status'),e.report.get('failure'))
 return 0 if e.report.get('status')=='passed' else 1
if __name__=='__main__':sys.exit(main())
