#!/usr/bin/env python3
"""Actual original memo key/seed/keep; isolated generation and receipt boundaries.
No monetary writer is changed or certified here. Existing monetary native proof
is retained. Eligibility gates only the optional memo, never fee/book authority.
"""
import argparse,json,os,socket,subprocess,tempfile,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch-root',type=Path,required=True);p.add_argument('--output',type=Path);a=p.parse_args();r=Path(__file__).resolve().parents[2]
w=Path(tempfile.mkdtemp(prefix='book-memo-',dir=a.scratch_root));started=False;cases=[]
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={**os.environ,'TMPDIR':str(w),'PGTZ':'UTC'}
def run(cmd,sql=None):return subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=60,check=True)
def q(sql,error=None):
 x=subprocess.run([str(a.pg_bin/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],input=sql,text=True,capture_output=True,env=env,timeout=60)
 if error:assert x.returncode and error in x.stderr,(error,x.stdout,x.stderr)
 else:assert x.returncode==0,(x.stdout,x.stderr)
 return x.stdout.strip()
def check(name,sql):assert q('SELECT ('+sql+')')=='t',name;cases.append({'case':name,'passed':True})
u='fade0000-0000-0000-0000-000000000001';f='2026-10-19 07:00Z';t='2026-10-26 07:00Z';args=f"'{u}','{f}','{t}'"
key='public.fn_accounting_close_report_memo_key('+args+')';seed='public.fn_accounting_close_report_seed('+args+')';keep='public.fn_accounting_close_report_keep('+args+')'
context="SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';"
fault=context+"SET test.generation_bad='on';"
ready={'report_version':1,'status':'ready','basis_certified':True,'issues':[]}
def header(changes=None):
 d={'union_id':u,'standalone_club_id':None,'scope_kind':'union','scope_id':u,'period_start':f,'period_end':t,'round_no':3,'routing_version':3,'completed_at':'2026-10-27 00:00Z','source_fingerprint':'0'*32,'result':{'success':True,'round':3,'routing_version':3,'source_version':2,'source_contract_version':3,'shortfalls':0,'scope_kind':'union','scope_id':u}}
 for k,v in(changes or{}).items():
  if k.startswith('result.'):d['result'][k[7:]]=v
  else:d[k]=v
 j=json.dumps(d).replace("'","''")
 return "TRUNCATE accounting_routed_settlement_runs;INSERT INTO accounting_routed_settlement_runs SELECT(jsonb_populate_record(NULL::accounting_routed_settlement_runs,'"+j+"'::jsonb)).*;"
owners=json.loads((r/'scripts/ci/fixtures/book-memo-after-r3/original-owners.json').read_text());migration=(r/'supabase/migrations/20261027162805_book_memos_follow_paid_player_round.sql').read_text()
try:
 run([a.pg_bin/'initdb','-D',w/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([a.pg_bin/'pg_ctl','-D',w/'d','-l',w/'log','-w','start','-o',f"-k '' -h 127.0.0.1 -p {port}"]);started=True
 q("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;
 CREATE TABLE accounting_routed_settlement_runs(union_id uuid,standalone_club_id uuid,scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,round_no int,routing_version int,completed_at timestamptz,source_fingerprint text,result jsonb);
 CREATE TABLE accounting_close_report_receipts(union_id uuid,period_start timestamptz,period_end timestamptz,generation text,report jsonb,computed_at timestamptz,PRIMARY KEY(union_id,period_start,period_end));
 CREATE TABLE accounting_close_certificates(union_id uuid,period_start timestamptz,period_end timestamptz,certified_at timestamptz,kind text);
 CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE plpgsql STABLE AS $$BEGIN IF current_setting('test.generation_bad',true)='on'THEN RAISE EXCEPTION 'original_generation_boundary_refused';END IF;RETURN coalesce(nullif(current_setting('test.generation',true),''),'gen-A');END$$;
 CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION fn_accounting_close_proof_lifetime()RETURNS interval LANGUAGE sql STABLE AS $$SELECT interval '72 hours'$$;
 CREATE FUNCTION fn_accounting_close_report_is_ready(p_report jsonb)RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT jsonb_typeof(p_report)='object'AND p_report->'report_version'='1'::jsonb AND p_report->>'status'='ready'AND p_report->'basis_certified'='true'::jsonb AND p_report->'issues'='[]'::jsonb$$;
 """)
 for x in owners:
  q(x['definition']+';');assert q("SELECT md5(pg_get_functiondef('"+x['signature']+"'::regprocedure))")==x['md5'];q('REVOKE ALL ON FUNCTION '+x['signature']+'FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION '+x['signature']+'TO service_role;')
 def meta():return q("SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,provolatile,prosecdef,proconfig,proacl::text)ORDER BY oid::regprocedure::text)FROM pg_proc WHERE proname LIKE'fn_accounting_close_report_%'")
 originalmeta=meta();guarddef=q("SELECT md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))")
 for call in[key,seed,keep]:q(fault+'SELECT '+call+';','original_generation_boundary_refused')
 cases.append({'case':'old-actual-key-seed-keep-run-generation-before-player-round','passed':True})
 q(migration.replace('COMMIT;','ROLLBACK;'))
 assert q("SELECT md5(pg_get_functiondef('fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz)'::regprocedure))")=='ce1e8a66821765df65671d22c26e81da'
 q(migration);assert meta()==originalmeta;q(migration,'book_memo_after_r3_preimage_changed')
 assert q("SELECT md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))")==guarddef
 cases.append({'case':'exact-atomic-rollback-install-postimage-metadata-acl-replay-original-guard-unchanged','passed':True})
 check('no-R3-null-key',"(SELECT generation IS NULL AND memo_key IS NULL FROM "+key+")")
 assert q(fault+'SELECT '+seed+';SELECT '+keep+';')=='f\nf'
 cases.append({'case':'actual-seed-keep-return-false-without-generation-or-receipt-write','passed':True})
 bad=[{'scope_kind':'club'},{'scope_id':'00000000-0000-0000-0000-000000000001'},{'union_id':'00000000-0000-0000-0000-000000000001'},{'standalone_club_id':u},{'period_start':'2026-10-12 07:00Z'},{'period_end':'2026-10-27 07:00Z'},{'round_no':2},{'routing_version':2},{'completed_at':None},{'source_fingerprint':'bad'},{'result.success':False},{'result.round':2},{'result.routing_version':2},{'result.source_version':1},{'result.source_contract_version':None},{'result.shortfalls':1},{'result.scope_kind':'club'},{'result.scope_id':None}]
 for i,badrow in enumerate(bad):
  q(header(badrow));assert q(fault+'SELECT '+seed+';SELECT '+keep+';')=='f\nf';cases.append({'case':'noncanonical-or-unfinished-R3-'+str(i),'passed':True})
 q(header());q(fault+'SELECT '+seed+';','original_generation_boundary_refused');cases.append({'case':'canonical-R3-restores-actual-original-generation-refusal','passed':True})
 goodkey=q('SELECT memo_key FROM '+key)
 assert goodkey=='gen-A|'+u+'|2026-10-19 07:00:00+00|2026-10-26 07:00:00+00'
 q("INSERT INTO accounting_close_report_receipts VALUES('"+u+"','"+f+"','"+t+"','gen-A','"+json.dumps(ready)+"',clock_timestamp());")
 assert q(context+'SELECT '+seed+';')=='t';cases.append({'case':'actual-ready-report-seeds-only-after-player-round','passed':True})
 q("UPDATE accounting_close_report_receipts SET computed_at=now()-interval'73 hours';");assert q(context+'SELECT '+seed+';')=='f';cases.append({'case':'original-report-lifetime-refusal-preserved','passed':True})
 q("UPDATE accounting_close_report_receipts SET computed_at=now()-interval'1 second';INSERT INTO accounting_close_certificates VALUES('"+u+"','"+f+"','"+t+"',now(),'original-book-source');");assert q(context+'SELECT '+seed+';')=='f';cases.append({'case':'original-later-book-certificate-invalidation-preserved','passed':True})
 q("TRUNCATE accounting_close_certificates,accounting_close_report_receipts;")
 memo=json.dumps({goodkey:ready}).replace("'","''")
 assert q(context+"SET app.union_pnl_evidence_memo='"+memo+"';SELECT "+keep+';')=='t';cases.append({'case':'actual-ready-current-generation-report-kept-after-player-round','passed':True})
 assert q(context+"SET test.generation='gen-B';SET app.union_pnl_evidence_memo='"+memo+"';SELECT "+seed+';SELECT '+keep+';')=='f\nf';cases.append({'case':'stale-generation-GUC-and-old-receipt-cannot-seed-or-retag','passed':True})
 assert q(fault+"SET app.weekly_accounting_chunked='off';SELECT "+seed+';SELECT '+keep+';')=='f\nf';cases.append({'case':'original-nonchunked-context-refusals-unchanged','passed':True})
 q("SET ROLE anon;SELECT "+key+';','permission denied');cases.append({'case':'original-browser-ACL-refusal-unchanged','passed':True})
 q(header({'period_start':'2026-10-26 07:00Z','period_end':'2026-11-02 08:00Z'}));assert q("SELECT memo_key FROM fn_accounting_close_report_memo_key('"+u+"','2026-10-26 07:00Z','2026-11-02 08:00Z')").endswith('|2026-10-26 07:00:00+00|2026-11-02 08:00:00+00');cases.append({'case':'DST-169-hour-week-exact-receipt-key-preserved','passed':True})
 result={'status':'passed','cases':cases,'actual_original_helpers':3,'generation_and_financial_header_boundary':'isolated-controlled-contract-not-money-certificate','scope_4204_and_financial_owners_unchanged':True}
 if a.output:a.output.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',w/'d','-m','immediate','-w','stop'])
 shutil.rmtree(w)
