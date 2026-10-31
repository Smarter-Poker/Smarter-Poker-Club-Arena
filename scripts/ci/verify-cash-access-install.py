"""Offline strict actual install reader verification, no DB connector."""
import argparse,json,re,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--before',type=Path,required=True);p.add_argument('--after',type=Path,required=True);p.add_argument('--stage',choices=['index','statistics','function'],required=True);p.add_argument('--worktree',type=Path,required=True);a=p.parse_args();F=a.worktree/'scripts/ci/fixtures/cash-refusal-scope-time'
def read(path):
 s=path.read_text();assert not re.search(r'(^|\n)(?:ERROR|FATAL|psql:.*ERROR):',s),path;assert 'CASH_ACCESS_POSTGUARDS_PASS'in s and re.search(r'(^|\n)ROLLBACK\s*(?:\n|$)',s),path
 v=[json.loads(l.split('CASH_ACCESS_READ:',1)[1])for l in s.splitlines()if'CASH_ACCESS_READ:'in l];assert len(v)==1;return v[0]
b=read(a.before);z=read(a.after);expected=json.loads((F/'authority.json').read_text());assert b['authority']==z['authority']==expected
old=json.loads((F/'function-before.json').read_text());new=json.loads((F/'function-after.json').read_text());shape=lambda x:dict(definition=x['definition'],metadata=x['metadata'])
assert b['function']==shape(old)
files=[next((a.worktree/'supabase/migrations').glob('*_cash_refusal_scope_and_time_have_a_bounded_index.sql')),next((a.worktree/'supabase/migrations').glob('*_cash_refusal_scope_index_has_real_collected_statistics.sql')),next((a.worktree/'supabase/migrations').glob('*_cash_refusal_queries_scope_before_walking_blocked_receipts.sql'))]
def history(rows,count):
 assert len(rows)==count
 for row,pth in zip(rows,sorted(files[:count])):
  assert set(row)=={'version','name','statements','rollback','created_by','idempotency_key'}
  assert row['version']==pth.name[:14]and row['name']==pth.stem[15:]and row['statements']==[pth.read_text()]
  assert all(row[k]is None for k in ['rollback','created_by','idempotency_key'])
def index(x):
 assert x['definition']==(F/'index-canonical.sql').read_text().rstrip('\n');i=x['catalog'];assert i['indisvalid']and i['indisready']and i['indislive']and not i['indisunique']and i['indimmediate']and not i['indisprimary']and not i['indisexclusion'];assert i['indnkeyatts']==i['indnatts']==3 and i['indkey']==[0,4,1]and i['indpred']is None
 assert x['relation']['relowner']=='16384'and x['relation']['relname']=='accounting_cash_receipts_scope_time_keys'
def statistics(row):
 x=row['statistics'];c=x['catalog'];canonical=json.loads((F/'statistics-canonical.json').read_text());receipt=next(r for r in expected['relations']if r['name']=='accounting_cash_source_receipts')['relation']
 assert x['definition']==canonical['definition']and x['expression']==canonical['expression']
 assert c['stxname']==canonical['name']and c['stxkeys']==[]and c['stxkind']==['e']and c['stxstattarget']is None
 assert c['stxowner']==old['metadata']['proowner']and c['stxnamespace']==receipt['relnamespace']and c['stxrelid']==receipt['oid']
 assert x['data']['stxoid']==c['oid']and x['data']['stxdinherit']is False and len(x['data']['stxdexpr'])==1
 assert len(x['expression_stats'])==1 and x['expression_stats'][0]['expr']==canonical['expression']and x['expression_stats'][0]['inherited']is False and x['expression_stats'][0]['n_distinct']is not None
 assert row['expression_statistics_present']is True and row['ordinary_statistics_count']==3
if a.stage=='index':
 assert b['index']is None and b['history']==[]and b['statistics']is None;assert z['function']==shape(old)and z['statistics']is None;history(z['history'],1);index(z['index'])
elif a.stage=='statistics':
 index(b['index']);assert z['index']==b['index'];history(b['history'],1);history(z['history'],2);assert z['function']==shape(old)
 assert b['statistics']is None;statistics(z)
else:
 index(b['index']);assert z['index']==b['index'];history(b['history'],2);history(z['history'],3);assert z['function']==shape(new)
 statistics(b);statistics(z);assert b['statistics']['catalog']==z['statistics']['catalog']
print(json.dumps({'stage':a.stage,'strict_install_verified':True,'before_observed':b['observed_at'],'after_observed':z['observed_at'],'schema_two_tables_raw_triggers_five_owners_unchanged':True,'source_files':[dict(name=p.name,sha256=hashlib.sha256(p.read_bytes()).hexdigest())for p in files[:{'index':1,'statistics':2,'function':3}[a.stage]]],'limits':'Catalog installation/history proof only; root separate immutable paid snapshots and full225 original owner capacity required.'},indent=2))
