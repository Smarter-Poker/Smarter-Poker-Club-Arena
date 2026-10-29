#!/usr/bin/env python3
"""Private PG17 exact fee fingerprint semantics, admission ABI and atomic installer."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,socket,subprocess,tempfile
R=Path(__file__).resolve().parents[2];FX=R/'scripts/ci/fixtures/weekly-fee-fingerprint';SIG='public.fn_accounting_tournament_fee_fingerprint(public.rake_records)'
def lit(s):return "'"+str(s).replace("'","''")+"'"
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();assert a.scratch.is_dir()and not a.output.exists()
 c=json.loads((FX/'source-contract.json').read_text());authority=json.loads((FX/'actual-authority.json').read_text());migration=(R/c['migration']).read_text();assert hashlib.sha256(migration.encode()).hexdigest()==c['migration_sha256'];old=(FX/'fingerprint-before.sql').read_text();new=(FX/'fingerprint-after.sql').read_text();assert hashlib.md5(old.encode()).hexdigest()==c['before_full_md5']and hashlib.md5(new.encode()).hexdigest()==c['after_full_md5'];cases=[]
 with tempfile.TemporaryDirectory(prefix='fp-',dir=a.scratch)as tmp:
  t=Path(tmp);data=t/'d';env={k:v for k,v in os.environ.items()if not k.startswith('PG')};sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();env.update(TMPDIR=str(t),TMP=str(t),TEMP=str(t));pg=a.pg_bin;started=False;ps=[pg/'psql','-XAtq','-w','-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
  def run(cmd,sql=None,error=None):
   r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=40);assert(r.returncode!=0 and error in r.stderr)if error else r.returncode==0,(r.stdout,r.stderr,error);return r.stdout.strip()
  statement_number=0
  def q(s,error=None):
   nonlocal statement_number
   statement_number+=1;path=t/("statement-"+str(statement_number)+".sql");path.write_text(s)
   return run(ps+["-f",path],error=error)
  def js(s):return json.loads(q(s))
  def state():return q("SELECT jsonb_build_array(pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid="+lit(SIG)+"::regprocedure")
  try:
   run([pg/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',data,'-l',t/'postgres.log','-o',f"-h 127.0.0.1 -p {port} -k ''",'-w','start']);started=True
   q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO PUBLIC;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql AS $$SELECT NULLIF(current_setting('native.auth_uid',true),'')::uuid$$;CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('native.frozen',true),'off')='on'$$;CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT NULLIF(current_setting('native.boundary',true),'')::timestamptz$$;CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql AS $$SELECT NULLIF(current_setting('native.window_refusal',true),'')$$;")
   q('CREATE TABLE public.rake_records('+','.join('"'+x['name']+'" '+x['type']for x in authority['columns'])+');'+old+';REVOKE ALL ON FUNCTION '+SIG+' FROM PUBLIC;')
   q("CREATE TABLE public.ca_mtt_admission_contract(singleton boolean PRIMARY KEY CHECK(singleton),abi text NOT NULL CHECK(abi IN('legacy-capacity-v1','unlimited-mtt-v2')));INSERT INTO public.ca_mtt_admission_contract VALUES(true,'unlimited-mtt-v2');"+authority['guard_definition']+';'+ ';'.join(authority['admission_definitions'].values())+';'+';'.join(x['definition']for x in authority['triggers'])+';')
   for g in authority['admission_owners']:q('REVOKE ALL ON FUNCTION '+g['signature']+' FROM PUBLIC')
   q("CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('native.sources',true),'on')<>'off' AND NOT(COALESCE(current_setting('native.post_sources',true),'off')='on' AND md5(pg_get_functiondef('"+SIG+"'::regprocedure))='"+c['after_full_md5']+"')$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql AS $$SELECT CASE WHEN COALESCE(current_setting('native.generation',true),'on')='off' OR (COALESCE(current_setting('native.post_generation',true),'off')='on' AND md5(pg_get_functiondef('"+SIG+"'::regprocedure))='"+c['after_full_md5']+"') THEN 'changed' ELSE '"+c['source65_generation']+"' END$$;")
   # Only cluster-specific OID identities are translated. All metadata/ACL,
   # code, ABI and function attributes remain exact and fault-tested.
   def normalize(raw):
    for tag in ['fp_metadata','admission_owners']:
     for m in list(re.finditer(r'\$'+tag+r'\$(.*?)\$'+tag+r'\$',raw,re.S))[::-1]:
      parsed=json.loads(m[1]);rows=parsed if isinstance(parsed,list)else[{'signature':SIG,'metadata':parsed}]
      for row in rows:
       local=js("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid="+lit(row['signature'])+'::regprocedure');meta=row['metadata']
       for k in ['oid','proowner','prolang','pronamespace','proargtypes']:meta[k]=local[k]
      value=rows if isinstance(parsed,list)else rows[0]['metadata'];raw=raw[:m.start(1)]+json.dumps(value,separators=(',',':'))+raw[m.end(1):]
    return raw
   native=normalize(migration)
   def refused(prefix,error,sql=None):
    before=state();q(prefix+(sql or native),error);assert state()==before;cases.append(error)
   for prefix in ["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET native.auth_uid='00000000-0000-0000-0000-000000000001';","SET ROLE service_role;"]:refused(prefix,'weekly_fee_fp_operator_refused')
   for prefix in ["SET native.frozen='on';","SET native.window_refusal='blocked';","SET native.boundary='2026-10-29 04:00Z';"]:refused(prefix,'weekly_fee_fp_window_refused')
   version=Path(c['migration']).name.split('_')[0];q("INSERT INTO supabase_migrations.schema_migrations VALUES("+lit(version)+')');refused('','weekly_fee_fp_history_replay');q('DELETE FROM supabase_migrations.schema_migrations');refused("SET native.sources='off';",'weekly_fee_fp_source65_required');refused("SET native.generation='off';",'weekly_fee_fp_generation_required')
   for alter,restore in [('VOLATILE','IMMUTABLE'),('STRICT','CALLED ON NULL INPUT'),('SECURITY DEFINER','SECURITY INVOKER'),('SET search_path=pg_catalog','SET search_path=public')]:
    q('ALTER FUNCTION '+SIG+' '+alter);refused('','weekly_fee_fp_exact_preimage_required');q('ALTER FUNCTION '+SIG+' '+restore)
   q('ALTER FUNCTION '+SIG+' OWNER TO service_role');refused('','weekly_fee_fp_exact_preimage_required');q('ALTER FUNCTION '+SIG+' OWNER TO postgres')
   q('GRANT EXECUTE ON FUNCTION '+SIG+' TO authenticated');refused('','weekly_fee_fp_exact_preimage_required');q('REVOKE EXECUTE ON FUNCTION '+SIG+' FROM authenticated')
   q('ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() COST 101');refused('','weekly_fee_fp_admission_owner_changed');q('ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() COST 100')
   q("ALTER TABLE public.ca_mtt_admission_contract DISABLE TRIGGER USER");refused('','weekly_fee_fp_admission_triggers_changed');q('ALTER TABLE public.ca_mtt_admission_contract ENABLE TRIGGER USER')
   q('ALTER TABLE public.ca_mtt_admission_contract DISABLE TRIGGER USER;UPDATE public.ca_mtt_admission_contract SET abi=\'legacy-capacity-v1\';ALTER TABLE public.ca_mtt_admission_contract ENABLE TRIGGER USER;');refused('','weekly_fee_fp_admission_abi_changed');q('ALTER TABLE public.ca_mtt_admission_contract DISABLE TRIGGER USER;UPDATE public.ca_mtt_admission_contract SET abi=\'unlimited-mtt-v2\';ALTER TABLE public.ca_mtt_admission_contract ENABLE TRIGGER USER;')
   refused("SET native.post_sources='on';",'weekly_fee_fp_source65_required');refused("SET native.post_generation='on';",'weekly_fee_fp_generation_required');cases.append('postcondition_failure_rolls_back_exact_function_and_full_metadata')
   metadata=js("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid="+lit(SIG)+'::regprocedure');before_guard=q("SELECT md5(pg_get_functiondef('public.fn_ca_guard_mtt_admission_contract()'::regprocedure))");assert before_guard=='98363a25bad4495a4b32e7cd99354c37';q(native);assert q("SELECT md5(pg_get_functiondef('"+SIG+"'::regprocedure))")==c['after_full_md5'];assert js("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid="+lit(SIG)+'::regprocedure')==metadata;assert q("SELECT md5(pg_get_functiondef('public.fn_ca_guard_mtt_admission_contract()'::regprocedure))")==before_guard;cases.append('exact_single_owner_install_metadata_ACL_ABI_source65_GEN_preserved');q("INSERT INTO supabase_migrations.schema_migrations VALUES("+lit(version)+')');refused('','weekly_fee_fp_history_replay');q('DELETE FROM supabase_migrations.schema_migrations')
   q("UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2'")
   for statement in ["UPDATE public.ca_mtt_admission_contract SET abi='legacy-capacity-v1'","DELETE FROM public.ca_mtt_admission_contract","TRUNCATE public.ca_mtt_admission_contract"]:q(statement,'MTT_ADMISSION_CONTRACT_IMMUTABLE')
   cases.append('exact_spent_admission_guard_sameABI_noop_and_immutable_reverse_delete_truncate')
   # Full JSON oracle as well as whole fingerprints on exact 20 column types.
   keys=c['economic_keys'];oldjson="SELECT jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)FROM unnest(ARRAY["+','.join(lit(k)for k in keys)+']::text[])field';newjson='SELECT jsonb_build_object('+','.join(lit(k)+',p_row.'+k for k in keys)+')';q(old.replace('public.fn_accounting_tournament_fee_fingerprint(','public.oracle_fingerprint(',1)+';CREATE FUNCTION old_json(p_row public.rake_records)RETURNS jsonb LANGUAGE sql AS $$'+oldjson+'$$;CREATE FUNCTION new_json(p_row public.rake_records)RETURNS jsonb LANGUAGE sql AS $$'+newjson+'$$;')
   allfields={x['name']:('00000000-0000-0000-0000-000000000017'if x['type']=='uuid'else '2026-10-29T07:28:20.123456Z'if x['type']=='timestamp with time zone'else {'nested':['Unicode',None]}if x['type']=='jsonb'else True if x['type']=='boolean'else 9223372036854775807 if x['type']=='bigint'else -17 if x['type']=='integer'else '-99999999999999.1234'if x['type'].startswith('numeric')else 'Unicode雪é')for x in authority['columns']}
   docs=[None,{},allfields,{'rake_amount':'NaN'},{'created_at':'infinity'},{'created_at':'-infinity'},{'metadata':False,'player_contributions':[None,1],'returned_uncalled':'text'},{'metadata':{'large':'雪'*22000}},{'source':'é雪🌍\\n"','created_at':'2026-10-29T07:28:20.123456Z'}]
   for zone in ['UTC','America/Chicago','Asia/Kathmandu']:
    for doc in docs:
     param='NULL::jsonb'if doc is None else lit(json.dumps(doc,ensure_ascii=False))+'::jsonb';assert q('SET timezone='+lit(zone)+";WITH x AS(SELECT jsonb_populate_record(NULL::public.rake_records,"+param+")AS r)SELECT old_json(r)IS NOT DISTINCT FROM new_json(r)AND public.oracle_fingerprint(r)IS NOT DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)FROM x")=='t';cases.append('whole_JSON_and_fingerprint_parity_'+zone)
   for special in ['Infinity','-Infinity']:q('SELECT jsonb_populate_record(NULL::public.rake_records,'+lit(json.dumps({'rake_amount':special}))+'::jsonb)','numeric field overflow')
   q("DO $$DECLARE p public.rake_records;j jsonb;BEGIN p:=jsonb_populate_record(NULL::public.rake_records,'{\"rake_amount\":42}');j:=old_json(p);p.terminal_closed_at:='infinity';p.seat_count_in_force:=999;p.max_rake_cap_in_force:='NaN';IF j IS DISTINCT FROM new_json(p)OR j IS DISTINCT FROM old_json(p)THEN RAISE EXCEPTION 'excluded_column_changed';END IF;END$$;");cases.append('excluded_terminal_fields_do_not_change_hash')
   q('ALTER TABLE public.rake_records ADD COLUMN unrelated_future_column jsonb');assert q("WITH x AS(SELECT jsonb_populate_record(NULL::public.rake_records,'{\"unrelated_future_column\":{\"ignored\":true}}')AS r)SELECT old_json(r)IS NOT DISTINCT FROM new_json(r)AND public.oracle_fingerprint(r)IS NOT DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)FROM x")=='t';cases.append('unrelated_schema_addition_preserves_versioned_economic_hash')
   result={'qualification':'passed','case_count':len(cases),'cases':cases,'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'before_full_md5':c['before_full_md5'],'actual_after_full_md5':c['after_full_md5'],'admission_guard_md5':before_guard,'limits':'Private PG17 exact20 accessed column types; OIDs translated only for isolated catalog identity. No production capacity or closure claim.'};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
  finally:
   if started:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
