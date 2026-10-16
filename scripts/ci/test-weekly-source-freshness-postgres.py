#!/usr/bin/env python3
"""Qualify unchanged installed freshness predicates and actual concurrent indexes.
This is access-path/receipt-predicate qualification, not a full financial close.
"""
import argparse,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));p.add_argument('--scratch',required=True);a=p.parse_args()
pg=Path(a.pg_bin);root=Path(tempfile.mkdtemp(prefix='sf-',dir=a.scratch));data=root/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x) for x in cmd],input=sql,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
source=(ROOT/'scripts/ci/fixtures/weekly-source-freshness-preparation.sql').read_text()
start=source.index('IF EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q')
end=source.index(' THEN\n   CONTINUE;',start)
query='SELECT '+source[start+3:end]
u='00000000-0000-0000-0000-000000000001'
for k,v in {'club':"'"+u+"'::uuid",'from_date':"'2026-10-05'::date",'to_date':"'2026-10-11'::date",'p_from':"'2026-10-05 07:00Z'::timestamptz",'p_to':"'2026-10-12 07:00Z'::timestamptz"}.items():query=re.sub(r'\b'+k+r'\b',v,query)
file=next((ROOT/'supabase/migrations').glob('20261016161247_*'))
# Use the maintained installer's exact parser, not a second migration splitter.
shape=json.loads(run(['node','--input-type=module','-e',"import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'./scripts/ci/migration-concurrent-preamble.mjs';process.stdout.write(JSON.stringify(splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'))))",file]))
assert shape['ok'] and len(shape['indexes'])==2
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
 q("CREATE TABLE accounting_period_recompute_requests(club_id uuid,period_start date,period_end date,status text,attempted_at timestamptz,last_requested_at timestamptz,last_result jsonb);INSERT INTO accounting_period_recompute_requests VALUES('"+u+"','2026-10-05','2026-10-11','complete','2026-10-12 12:06:54Z','2026-10-12 12:06:53Z',jsonb_build_object('accounting_version',2,'status','ready','club_id','"+u+"','period_start','2026-10-05','period_end','2026-10-11'));")
 for table,time in [('accounting_cash_rake_sources','earned_at'),('accounting_tournament_fee_sources','charged_at')]:
  q(f"CREATE TABLE {table}(id bigint PRIMARY KEY,club_id uuid,{time} timestamptz,recorded_at timestamptz,payload text);INSERT INTO {table} SELECT n,('00000000-0000-0000-0000-'||lpad((1+n%20)::text,12,'0'))::uuid,CASE WHEN n%3=0 THEN '2026-10-08 07:00Z'::timestamptz ELSE '2026-10-14 07:00Z'::timestamptz END,CASE WHEN n%3=0 THEN '2026-10-11 07:00Z'::timestamptz ELSE '2026-10-14 08:00Z'::timestamptz END,repeat(md5(n::text),32) FROM generate_series(1,50000)n;CREATE INDEX old_{table} ON {table}(club_id,{time});")
  q('VACUUM(ANALYZE) '+table)
 q('ANALYZE accounting_period_recompute_requests;')
 assert q(query)=='t','no late original source, receipt qualifies before indexes'
 before=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]
 for ix in shape['indexes']:q(ix['statement'])
 q(shape['body'])
 after=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]
 def nodes(n):
  yield n
  for child in n.get('Plans',[]):yield from nodes(child)
 for ix in shape['indexes']:
  n=next((n for n in nodes(after['Plan']) if n.get('Index Name')==ix['name']),None)
  assert n is not None and 'recorded_at' in n.get('Index Cond',''),after
  assert n.get('Heap Fetches',0)==0,n
 old_blocks=before['Plan'].get('Shared Hit Blocks',0)+before['Plan'].get('Shared Read Blocks',0)
 new_blocks=after['Plan'].get('Shared Hit Blocks',0)+after['Plan'].get('Shared Read Blocks',0)
 assert old_blocks>new_blocks*5,(old_blocks,new_blocks)
 # Independent outcomes for the actual unchanged predicates; exact cutoff is strict.
 cases=[('accounting_cash_rake_sources','earned_at','2026-10-08 07:00Z','2026-10-12 12:05:54Z',True),('accounting_cash_rake_sources','earned_at','2026-10-08 07:00Z','2026-10-12 12:05:54.000001Z',False),('accounting_cash_rake_sources','earned_at','2026-10-05 07:00Z','2026-10-13 07:00Z',False),('accounting_cash_rake_sources','earned_at','2026-10-12 07:00Z','2026-10-13 07:00Z',True),('accounting_cash_rake_sources','earned_at',None,'2026-10-13 07:00Z',True),('accounting_cash_rake_sources','earned_at','2026-10-08 07:00Z',None,True),('accounting_tournament_fee_sources','charged_at','2026-10-01 07:00Z','2026-10-13 07:00Z',False),('accounting_tournament_fee_sources','charged_at','2026-10-08 07:00Z','2026-10-12 12:05:54Z',True),('accounting_tournament_fee_sources','charged_at','2026-10-12 07:00Z','2026-10-13 07:00Z',True),('accounting_tournament_fee_sources','charged_at',None,'2026-10-13 07:00Z',True),('accounting_tournament_fee_sources','charged_at','-infinity','2026-10-13 07:00Z',False)]
 def literal(s):return 'NULL' if s is None else "'"+s+"'::timestamptz"
 for table,time,earned,recorded,expected in cases:
  q(f"INSERT INTO {table} VALUES(900001,'{u}',{literal(earned)},{literal(recorded)},'boundary');")
  assert q(query)==('t' if expected else 'f'),(table,earned,recorded,expected)
  q(f'DELETE FROM {table} WHERE id=900001;')
 q("UPDATE accounting_period_recompute_requests SET last_requested_at=attempted_at+interval '1 microsecond';")
 assert q(query)=='f','a newer calculation request still refuses the old receipt'
 q("UPDATE accounting_period_recompute_requests SET last_requested_at=attempted_at-interval '1 second';")
 # Same-name wrong key/include layout cannot be recorded as a successful migration.
 ix=shape['indexes'][1];q('DROP INDEX '+ix['name']+';CREATE INDEX '+ix['name']+' ON public.accounting_tournament_fee_sources(club_id,charged_at) INCLUDE(recorded_at);')
 q(shape['body'],'weekly_source_freshness_index_shape_changed')
 q('DROP INDEX '+ix['name']);q(ix['statement']);q(shape['body']);assert q(query)=='t'
 print(json.dumps({'qualification':'passed','actual_installed_receipt_predicate':True,'concurrent_preamble_parser':True,'unchanged_boundary_cases':len(cases),'late_and_backdated_sources_still_refuse':True,'same_name_wrong_shape_refused':True,'before_shared_blocks':old_blocks,'after_shared_blocks':new_blocks,'full_financial_close_qualified':False}))
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
