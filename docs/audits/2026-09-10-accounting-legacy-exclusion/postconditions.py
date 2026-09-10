"""Compare exact executable bodies and unchanged privileges after native installation."""
import os,json,hashlib,re
from pathlib import Path
from fixture_helpers import sql
here=Path(os.environ['LEGACY_EXCLUSION_HERE']);checks=[]
original=json.loads((here/'installed-catalog.json').read_text())['functions']+json.loads((here/'installed-rollup-view-catalog.json').read_text())['functions']
statements=(here/'02-excluded-owners.sql').read_text()+(here/'03-excluded-unpaid-rollups.sql').read_text()
expected={}
for name,body in re.findall(r'CREATE OR REPLACE FUNCTION public[.]([a-z0-9_]+)\([^$]*AS \$function\$(.*?)\$function\$',statements,re.S):expected[name]=hashlib.md5(body.encode()).hexdigest()
names=','.join("'"+x['signature'].split('(')[0]+"'" for x in original)
actual=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'body_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'result',pg_get_function_result(p.oid),'arguments',pg_get_function_arguments(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ("+names+");"))
for row in actual:
 before=next(x for x in original if x['signature']==row['signature']);name=row['signature'].split('(')[0]
 assert row['body_md5']==expected[name],(name,row['body_md5'],expected.get(name))
 assert row['owner']==before['owner'] and row['config']==['search_path=public']
 acl=lambda s:set(s.strip('{}').split(','))
 assert acl(row['acl'])==acl(before.get('acl',before.get('grants'))),name
 assert row['security_definer']==('SECURITY DEFINER' in before['definition']) and not row['strict']
 if 'arguments' in before:assert row['arguments']==before['arguments'] and row['result']==before['result'] and row['volatility']==before['provolatile']
assert len(actual)==5
view=json.loads(sql("SELECT jsonb_build_object('definition',pg_get_viewdef(c.oid,true),'definition_md5',md5(pg_get_viewdef(c.oid,true)),'options',c.reloptions,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text) FROM pg_class c WHERE c.oid='public.agent_commissions_unsettled'::regclass;"))
assert view['options']==['security_invoker=true'] and view['owner']=='postgres'
assert acl(view['acl'])==acl(json.loads((here/'installed-rollup-view-catalog.json').read_text())['view']['acl']),view['acl']
assert 'commission_capture_version IS NULL' in view['definition']
checks=['All five replaced native function bodies equal exact candidate bytes and retain original ownership, grants and signature metadata','Unpaid view retains exact owner, privileges and security-invoker option']
for label in checks:print('PASS: '+label,flush=True)
(here/'installed-after-proof.json').write_text(json.dumps({'functions':actual,'view':view,'checks':checks},indent=2)+'\n')

from proof_format import format_proof
format_proof(here/'installed-after-proof.json')
