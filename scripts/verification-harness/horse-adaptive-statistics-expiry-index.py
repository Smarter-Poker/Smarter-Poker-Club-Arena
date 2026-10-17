#!/usr/bin/env python3
"""Focused whole-owner expiry qualification; no production access.

Empty retention tables isolate expiry. The ONLY branch-control leaf stub is
register_horse_adaptive_batch_membership: one finite2.1s sleep then ready=true.
It forces the original owner's deadline ELSE without modifying owner bytes.
Unchanged hand/financial guards are covered by the parent retention harness.
"""
from pathlib import Path
import argparse,datetime,hashlib,json,sys
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,lit
MIGRATION=Path('supabase/migrations/20261016214822_ordinary_adaptive_statistics_expiry_uses_age_index.sql')
ORIGINAL=Path('supabase/migrations/20261015022307_horse_adaptive_retirement_groups_hands_by_shared_batch.sql')

def qualify(e):
 checks=[]
 def sql(d,q,label):return e.sql(d,q,label='expiry-'+label)[1].strip()
 def yes(d,q,label):assert sql(d,q,label)=='t',label;checks.append(label)
 d=e.database()
 age=(ROOT/'supabase/migrations/20261012170542_horse_adaptive_raw_facts_become_exact_sufficient_statistics.sql').read_text();stats=age[age.index('CREATE TABLE smarter_private.horse_adaptive_statistics('):age.index('CREATE TABLE smarter_private.horse_adaptive_observation_fences(')]
 sql(d,"""CREATE ROLE service_role; CREATE SCHEMA smarter_private;
 CREATE TABLE public.horse_adaptive_journal_work(batch_key text PRIMARY KEY,state text,completed_at timestamptz);
 CREATE TABLE public.horse_adaptive_observation_batches(batch_key text PRIMARY KEY,canonical_payload text,retention_membership_ready boolean,recorded_at timestamptz);
 CREATE TABLE smarter_private.horse_adaptive_retention_activation(singleton boolean PRIMARY KEY,enabled boolean,scan_after_qualified_at timestamptz,scan_after_hand_id uuid,scan_through_qualified_at timestamptz,scan_through_hand_id uuid);
 INSERT INTO smarter_private.horse_adaptive_retention_activation VALUES(true,false,NULL,NULL,NULL,NULL);
 CREATE TABLE smarter_private.horse_adaptive_disposal_certificates(hand_id uuid PRIMARY KEY,hand_digest text,qualified_at timestamptz,retired_at timestamptz,raw_format_version integer);
 CREATE TABLE smarter_private.horse_adaptive_batch_hand_membership(hand_digest text,batch_key text,PRIMARY KEY(hand_digest,batch_key));
 CREATE FUNCTION smarter_private.register_horse_adaptive_batch_membership(text) RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2.1); UPDATE public.horse_adaptive_observation_batches SET retention_membership_ready=true WHERE batch_key=$1; END$$;
 """+stats,'isolated-real-statistics-schema-and-explicit-branch-leaf')
 source=(ROOT/ORIGINAL).read_text();start=source.index('CREATE OR REPLACE FUNCTION public.fn_prune_horse_adaptive_journal()');finish=source.index('REVOKE ALL ON FUNCTION',start);sql(d,source[start:finish]+"REVOKE ALL ON FUNCTION public.fn_prune_horse_adaptive_journal() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_prune_horse_adaptive_journal() TO service_role;",'original-exact-owner')
 yes(d,"SELECT md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure))='70231d2cc066971c13a269b5cc374be8';",'original702-postimage')
 original=sql(d,"SELECT pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure);",'original-definition');(e.output/'expiry-original-owner.sql').write_text(original+'\n')
 # Empty/no-expired large cohort reproduces the expensive leaf safely.
 insert="INSERT INTO smarter_private.horse_adaptive_statistics SELECT lpad(to_hex(i),64,'0'),repeat('a',64),repeat('b',64),'training',repeat('c',64),'horse_policy',floor(extract(epoch FROM(clock_timestamp()-interval '29 days'))*1000)::bigint,'call',1 FROM generate_series(1,100000)i; ANALYZE smarter_private.horse_adaptive_statistics;"
 sql(d,insert,'100k-no-expired-fixture')
 trace="LOAD 'auto_explain'; SET client_min_messages=log; SET auto_explain.log_min_duration=0; SET auto_explain.log_nested_statements=on; SET auto_explain.log_format=json;"
 _,_,beforelog=e.sql(d,trace+'SELECT fn_prune_horse_adaptive_journal();',label='expiry-original-whole-owner-nested-plans');assert 'Seq Scan' in beforelog and 'horse_adaptive_statistics' in beforelog;checks.append('original-whole-owner-volatile-age-seqscan')
 sql(d,(ROOT/MIGRATION).read_text(),'candidate-migration')
 candidate=sql(d,"SELECT pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure);",'candidate-definition');(e.output/'expiry-candidate-owner.sql').write_text(candidate+'\n')
 expected=original.replace("retired_hands text[]:='{}'; kept jsonb;","retired_hands text[]:='{}'; kept jsonb; statistics_cutoff_ms bigint;").replace(" IF clock_timestamp()<deadline THEN\n  WITH expired AS"," statistics_cutoff_ms:=floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint;\n IF clock_timestamp()<deadline THEN\n  WITH expired AS").replace("WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1000)","WHERE observed_at_ms<statistics_cutoff_ms LIMIT 1000)").replace("IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics\n   WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1)","IF (SELECT min(observed_at_ms) FROM smarter_private.horse_adaptive_statistics)<statistics_cutoff_ms")
 assert candidate==expected;checks.append('whole-owner-only-four-reviewed-anchors-changed')
 yes(d,"SELECT proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'] FROM pg_proc WHERE oid='public.fn_prune_horse_adaptive_journal()'::regprocedure;",'owner-acl-secdef-config-unchanged')
 _,_,afterlog=e.sql(d,trace+'SELECT fn_prune_horse_adaptive_journal();',label='expiry-candidate-whole-owner-nested-plans');assert 'horse_adaptive_statistics_age' in afterlog;checks.append('actual-plpgsql-cutoff-variable-age-index')
 code,_,err=e.sql(d,(ROOT/MIGRATION).read_text(),label='expiry-replay-refused',check=False);assert code!=0 and 'ADAPTIVE_EXPIRY_INDEX_PREIMAGE_CHANGED' in err;checks.append('migration-replay-refused')
 yes(d,"SELECT count(*)=100000 FROM smarter_private.horse_adaptive_statistics;",'no-expired-postimage-preserved')
 def receipt(label,force=False,two=False):
  if force:sql(d,"INSERT INTO public.horse_adaptive_observation_batches VALUES('a','',false,now())"+( ",('b','',false,now())" if two else '')+";",label+'-force-deadline')
  _,out,log=e.sql(d,trace+'SELECT fn_prune_horse_adaptive_journal();',label='expiry-'+label)
  r=json.loads(out);sql(d,'DELETE FROM public.horse_adaptive_observation_batches;',label+'-branch-reset');return r,log
 r,_=receipt('no-expired-before-deadline');assert r['statisticsExpired']==0 and not r['budgetReached'];checks.append('whole-owner-no-expired-delete-branch')
 r,log=receipt('no-expired-after-deadline',True);assert r['statisticsExpired']==0 and not r['budgetReached'] and 'horse_adaptive_statistics_age' in log and 'Index Only Scan' in log;checks.append('whole-owner-expired-deadline-minmax-indexonly-no-expired-false')
 r,_=receipt('preexisting-budget-true-retained',True,True);assert r['budgetReached'];checks.append('prior-budget-true-never-cleared')
 sql(d,'TRUNCATE smarter_private.horse_adaptive_statistics;','clear-large-fixture')
 r,_=receipt('empty');assert r['statisticsExpired']==0 and not r['budgetReached'];checks.append('empty-delete-branch')
 r,_=receipt('empty-else',True);assert not r['budgetReached'];checks.append('empty-min-null-is-false')
 sql(d,insert.replace('100000','1001').replace("'29 days'","'31 days'"),'1001-expired')
 r,_=receipt('expired-else',True);assert r['budgetReached'] and r['statisticsExpired']==0;yes(d,'SELECT count(*)=1001 FROM smarter_private.horse_adaptive_statistics;','expired-else-no-delete')
 r,_=receipt('expired-cap');assert r['statisticsExpired']==1000;yes(d,'SELECT count(*)=1 FROM smarter_private.horse_adaptive_statistics;','1000-row-cap')
 r,_=receipt('last-expired');assert r['statisticsExpired']==1;checks.append('whole-owner-present-expired-deleted')
 # Exact strict boundary at a fixed expiry-stage scalar, independent of wall-clock drift.
 sql(d,"INSERT INTO smarter_private.horse_adaptive_statistics SELECT lpad(to_hex(i),64,'0'),repeat('a',64),repeat('b',64),'training',repeat('c',64),'horse_policy',i,'call',1 FROM generate_series(999,1001)i;",'fixed-stage-boundary-input')
 yes(d,"WITH expired AS(SELECT ctid FROM smarter_private.horse_adaptive_statistics WHERE observed_at_ms<1000::bigint LIMIT 1000),removed AS(DELETE FROM smarter_private.horse_adaptive_statistics s USING expired e WHERE s.ctid=e.ctid RETURNING observed_at_ms) SELECT array_agg(observed_at_ms)=ARRAY[999::bigint] FROM removed;",'strict-below-equal-above-cutoff-deletion')
 yes(d,"SELECT array_agg(observed_at_ms ORDER BY observed_at_ms)=ARRAY[1000::bigint,1001] AND (min(observed_at_ms)<1000::bigint)=false FROM smarter_private.horse_adaptive_statistics;",'equal-above-retained-and-min-false')
 e.report['statistics_expiry_index']={'status':'passed','proven':checks,'function_md5':sql(d,"SELECT md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure));",'final-function-md5'),'qualification_scope':'Whole original/candidate owner with empty unrelated retention tables; finite membership leaf stub only controls deadline. Unchanged hand/finance authority uses retained parent qualification.','source_sha256':{str(p):hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in [MIGRATION,Path(__file__).relative_to(ROOT)]}}
 e.discard(d)

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,default=Path('/opt/homebrew/opt/postgresql@17/bin'));p.add_argument('--scratch-root',type=Path,required=True);a=p.parse_args();a.evidence.mkdir(parents=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','expiry_native');e=native.Execution(ROOT,a.evidence,a.pg_bin,a.scratch_root,120,socket_parent=a.scratch_root)
 try:e.start();qualify(e);e.report['status']='passed'
 except BaseException as exc:e.report.update(status='failed',failure=repr(exc))
 finally:e.close();(a.evidence/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup','statistics_expiry_index']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
