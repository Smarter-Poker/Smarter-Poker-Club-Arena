#!/usr/bin/env python3
"""Compare genuine installer pre/post packets; never writes or connects to a DB."""
from pathlib import Path
from datetime import datetime
import argparse,hashlib,json,re
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-linked-window-proof'
def stamp(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
def packet(path,mode):
 text=path.read_text();assert not re.search(r'\b(?:ERROR|FATAL|PANIC):',text),('SQL error',mode)
 assert text.rstrip().endswith('ROLLBACK'),('missing terminal rollback',mode)
 values=[json.loads(line)for line in text.splitlines()if line.startswith('{')];assert len(values)==1,('unexpected JSON packet count',mode,len(values));v=values[0];assert v['kind']=='linked_window_strict_'+mode and v['mode']==mode;return v

def verify(pre,post,migration,fresh_before):
 a=packet(pre,'pre');b=packet(post,'post');binding=json.loads((F/'source-binding.json').read_text());expected=json.loads((F/'expected-footprints.json').read_text())
 assert stamp(a['observed_at'])>=stamp(fresh_before)and stamp(b['observed_at'])>stamp(a['observed_at'])
 history_rows=json.loads((F/'installed-history-admission.json').read_text());prior=[{'version':x['version'],'sql_sha256':hashlib.sha256(x['statements'][0].encode()).hexdigest()}for x in sorted(history_rows,key=lambda x:x['version'])]
 for v in[a,b]:assert v['predecessor_history']==prior;assert v['source65']is True and v['frozen']is False and v['manual40_md5']=='bf419dcc51e70b4275e04c7f452f5ade';assert v['footprints']==expected
 assert a['footprints']==b['footprints']
 assert a['generation']==binding['old_generation']and b['generation']==binding['new_generation']
 for mode,v in[('before',a),('after',b)]:
  rows=json.loads((F/f'admission-{mode}.json').read_text());expected_rows={x['signature']:x for x in rows};actual_rows={x['signature']:x for x in v['owners']};assert len(actual_rows)==len(expected_rows)
  plpgsql=next(x['metadata']['prolang']for x in json.loads((F/'admission-before.json').read_text())if'weekly_hand_parts_witness('in x['signature'])
  for signature,e in expected_rows.items():
   e=json.loads(json.dumps(e));metadata=e['metadata']
   if metadata['prolang']=='REQUIRE_ACTUAL_PG_LANGUAGE_PLPGSQL_OID_AT_INSTALL':metadata['prolang']=plpgsql
   actual=actual_rows[signature];assert actual['metadata']==metadata and actual['definition']==e['definition'],('owner mismatch',mode,signature)
 assert a['history']is None
 assert a['new_linked_rows']==b['new_linked_rows']==0, 'Verify installer before any genuine producer advances'
 assert a['kind_contract']==(F/'kind-before.txt').read_text() and b['kind_contract']==(F/'kind-after.txt').read_text()
 m=re.fullmatch(r'(\d{14})_([a-z0-9_]+)\.sql',migration.name);assert m,'Exact reserved protected migration filename required';version,name=m.groups();source=migration.read_text();assert'__RESERVED_VERSION__'not in source
 history=b['history'];assert isinstance(history,list)and len(history)==1;row=history[0];assert row['version']==version and row['name']==name and row['statements']==[source]
 assert {k:v for k,v in row.items()if k not in['version','name','statements']}=={'rollback':None,'created_by':None,'idempotency_key':None}
 assert binding['reserved_version']==version and hashlib.sha256(migration.read_bytes()).hexdigest()==binding['candidate_sha256']
 return {'passed':True,'all_current_exact_metadata_and_canonical_definitions':True,'only_five_qualified_owner_changes':True,'installed_three_and_current_prepare_cash_credit_controller_unchanged':True,'actual_source65_true_and_new_generation':True,'paid5_R2_full40_all759_fourcertificates_unchanged':True,'exact_protected_source_history':True,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'pre_sha256':hashlib.sha256(pre.read_bytes()).hexdigest(),'post_sha256':hashlib.sha256(post.read_bytes()).hexdigest(),'capacity_or_bookclosure_claimed':False}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--pre',type=Path,required=True);p.add_argument('--post',type=Path,required=True);p.add_argument('--migration',type=Path,required=True);p.add_argument('--fresh-before',required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args();result=verify(args.pre,args.post,args.migration,args.fresh_before);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
