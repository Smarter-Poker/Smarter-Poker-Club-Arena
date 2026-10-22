"""One source-proven DDL authorization row, isolated reconstruction only."""
import hashlib,json,re
from pathlib import Path
NAME='fn_complete_club_opening_setup'
CONTRACT_SHA='702886e7df8b14465714321ffdb8ab5b93cf9f72e85610da484674e98914c834'
def load(base,root):
 raw=(Path(base)/'opening-governance.json').read_bytes()
 if hashlib.sha256(raw).hexdigest()!=CONTRACT_SHA:raise ValueError('Governance contract differs from independent source proof')
 contract=json.loads(raw)
 source=(Path(root)/contract['sourcePath']).read_bytes()
 if hashlib.sha256(source).hexdigest()!=contract['sourceSHA256']:raise ValueError('Governance source declaration differs')
 notes=re.search(r"\('fn_complete_club_opening_setup',\s*'((?:[^']|'')*)'\)",source.decode())
 if not notes or contract['row']!=dict(proname=NAME,status='approved',notes=notes[1].replace("''", "'")):raise ValueError('Governance authorization differs from exact source')
 return contract
def check(sql,contract):
 # This metadata check keeps the actual installed guard, detector and binding.
 actual=json.loads(sql("SET search_path=pg_catalog;SELECT jsonb_build_object('table',EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ca_money_rpc_registry' AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres' AND NOT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)),'routines',(SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('fn_ca_money_rpc_registry_guard','fn_ca_money_rpc_writes_balances','fn_ca_money_rpc_balance_columns')),'binding',(SELECT jsonb_build_object('name',e.evtname,'tags',e.evttags,'event',e.evtevent,'owner',pg_get_userbyid(e.evtowner),'enabled',e.evtenabled,'function',e.evtfoid::regprocedure::text) FROM pg_event_trigger e WHERE e.evtname='ab_ca_money_rpc_registered'));"))
 expected={'table':True,'routines':{r['name']:r['definition_md5'] for r in contract['guardRoutines']},'binding':contract['eventTriggers'][0]}
 if actual!=expected:raise ValueError('Actual money registry table/guard/binding differs')
def rows(sql):
 return json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('proname',proname,'status',status,'notes',notes)),'[]'::jsonb) FROM public.ca_money_rpc_registry;"))
def restore(sql,base,root):
 return restore_authorization(sql,load(base,root))
def restore_authorization(sql,contract):
 check(sql,contract)
 if rows(sql)!=[]:raise ValueError('Local governance target must be absent')
 def lit(x):return "'"+x.replace("'","''")+"'"
 row=contract['row']
 sql('BEGIN;SET LOCAL ROLE postgres;INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES('+','.join(lit(row[k]) for k in ['proname','status','notes'])+');COMMIT;')
 if rows(sql)!=[row]:raise ValueError('Exact governance row readback differs')
 return contract
def verify(sql,contract):
 check(sql,contract)
 if rows(sql)!=[contract['row']]:raise ValueError('DDL changed governance authorization')
