"""Native-only cardinality probe with the exact indexed legacy access predicates."""
import os,json
from pathlib import Path
from fixture_helpers import sql
from proof_format import format_proof
here=Path(os.environ['LEGACY_EXCLUSION_HERE']);checks=[];plans={}
sql("""CREATE TABLE public.test_legacy_commission_plan(id uuid,club_id uuid,user_id uuid,amount numeric,created_at timestamptz,settled_at timestamptz,commission_capture_version integer);
CREATE INDEX test_legacy_open_source_idx ON public.test_legacy_commission_plan(club_id,user_id,created_at) WHERE settled_at IS NULL AND commission_capture_version IS NULL;""")
predicate=""" FROM public.test_legacy_commission_plan ac WHERE ac.club_id=test_id(1900001) AND ac.user_id=test_id(1900002)
 AND ac.settled_at IS NULL AND ac.commission_capture_version IS NULL
 AND ac.created_at>='2026-08-01'::timestamptz AND ac.created_at<'2026-09-01'::timestamptz
 AND NOT EXISTS(SELECT 1 FROM public.agent_commission_settlements s
 WHERE s.club_id=ac.club_id AND s.user_id=ac.user_id AND ac.created_at>=s.period_start AND ac.created_at<s.period_end)"""
queries={'cutoff':'SELECT ac.created_at'+predicate+' ORDER BY ac.created_at OFFSET 1000 LIMIT 1',
 'receipt':'SELECT coalesce(sum(ac.amount),0),count(*)'+predicate}
def nodes(p):
 yield p
 for x in p.get('Plans',[]):yield from nodes(x)
for name,captured_count,legacy_count in [('mixed',100000,1001),('captured_only',100000,0),('historical_only',0,100000)]:
 sql("TRUNCATE public.test_legacy_commission_plan;"+f"INSERT INTO public.test_legacy_commission_plan SELECT test_id(2000000+i),test_id(1900001),test_id(1900002),1,'2026-08-25'::timestamptz+i*interval '1 millisecond',NULL,1 FROM generate_series(1,{captured_count}) i;"+f"INSERT INTO public.test_legacy_commission_plan SELECT test_id(3000000+i),test_id(1900001),test_id(1900002),1,'2026-08-24'::timestamptz+i*interval '1 millisecond',NULL,NULL FROM generate_series(1,{legacy_count}) i;ANALYZE public.test_legacy_commission_plan;")
 for kind,query in queries.items():
  plan=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0];ns=list(nodes(plan['Plan']))
  if kind=='cutoff' or captured_count:
   assert any(x.get('Index Name')=='test_legacy_open_source_idx' for x in ns),plan
   assert not any(x.get('Node Type')=='Seq Scan' and x.get('Relation Name')=='test_legacy_commission_plan' for x in ns),plan
  limit=min(1001,legacy_count) if kind=='cutoff' else legacy_count
  scans=[x for x in ns if x.get('Relation Name')=='test_legacy_commission_plan']
  assert all(x.get('Actual Rows',0)<=limit for x in scans),scans
  label=f'{name} {kind} plan reads only the required legacy basis and excludes captured projections'
  checks.append(label);print('PASS: '+label,flush=True)
  plans[name+'_'+kind]={'captured_rows':captured_count,'legacy_rows':legacy_count,'query':query,'plan':plan}
(here/'query-plan-proof.json').write_text(json.dumps({'scope':'Representative native-only relation and exact access predicates, not production data or wall-time guarantee. Full-window receipt revalidation necessarily totals that window legacy basis.','plans':plans,'checks':checks},indent=2)+'\n')
format_proof(here/'query-plan-proof.json')
