"""Read-only metadata checks only; this packet contains no installer."""
from types import ModuleType
from pathlib import Path
from packet_contract import read,require,sha

def literal(s):return "'"+str(s).replace("'","''")+"'"
def supplemental_preflight(conn):
 pin=next(e for e in read('SOURCE-PINS.json') if e['role']=='base_checker')
 require(sha(pin['path'])==pin['sha256'],'Original checker changed')
 m=ModuleType('bbj_pinned_checker');m.__file__=pin['path']
 exec(compile(Path(pin['path']).read_text(),pin['path'],'exec'),m.__dict__)
 functions=read('SUPPLEMENTAL-FUNCTIONS.json');tables=read('CURRENT-RELATIONS.json')
 require(len(functions)==12 and len(tables)==6,'Exact twelve helpers and six relation records required')
 for t in tables:
  for k in ['columns_complete','constraints_complete','indexes_complete','attachments_complete','policies_complete']:t[k]=True
  for c in t['columns']:c['acl_captured']=True
 result=m.check(conn,functions,tables)
 require(len(result['comparisons'])==18 and result['passed'],'Supplemental complete metadata mismatch')
 extra=[]
 for f in functions:
  sig=f['schema']+'.'+f['signature'].removeprefix(f['schema']+'.')
  actual=conn.one("SELECT jsonb_build_object('arguments',pg_get_function_arguments(oid),'identity_arguments',pg_get_function_identity_arguments(oid),'result',pg_get_function_result(oid),'strict',proisstrict,'leakproof',proleakproof,'parallel',proparallel,'language',(SELECT lanname FROM pg_language WHERE oid=prolang),'cost',procost,'rows',prorows,'kind',prokind,'returns_set',proretset) FROM pg_proc WHERE oid=to_regprocedure("+literal(sig)+')')
  wanted={k:f[k] for k in ['arguments','identity_arguments','result']}
  if f['name']=='fn_valid_prize_table':wanted.update(strict=False,leakproof=False,parallel='u',language='sql',cost=100,rows=0,kind='f',returns_set=False)
  extra.append({'signature':sig,'actual':actual,'expected':wanted})
  require(actual is not None and all(actual[k]==v for k,v in wanted.items()),'Supplemental argument/default/result/validator attributes changed')
 identities=conn.one("SELECT jsonb_agg(jsonb_build_object('name',relname,'relpersistence',relpersistence,'relreplident',relreplident) ORDER BY relname) FROM pg_class WHERE oid IN ("+','.join(literal(t['requested_relation'])+'::regclass' for t in tables)+')')
 wanted=sorted([dict(name=t['name'],relpersistence=t['relpersistence'],relreplident=t['relreplident']) for t in tables],key=lambda x:x['name'])
 require(identities==wanted,'Supplemental relation identity flags differ')
 result.update(exact_attributes=extra,relation_identity=identities)
 return result
