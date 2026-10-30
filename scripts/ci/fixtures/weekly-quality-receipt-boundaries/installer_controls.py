"""Native successor one-owner controls. Financial/GEN runtime is not faked.
Only changed TQ authority is adapted to native OID; all9 actual source owners
and financial/GEN guards also compile without execution.
"""
import re,json,hashlib

def qualify(q,source,before,after):
 cases=[];targets=[x for x in before if 'fn_accounting_tournament_week_quality('in x['signature']];assert len(targets)==1
 def expect(s,error):
  try:q(s)
  except AssertionError as e:assert error in str(e),(error,str(e));return
  raise AssertionError('expected refusal:'+error)
 def block(tag):
  m=re.search(r'DO \$'+tag+r'\$(.*?)\$'+tag+r'\$;',source,re.S);assert m,tag;return m.group(0)
 q("CREATE SCHEMA IF NOT EXISTS supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[],rollback jsonb,created_by text,idempotency_key text);CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;")
 # Replace only the semantic fixture's controlled fee collaborator before actual-authority bootstrap.
 for x in targets:q('SET check_function_bodies=off;'+x['definition']+';REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC,anon,authenticated,service_role;')
 native={x['signature']:json.loads(q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+x['signature']+"'::regprocedure"))for x in targets}
 for x in targets:assert native[x['signature']]['definition']==x['definition']
 def adapted(tag,owners):
  raw=block(tag);payload=re.search(r'\$targeted_owners\$(.*?)\$targeted_owners\$',raw,re.S).group(1);assert json.loads(payload)==owners
  subset=[]
  for x in owners:
   if x['signature']not in native:continue
   y=dict(x);y['metadata']=native[x['signature']]['metadata'];subset.append(y)
  assert len(subset)==1
  bound=raw.replace('$targeted_owners$'+payload+'$targeted_owners$','$targeted_owners$'+json.dumps(subset,separators=(',',':'))+'$targeted_owners$',1)
  assert bound.replace('$targeted_owners$'+json.dumps(subset,separators=(',',':'))+'$targeted_owners$','$targeted_owners$'+payload+'$targeted_owners$',1)==raw
  return bound
 pre=adapted('targeted_before',before);post=adapted('targeted_after',after)
 header=source[:source.index('DO $operator$')];header=header[header.index('BEGIN;'):];operator=block('operator');own=block('quality_own_version')
 used_unallocated_adapter='UNALLOCATED_QUALITY_VERSION'in own
 if used_unallocated_adapter:
  expect(header+own+'ROLLBACK;','quality_cover_allocate_version_required');own=own.replace('UNALLOCATED_QUALITY_VERSION','19000101000000')
 version=re.search(r"v text:='([^']+)'",own).group(1);assert re.fullmatch('[0-9]{14}',version)
 # Native synthetic version adapter is never an allocated migration/history proof.
 cap5="DO $$BEGIN IF current_setting('statement_timeout')::interval<>interval'5s'OR current_setting('transaction_timeout')::interval<>interval'60s'OR current_setting('lock_timeout')::interval<>interval'1s'OR current_setting('timezone')<>'UTC'THEN RAISE EXCEPTION 'quality_native_actual_DDL_caps_wrong';END IF;END$$;"
 cap15="DO $$BEGIN IF current_setting('statement_timeout')::interval<>interval'15s'THEN RAISE EXCEPTION 'quality_native_postguard_cap_wrong';END IF;END$$;"
 matches=list(re.finditer(r'^CREATE OR REPLACE FUNCTION public\.(fn_accounting_tournament_week_quality)\(',source,re.M));assert len(matches)==1
 chunks=[]
 for m in matches:
  a=m.start();dollar=re.search(r'AS (\$\w*\$)',source[a:]).group(1);first=source.index(dollar,a);z=source.index(dollar,first+len(dollar))+len(dollar);ddl=source[a:z].rstrip(';')+';';assert re.findall(r"SET LOCAL statement_timeout='([^']+)'",source[:a])[-1]=='5s';signature='public.'+m.group(1)+(' (uuid,timestamptz,timestamptz)'if m.group(1).endswith('week_quality')else' (uuid)');signature=signature.replace(' (','(');explicit='REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;';assert source[z:].lstrip().startswith(';\n'+explicit)or source[z:].lstrip().startswith(explicit);chunks.append("SET LOCAL statement_timeout='5s';"+cap5+ddl+explicit+cap5)
 acl='REVOKE ALL ON FUNCTION public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)FROM PUBLIC,anon,authenticated,service_role;';assert acl in source and source.split(acl,1)[1].lstrip().startswith("SET LOCAL statement_timeout='15s';")
 chunk=''.join(chunks)+acl+cap5+"SET LOCAL statement_timeout='15s';"+cap15
 q("SET timezone='America/Chicago';"+header+operator+own+pre+chunk+post+'ROLLBACK;');cases.append('exact_one_real_owner_DDL5_post15_tx60_lock1_UTC_native_authority_pass')
 for prefix in ['SET ROLE service_role;',"SET request.jwt.claims='{}';"]:expect(prefix+header+operator+'ROLLBACK;','quality_cover_operator_or_freeze_refused')
 cases.append('role_and_JWT_refused')
 q("INSERT INTO supabase_migrations.schema_migrations(version)VALUES('"+version+"');");expect(header+own+'ROLLBACK;','quality_cover_own_version_already_recorded');q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+version+"';");cases.append('own_version_replay_refused')
 expect(header+cap5+'ROLLBACK;','quality_native_actual_DDL_caps_wrong');cases.append('wrong_DDL15_regression_refused')
 expect(header+operator+own+pre+chunk+'ALTER FUNCTION '+targets[0]['signature']+' COST 101;'+post+'COMMIT;','quality_cover_targeted_authority_changed');cases.append('post_metadata_fault_rolls_back_real_replacement')
 for x in targets:assert json.loads(q("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+x['signature']+"'::regprocedure"))==native[x['signature']]
 # All operative source authority/history/financial/index DO bodies compile;
 # no fake source65, generation, paid-wallet or receipt collaborator executes.
 blocks=re.findall(r'DO (\$[A-Za-z_]+\$)(.*?)\1;',source,re.S)
 for i,(tag,body)in enumerate(blocks):q('CREATE FUNCTION native_successor_guard_'+str(i)+'()RETURNS void LANGUAGE plpgsql AS $compile_only$'+body+'$compile_only$;')
 cases.append('all_actual_nine_authority_history_financial_GEN_index_guards_grammar_only')
 return {'passed':True,'cases':cases,'native_one_owner_metadata_adapter_inverse':True,'all9_actual_guards_preserved_in_source':True,'financial_and_GEN_runtime_NOT_faked':True,'unallocated_version_adapter_explicit':used_unallocated_adapter,'actual_allocated_version_guard_tested':not used_unallocated_adapter,'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'public_install_or_whole_capacity_claim':False}
