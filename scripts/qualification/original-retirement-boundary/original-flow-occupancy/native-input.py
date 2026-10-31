"""Qualify only in existing finite-original isolated native database."""
from pathlib import Path
import os,json
P=Path(__file__).resolve().parent
m=Path(os.environ['ORB_ORIGINAL_OCCUPANCY_FLOW_MIGRATION']).read_text().strip();assert m.endswith('COMMIT;')
body=m.replace('BEGIN;','',1).removesuffix('COMMIT;')
posts=json.loads((P.parents[2]/'ci/fixtures/original-flow-occupancy/expected-postimages.json').read_text())
meta="CREATE TEMP TABLE occupancy_meta AS SELECT p.oid,to_jsonb(p)-'prosrc'm FROM pg_proc p WHERE p.oid IN("+','.join("'"+r['signature']+"'::regprocedure"for r in posts)+");"
check="DO $actual$BEGIN IF EXISTS(SELECT FROM occupancy_meta m JOIN pg_proc p ON p.oid=m.oid WHERE m.m IS DISTINCT FROM(to_jsonb(p)-'prosrc'))THEN RAISE EXCEPTION 'occupancy_metadata_acl_changed';END IF;"
for r in posts:check+="IF md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))<>'"+r['post_md5']+"'THEN RAISE EXCEPTION 'occupancy_wrong_postimage';END IF;"
check+="END$actual$;"
parity="""DO $parity$DECLARE a jsonb;b jsonb;c jsonb;BEGIN
 SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id)INTO a FROM occupancy_old_full f;
 SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id)INTO b FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')f;
 SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id)INTO c FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-26 07:00Z')f;
 IF a IS DISTINCT FROM b OR a IS DISTINCT FROM c THEN RAISE EXCEPTION 'occupancy_original_witness_financial_parity_failed';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'occupancy_source65_failed';END IF;
 RAISE NOTICE 'PASS actual initial-receipt original event/refund branches duplicates NULL foreign missing keys full/window financial parity';
END$parity$;"""
qualification_sql=meta+(P/'witness-cases.sql').read_text()+body+check+parity+'ROLLBACK TO SAVEPOINT original_occupancy_cases;\nRELEASE SAVEPOINT original_occupancy_cases;\n'+body+check
qualification_sql+="DO $replay$BEGIN BEGIN EXECUTE $followup_replay$"+body+"$followup_replay$;RAISE EXCEPTION 'occupancy_replay_unexpectedly_passed';EXCEPTION WHEN SQLSTATE 'P0001'THEN IF SQLERRM<>'original_flow_occupancy_preimage_changed:0'THEN RAISE;END IF;END;RAISE NOTICE 'PASS occupancy exact installer rollback metadata ACL replay source65';END$replay$;"

qualification_sql+="SAVEPOINT occupancy_readonly;SET LOCAL transaction_read_only=on;DO $readonly$BEGIN IF(SELECT count(*)FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z'))<>91 OR(SELECT count(*)FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-26 07:00Z'))<>91 THEN RAISE EXCEPTION 'occupancy_readonly_original91_missing';END IF;RAISE NOTICE 'PASS actual new65 whole/window readers in enforced transaction_read_only context';END$readonly$;ROLLBACK TO SAVEPOINT occupancy_readonly;RELEASE SAVEPOINT occupancy_readonly;"
