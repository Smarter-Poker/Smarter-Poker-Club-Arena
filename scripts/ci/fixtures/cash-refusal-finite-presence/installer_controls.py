"""Real native authority/header/DDL controls; financial/GEN guards compile only.
Catalog OIDs in exact authority predicates are explicitly adapted to this cluster.
This does not execute or fake production financial/GEN proof.
"""
import re,json,hashlib

def qualify(q,source,old,new,sig):
 cases=[]
 def block(tag):
  x=re.search(r'DO \$'+tag+r'\$(.*?)\$'+tag+r'\$;',source,re.S);assert x,tag;return x.group(0)
 header=source[:source.index('DO $cash_scope_operator$')];assert header.startswith('BEGIN;')
 operator=block('cash_scope_operator');version=block('cash_own_version')
 q('CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[],rollback jsonb,created_by text,idempotency_key text);')
 q(old+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
 before=q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+sig+"'::regprocedure")
 before=json.loads(before)
 guards=re.findall(r'DO \$refusal_actual_owner\$(.*?)\$refusal_actual_owner\$;',source,re.S);assert len(guards)==2
 def adapted(body):
  prefix=body[:body.index('IF NOT EXISTS')];assert prefix.endswith('END IF;')
  actual=re.search(r'\$refusal_metadata\$(.*?)\$refusal_metadata\$',prefix,re.S).group(1)
  native=json.dumps(before['metadata'],separators=(',',':'));bound=prefix.replace('$refusal_metadata$'+actual+'$refusal_metadata$','$refusal_metadata$'+native+'$refusal_metadata$',1)
  assert bound.replace('$refusal_metadata$'+native+'$refusal_metadata$','$refusal_metadata$'+actual+'$refusal_metadata$',1)==prefix
  return 'DO $native_exact_owner$'+bound+'END$native_exact_owner$;'
 pre,post=map(adapted,guards)
 m=list(re.finditer(r'^CREATE OR REPLACE FUNCTION public.fn_cash_source_refusals_for_period\(',source,re.M));assert len(m)==1
 pos=m[0].start();acl='REVOKE ALL ON FUNCTION public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;';end=source.index(acl,pos)+len(acl)
 assert re.findall(r"SET LOCAL statement_timeout='([^']+)'",source[:pos])[-1]=='5s'
 assert source[end:].lstrip().startswith("SET LOCAL statement_timeout='15s';")
 ddl=source[pos:end];assert new.strip().rstrip(';')in ddl
 cap5="DO $$BEGIN IF current_setting('timezone')<>'UTC'OR current_setting('statement_timeout')::interval<>interval'5s'OR current_setting('transaction_timeout')::interval<>interval'60s'OR current_setting('lock_timeout')::interval<>interval'1s'THEN RAISE EXCEPTION 'native_actual_DDL_caps_wrong';END IF;END$$;"
 cap15="DO $$BEGIN IF current_setting('statement_timeout')::interval<>interval'15s'THEN RAISE EXCEPTION 'native_postguard_cap_wrong';END IF;END$$;"
 chunk="SET LOCAL statement_timeout='5s';"+cap5+ddl+cap5+"SET LOCAL statement_timeout='15s';"+cap15
 q("SET timezone='America/Chicago';"+header+operator+version+pre+chunk+post+'ROLLBACK;');cases.append('actual_source_header_UTC_ownversion_preowner_DDL5_post15_fullmetadata_pass')
 assert json.loads(q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+sig+"'::regprocedure"))==before
 for setup,error in [('SET ROLE service_role;','cash_scope_first_real_unfrozen_operator_required'),("SET request.jwt.claims='{}';",'cash_scope_first_real_unfrozen_operator_required')]:q(setup+header+operator+'ROLLBACK;',error)
 cases.append('actual_source_role_and_JWT_refused_without_effect')
 ver=re.search(r"WHERE version='([0-9]{14})'",version).group(1);q("INSERT INTO supabase_migrations.schema_migrations(version)VALUES('"+ver+"');");q(header+operator+version+'ROLLBACK;','cash_scope_first_version_already_recorded');q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+ver+"';");cases.append('actual_source_recorded_ownversion_replay_refused')
 q(header+"SET LOCAL statement_timeout='15s';"+cap5+'ROLLBACK;','native_actual_DDL_caps_wrong');cases.append('wrong_DDL15_regression_refused')
 q(header+operator+version+pre+chunk+'ALTER FUNCTION '+sig+' COST 101;'+post+'COMMIT;','refusal_exact_current_owner_required');cases.append('post_metadata_fault_rolls_back_actual_candidate_DDL')
 assert json.loads(q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+sig+"'::regprocedure"))==before
 financial=re.findall(r'DO \$cash_financial_unchanged\$(.*?)\$cash_financial_unchanged\$;',source,re.S);assert len(financial)==2 and financial[0]==financial[1]
 q('CREATE FUNCTION native_financial_guard_grammar()RETURNS void LANGUAGE plpgsql AS $compile_only$'+financial[0]+'$compile_only$;');cases.append('actual_full_paid40_paid5_GEN_guard_grammar_only_not_executed')
 q(new+';');return {'passed':True,'cases':cases,'exact_native_catalog_OID_adapter_inverse':True,'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'financial_and_GEN_runtime_NOT_faked':True,'production_install_or_capacity_proof':False}
