#!/usr/bin/env python3
"""Add immutable catalogue definitions to the private fixture, never live rows."""
import os,json,shutil,hashlib
from pathlib import Path
here=Path(os.environ['CASCADE_HERE'])
fixture=Path(os.environ['ROUND1_INPUT'])/'source-authority/owner-composition'
source=Path(os.environ['CASCADE_SOURCE_INPUT'])
payer=Path(os.environ['CASCADE_PAYER_INPUT'])
manifest={}
for origin in [source,here]:
 for pattern in ['function-catalog-*.json','trigger-catalog-*.json','table-catalog-*.json']:
  for f in sorted(origin.glob(pattern)):
   shutil.copy2(f,fixture/f.name);manifest[origin.name+'/'+f.name]=hashlib.sha256(f.read_bytes()).hexdigest()
# Catalogue files are metadata definitions. They contain no production rows.
functions={}
for f in fixture.glob('function-catalog-*.json'):
 for row in json.loads(f.read_text()):functions[row['signature']]=row
for name in ['installed-catalog.json','union-funding-catalog.json']:
 f=payer/name;manifest['payer/'+name]=hashlib.sha256(f.read_bytes()).hexdigest()
 for row in json.loads(f.read_text())['functions']:
  old=functions.get(row['signature'],{})
  functions[row['signature']]={**old,**row,'owner':old.get('owner','postgres'),'grants':row.get('acl',old.get('grants')),'body_md5':row.get('md5',old.get('body_md5'))}
# Add only absent actual tables from the payer catalogue, preserving the
# fuller existing source fixture definitions wherever already present.
known={x['name'] for f in fixture.glob('table-catalog-*.json') for x in json.loads(f.read_text())}
catalog=json.loads((payer/'installed-catalog.json').read_text());extra=[]
for table in catalog['tables']:
 if table['table_name'] in known:continue
 columns=[]
 for raw in table['columns'].split(',\n'):
  name,rest=raw.split(' ',1);not_null=rest.endswith(' NOT NULL')
  if not_null:rest=rest[:-9]
  typ,sep,default=rest.partition(' DEFAULT ')
  columns.append({'name':name,'type':typ,'default':default if sep else None,'identity':'','not_null':not_null,'generated':''})
 constraints=[{'name':x['conname'],'type':x['contype'],'definition':x['definition']} for x in catalog['constraints'] if x['table_name']==table['table_name']]
 extra.append({'name':table['table_name'],'schema':'public','columns':columns,'constraints':constraints,'indexes':[]})
(fixture/'table-catalog-payer-absent.json').write_text(json.dumps(extra,indent=2)+'\n')

# Exact tracked read/allocator helpers, explicitly pinned in the payer fixture.
import re
basis=payer/'basis-fixture.sql';manifest['payer/basis-fixture.sql']=hashlib.sha256(basis.read_bytes()).hexdigest()
for match in re.finditer(r'CREATE OR REPLACE FUNCTION public\.(fn_[a-z_]+)\((.*?)\n\$(function|f)\$;',basis.read_text(),re.S):
 definition=match.group(0)
 name=match.group(1)
 if name not in ['fn_rake_shares_for_record','fn_allocate_rake_credits','fn_rake_record_is_ghost_twin']:continue
 signatures={'fn_rake_shares_for_record':'fn_rake_shares_for_record(uuid,numeric,jsonb,text)','fn_allocate_rake_credits':'fn_allocate_rake_credits(numeric,jsonb,text)','fn_rake_record_is_ghost_twin':'fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)'}
 signature=signatures[name]
 functions[signature]={'signature':signature,'definition':definition,'owner':'postgres','grants':None,'body_md5':None}

# The builder consumes a glob; remove only these fresh temporary copies so
# duplicate signature ordering can never decide the installed owner.
for f in fixture.glob('function-catalog-*.json'):f.unlink()
(fixture/'function-catalog-composed.json').write_text(json.dumps(list(functions.values()),indent=2)+'\n')
for origin in [source,payer]:
 for f in sorted(origin.glob('*.sql')):manifest[origin.name+'/'+f.name]=hashlib.sha256(f.read_bytes()).hexdigest()
(here/'outer-input-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('OUTER INPUTS FROZEN:',len(functions),'actual function definitions',flush=True)
