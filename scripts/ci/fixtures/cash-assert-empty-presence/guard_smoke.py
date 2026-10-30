"""Native-only real catalogue guards; production SQL is never executed remotely."""
import json,re,hashlib
from pathlib import Path

def run(q,candidate,old,new,out):
 sig='public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'
 q("CREATE ROLE service_role;CREATE ROLE native_cash_other;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(NULLIF(current_setting('native_cash.frozen',true),'')::boolean,false)$$;CREATE FUNCTION public.native_cash_assert_fixture_clock()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT make_timestamptz(2026,10,30,14,COALESCE(NULLIF(current_setting('native_cash.minute',true),'')::integer,10),0,'UTC')$$;")
 defs=json.loads((Path(__file__).parent/'catalog-owner-definitions.json').read_text())
 for definition in defs:
  q(definition+';')
  name=re.search(r'FUNCTION ([^(]+)',definition).group(1)+'()'
  q('REVOKE ALL ON FUNCTION '+name+'FROM PUBLIC;')
 q(old+';REVOKE ALL ON FUNCTION '+sig+'FROM PUBLIC;GRANT EXECUTE ON FUNCTION '+sig+'TO service_role;')
 native=json.loads(q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='"+sig+"'::regprocedure;"))
 source=candidate.read_text();changes=[];allowed={'oid','proowner','prolang','pronamespace'}
 for m in re.finditer(r'\$actual_meta\$(.*?)\$actual_meta\$',source,re.S):
  actual=json.loads(m.group(1));delta={k:{'production':actual[k],'native':native[k]}for k in actual if actual[k]!=native[k]};assert set(delta)<=allowed
  changes.append({'start':m.start(1),'end':m.end(1),'before':m.group(1),'after':json.dumps(native,separators=(',',':')),'context_oid_deltas':delta})
 assert len(changes)==2
 for m in re.finditer(r'\$exact_catalog_owners\$(.*?)\$exact_catalog_owners\$',source,re.S):
  actual=json.loads(m.group(1));localized=[]
  for owner in actual:
   n=json.loads(q("SELECT jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+owner['signature']+"'::regprocedure;"))
   assert n['md5']==owner['md5'],'real GEN/source definition changed in fixture'
   delta={k for k in owner['metadata'] if owner['metadata'][k]!=n['metadata'][k]};assert delta<=allowed,delta
   localized.append(dict(owner,metadata=n['metadata']))
  changes.append({'start':m.start(1),'end':m.end(1),'before':m.group(1),'after':json.dumps(localized,separators=(',',':')),'real_function_definition_hashes_unchanged':True})
 assert len(changes)==4;changes.sort(key=lambda c:c['start']);localized=source
 for c in reversed(changes):localized=localized[:c['start']]+c['after']+localized[c['end']:]
 clock="extract(minute FROM clock_timestamp()AT TIME ZONE 'UTC')";fixture_clock="extract(minute FROM public.native_cash_assert_fixture_clock()AT TIME ZONE 'UTC')";assert localized.count(clock)==4;localized=localized.replace(clock,fixture_clock)
 inverse=localized.replace(fixture_clock,clock);offset=0;positions=[]
 for c in changes:positions.append((c['start']+offset,c));offset+=len(c['after'])-len(c['before'])
 for pos,c in reversed(positions):assert inverse[pos:pos+len(c['after'])]==c['after'];inverse=inverse[:pos]+c['before']+inverse[pos+len(c['after']):]
 assert inverse==source and new.rstrip()in localized
 version=re.search(r"WHERE version='(\d{14})'",source).group(1)
 cases=[('wrong_owner','ALTER FUNCTION '+sig+'OWNER TO native_cash_other;','cash_assert_presence_exact_actual_owner_changed'),('wrong_GEN',"ALTER FUNCTION smarter_private.original_inventory_basis_generation()COST 101;",'cash_assert_GEN_source65_exact_catalog_owner_changed'),('wrong_source',"ALTER FUNCTION smarter_private.original_inventory_proof_sources_match()COST 101;",'cash_assert_GEN_source65_exact_catalog_owner_changed'),('frozen',"SET LOCAL native_cash.frozen='true';",'cash_assert_presence_install_frozen_or_cutover'),('existing_history',"INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"');",'cash_assert_presence_version_already_recorded'),('unauthenticated_claim',"SET LOCAL request.jwt.claim.role='authenticated';",'cash_assert_presence_postgres_required'),('unauthenticated_current_role','SET LOCAL ROLE native_cash_other;','cash_assert_presence_postgres_required'),('cutover_clock',"SET LOCAL native_cash.minute='55';",'cash_assert_presence_install_frozen_or_cutover')]
 results=[]
 for name,setup,error in cases:
  q(old+';');assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));")=='0df1c3e9fe3e1a0e53a043baf57127d7'
  try:q('BEGIN;'+setup+localized)
  except AssertionError as e:assert error in str(e),(name,str(e))
  else:raise AssertionError('guard accepted invalid fixture:'+name)
  assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));")=='0df1c3e9fe3e1a0e53a043baf57127d7'
  results.append({'case':name,'refused_before_owner_change':True,'error':error})
 q(localized)
 assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));")=='49069d66667813f6f332b8f72c523295'
 assert json.loads(q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='"+sig+"'::regprocedure;"))==native
 result={'native_guard_only_transition_PASS':True,'production_candidate_sha256':hashlib.sha256(source.encode()).hexdigest(),'localized_fixture_sha256':hashlib.sha256(localized.encode()).hexdigest(),'full_inverse_to_production_source_PASS':True,'only_context_OIDs_and_four_explicit_cutover_clock_expressions_localized':True,'real_GEN58dc_source65_1736_definition_hashes_unchanged':True,'real_ACL_SECDEF_volatility_searchpath_unchanged':True,'positive_actual_migration_installs49069':True,'negative_cases':results,'whole_capacity_NOT_claimed':True,'production_calls':False}
 (out/'cash-assert-empty-presence-guard-result.json').write_text(json.dumps(result,indent=2)+'\n');(out/'cash-assert-empty-presence-localization-inverse.json').write_text(json.dumps({'source_sha256':result['production_candidate_sha256'],'metadata_replacements':changes,'clock_guard_expression_count':4,'exact_inverse_PASS':True,'NATIVE_ONLY_DO_NOT_EXECUTE_LOCALIZED_SOURCE_IN_PRODUCTION':True},indent=2)+'\n');return result
