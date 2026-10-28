#!/usr/bin/env python3
"""PG17 original linked reader, cheap union selector and exact two-index recovery."""
from pathlib import Path
import argparse,subprocess,tempfile,os,json,hashlib,socket,time
R=Path(__file__).resolve().parents[2];FX=R/'scripts/ci/fixtures/cash-link-union-proof-index';M=R/'supabase/migrations/20261028184144_original_cash_proofs_select_their_union_before_the_hand_join.sql'
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);a=ap.parse_args();assert a.scratch.is_dir()and not a.out.exists();cases=[]
 with tempfile.TemporaryDirectory(prefix='lp-',dir=a.scratch)as tmp:
  t=Path(tmp);data=t/'d';pg=a.pg_bin;env={k:v for k,v in os.environ.items()if not k.startswith('PG')};sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();env.update(PGHOST='127.0.0.1',PGPORT=str(port),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable',TMPDIR=str(t))
  def run(cmd,s=None,error=None):
   x=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=120)
   assert(x.returncode!=0 and error in x.stderr)if error else x.returncode==0,(x.stdout,x.stderr,error)
   return x.stdout.strip()
  query_number=0
  def q(s,error=None):
   nonlocal query_number
   query_number+=1;sql_file=t/('statement-'+str(query_number)+'.sql');sql_file.write_text(s)
   return run([pg/'psql','-XAtq','-v','ON_ERROR_STOP=1','-f',sql_file],error=error)
  run([pg/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);(data/'postgresql.conf').write_text((data/'postgresql.conf').read_text()+"\nlisten_addresses='127.0.0.1'\nport="+str(port)+"\nunix_socket_directories=''\nshared_buffers='16MB'\nmaintenance_work_mem='16MB'\n")
  run([pg/'pg_ctl','-D',data,'-l',t/'server.log','-w','start'])
  try:
   parse="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
   parts=json.loads(run(['node','--input-type=module','-e',parse,M]));assert parts['ok']and len(parts['indexes'])==1;cases.append('maintained_CCI_parser_one_index_one_transaction')
   statement=parts['indexes'][0]['statement'];body=parts['body'];raw_fixture=(FX/'native-fixture.sql').read_text();prefix,suffix=raw_fixture.split('-- INSTALL_EXACT_CCI_AND_BODY')
   # This isolated fixture table survives the separate autocommit CCI calls;
   # its full original 4-field response remains the independent baseline.
   q(prefix.replace('CREATE TEMP TABLE baseline','CREATE TABLE baseline'))
   q("CREATE SEQUENCE native_proof_calls;CREATE FUNCTION native_counted_proof(jsonb)RETURNS text LANGUAGE plpgsql IMMUTABLE AS $c$BEGIN PERFORM nextval('public.native_proof_calls');RETURN md5($1::text);END$c$;")
   started=time.monotonic();q("CREATE INDEX native_old_proof_cost ON public.union_pnl_cash_outcome_link_resolutions USING hash((game_scope->>'game_union_id'))WHERE proof_md5=native_counted_proof(proof)");old_ms=(time.monotonic()-started)*1000;old_calls=int(q('SELECT last_value FROM native_proof_calls'));assert old_calls==6000
   new_cost_statement=statement.replace('CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_links_valid_union_hash','CREATE INDEX native_new_key_cost');assert new_cost_statement!=statement and 'CONCURRENTLY'not in new_cost_statement;started=time.monotonic();q(new_cost_statement);new_ms=(time.monotonic()-started)*1000;assert int(q('SELECT last_value FROM native_proof_calls'))==old_calls
   q('DROP INDEX native_old_proof_cost;DROP INDEX native_new_key_cost;DROP FUNCTION native_counted_proof(jsonb);DROP SEQUENCE native_proof_calls;');cases.append('global_6000_large_proof_serializations_old_predicate_vs_ZERO_new_hash_build')
   build_cost={'rows':6000,'large_proof_bytes_per_row':int(q('SELECT min(octet_length(proof::text))FROM public.union_pnl_cash_outcome_link_resolutions')),'old_global_proof_serializations':old_calls,'new_global_proof_serializations':0,'old_fixture_ms':old_ms,'new_fixture_ms':new_ms,'production_capacity_not_claimed':True,'old_timing_includes_counting_wrapper_overhead':True}
   # Reproduce an interrupted real CONCURRENTLY build with its exact old
   # definition. Only the observed local fixture OID is mapped in native code;
   # production admission remains pinned to the actual failed OID275975891.
   old_statement="CREATE INDEX CONCURRENTLY union_pnl_cash_links_valid_union_hash ON public.union_pnl_cash_outcome_link_resolutions USING hash((game_scope->>'game_union_id'))WHERE proof_md5=md5(proof::text)"
   q("SET statement_timeout='30ms';"+old_statement,'statement timeout')
   observed=q("SELECT indexrelid::text FROM pg_index WHERE indexrelid=to_regclass('public.union_pnl_cash_links_valid_union_hash')AND NOT indisvalid AND NOT indisready AND indislive");assert observed.isdigit(),'actual interrupted index must be present/invalid/notready/live'
   retire_observed=q("SELECT indexrelid::text FROM pg_index WHERE indexrelid='public.union_pnl_cash_links_valid_proof_hand'::regclass AND indisvalid AND indisready AND indislive");assert retire_observed.isdigit();module=R/'scripts/ci/contract-index-recovery.mjs';module_text=module.read_text();needle="export const CASH_HASH_FAILED_OID = '275975891';";assert module_text.count(needle)==1
   mapped=t/'native-recovery.mjs';retire_needle="export const CASH_PROOF_HAND_OID = '271236984';";assert module_text.count(retire_needle)==1;mapped.write_text(module_text.replace(needle,"export const CASH_HASH_FAILED_OID = '"+observed+"';",1).replace(retire_needle,"export const CASH_PROOF_HAND_OID = '"+retire_observed+"';",1))
   def js(code):return run(['node','--input-type=module','-e',"import * as x from "+json.dumps(mapped.as_uri())+";"+code])
   request=json.loads(js("import fs from'node:fs';console.log(JSON.stringify(x.recoveryRequest(x.CASH_HASH_FILE,fs.readFileSync("+json.dumps(str(M))+",'utf8'),x.CASH_HASH_INDEX,"+json.dumps(observed)+",new Date().toISOString())));"))
   catalog=js('console.log(x.recoveryCatalog('+json.dumps(request)+'));');rows=json.loads(q('SELECT json_agg(r)FROM('+catalog+')r'))
   js('x.validateRecoveryCatalog('+json.dumps(rows)+','+json.dumps(request)+');');assert len(rows)==1 and rows[0]['cash_proof_check_validated']is True;cases.append('actual_CCI_timeout_exact_invalid_notready_live_catalog_validated_check')
   for field,value in [('valid',True),('ready',True),('live',False),('oid','1'),('definition','wrong'),('no_builder',False),('cash_proof_check_validated',False),('no_constraints',False),('no_transients',False)]:
    bad=[dict(rows[0],**{field:value})];run(['node','--input-type=module','-e',"import * as x from "+json.dumps(mapped.as_uri())+";x.validateRecoveryCatalog("+json.dumps(bad)+','+json.dumps(request)+');'],error='Error:');cases.append('exact_HASH_recovery_refuses_'+field)
   # Re-read the exact catalog immediately before the sole bound drop.
   rows=json.loads(q('SELECT json_agg(r)FROM('+catalog+')r'));js('x.validateRecoveryCatalog('+json.dumps(rows)+','+json.dumps(request)+');')
   q(js('console.log(x.recoveryStatement('+json.dumps(request)+'));')+';');after_rows=json.loads(q('SELECT coalesce(json_agg(r),\'[]\')FROM('+catalog+')r'));js('x.validateRecoveryCatalog('+json.dumps(after_rows)+','+json.dumps(request)+',true);');cases.append('real_bound_DROP_CONCURRENTLY_proves_absence_before_new_CCI')
   # Preserve the usable old index until its replacement is fully valid.
   q(statement+';');assert q("SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='public.union_pnl_cash_links_valid_union_hash'::regclass")=='t'
   selector_observed=q("SELECT indexrelid::text FROM pg_index WHERE indexrelid='public.union_pnl_cash_links_valid_union_hash'::regclass")
   request=json.loads(js("import fs from'node:fs';console.log(JSON.stringify(x.cashHashRetirementRequest(x.CASH_HASH_FILE,fs.readFileSync("+json.dumps(str(M))+",'utf8'),"+json.dumps(selector_observed)+','+json.dumps(request['before'])+')));'))
   resume=json.loads(js("import fs from'node:fs';console.log(JSON.stringify(x.recoveryRequest(x.CASH_HASH_FILE,fs.readFileSync("+json.dumps(str(M))+",'utf8'),x.CASH_PROOF_HAND_INDEX,"+json.dumps(retire_observed)+','+json.dumps(request['before'])+',null,'+json.dumps(selector_observed)+')));'));assert resume['retirementOnly']is True and resume['selectorOid']==selector_observed;cases.append('explicit_retirement_only_resume_binds_fresh_valid_selector_OID_without_rebuild')
   retirement_catalog=js('console.log(x.cashHashRetirementCatalog('+json.dumps(request)+'));');retirement_rows=json.loads(q('SELECT json_agg(r)FROM('+retirement_catalog+')r'));js('x.validateCashHashRetirement('+json.dumps(retirement_rows)+','+json.dumps(request)+');x.validateCashHashRetirement('+json.dumps(retirement_rows)+','+json.dumps(resume)+');');cases.append('actual_valid_old_index_exact_OID_dependencies_constraints_and_new_selector_before_retirement')
   for field,value in [('valid',False),('ready',False),('live',False),('oid','1'),('definition','wrong'),('no_builder',False),('no_incoming_dependencies',False),('exact_auto_dependencies',False),('no_constraints',False),('new_selector_valid',False),('new_selector_oid','1'),('original_indexes',[]),('original_constraints',[])]:
    bad=[dict(retirement_rows[0],**{field:value})];run(['node','--input-type=module','-e',"import * as x from "+json.dumps(mapped.as_uri())+";x.validateCashHashRetirement("+json.dumps(bad)+','+json.dumps(request)+');'],error='Error:');cases.append('exact_valid_proof_retirement_refuses_'+field)
   retirement_rows=json.loads(q('SELECT json_agg(r)FROM('+retirement_catalog+')r'));js('x.validateCashHashRetirement('+json.dumps(retirement_rows)+','+json.dumps(request)+');');q(js('console.log(x.cashHashRetirementStatement('+json.dumps(request)+'));')+';');after_retirement=json.loads(q('SELECT coalesce(json_agg(r),\'[]\')FROM('+retirement_catalog+')r'));js('x.validateCashHashRetirement('+json.dumps(after_retirement)+','+json.dumps(request)+',true);');cases.append('real_valid_proof_DROP_CONCURRENTLY_after_new_selector_valid_exact_absence')
   # Both physical indexes have reached their final state. A failed pure
   # qualification or atomic-history assertion must resume without DDL replay.
   state_catalog=js('console.log(x.cashHashSelectorStateCatalog());');completed=json.loads(q('SELECT json_agg(r)FROM('+state_catalog+')r'));js('x.validateCashHashSelectorState('+json.dumps(completed)+','+json.dumps(request)+',true);x.validateCashHashSelectorState('+json.dumps(completed)+','+json.dumps(resume)+',true);')
   q(body.replace('BEGIN;',"BEGIN;SET LOCAL fixture.source65='false';",1),'source65_required');assert q("SELECT indexrelid::text FROM pg_index WHERE indexrelid='public.union_pnl_cash_links_valid_union_hash'::regclass")==selector_observed;cases.append('postretirement_pure_body_failure_preserves_valid_selector_and_absent_old_index')
   q('CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);')
   history_js="import fs from'node:fs';const source=fs.readFileSync("+json.dumps(str(R/'scripts/ci/apply-recorded-migration.mjs'))+",'utf8'),sql=fs.readFileSync("+json.dumps(str(M))+",'utf8'),version='20261028184144',slug='original_cash_proofs_select_their_union_before_the_hand_join',tag='$ca_file_history_'+version+'$',exactSQLLiteral=tag+sql+tag;const template=source.match(/const historyStatement = `([\\s\\S]*?)`;/)[1];const statement=template.replaceAll('${version}',version).replaceAll('${slug}',slug).replaceAll('${exactSQLLiteral}',()=>exactSQLLiteral);if(statement.includes('${'))throw Error('unexpanded history');console.log(JSON.stringify({statement,exactSQLLiteral}));"
   history=json.loads(js(history_js));atomic=body.rsplit('COMMIT;',1)[0]+history['statement']+'COMMIT;'
   bad=body.rsplit('COMMIT;',1)[0]+history['statement'].replace('ARRAY['+history['exactSQLLiteral']+'::text]',"ARRAY['wrong-source']",1)+'COMMIT;';q(bad,'atomic migration history does not match the exact source file');assert q('SELECT count(*)FROM supabase_migrations.schema_migrations')=='0';cases.append('postretirement_atomic_history_failure_keeps_exact_physical_completion_and_no_history')
   completed=json.loads(q('SELECT json_agg(r)FROM('+state_catalog+')r'));js('x.validateCashHashSelectorState('+json.dumps(completed)+','+json.dumps(resume)+',true);');q(atomic);assert q("SELECT indexrelid::text FROM pg_index WHERE indexrelid='public.union_pnl_cash_links_valid_union_hash'::regclass")==selector_observed;assert q("SELECT to_regclass('public.union_pnl_cash_links_valid_proof_hand')IS NULL")=='t';recorded=json.loads(q("SELECT to_jsonb(m)FROM supabase_migrations.schema_migrations m WHERE version='20261028184144'"));assert recorded['statements']==[M.read_text()];cases.append('explicit_completed_state_history_only_resume_preserves_selector_OID_and_exact_file_bytes_without_CCI_or_DROP')
   out=q(suffix);a.out.with_suffix('.log').write_text(out)
   # psql emits JSON plans on independent lines. They are real custom/generic plans.
   decoder=json.JSONDecoder();plans=[];rest=out
   while '['in rest:
    rest=rest[rest.index('['):]
    try:v,n=decoder.raw_decode(rest)
    except json.JSONDecodeError:rest=rest[1:];continue
    if isinstance(v,list)and v and isinstance(v[0],dict)and 'Plan'in v[0]:plans.append(v[0])
    rest=rest[n:]
   assert len(plans)==3
   def nodes(n):
    yield n
    for c in n.get('Plans',[]):yield from nodes(c)
   for plan in plans:
    ns=list(nodes(plan['Plan']));assert any(n.get('Index Name')=='union_pnl_cash_links_valid_union_hash'for n in ns);assert not any(n.get('Node Type')=='Seq Scan'and n.get('Relation Name')=='union_pnl_cash_outcome_link_resolutions'for n in ns);assert not any(n.get('Index Name')=='union_pnl_cash_links_valid_proof_hand'for n in ns)
   cases+=['original_all4field_60rows_fullbag_unchanged','natural_custom_and_GENERIC_PLAN_union_hash_index_selected','6000_actual_constraints_large_JSON_sources_retained','valid_16KB_payload_and_foreign_union_text_accepted_hash_index']
   seal=q("SELECT jsonb_build_array(md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure)),smarter_private.original_inventory_proof_sources_match(),smarter_private.original_inventory_basis_generation(),(SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions))")
   point_source=q("SELECT md5(to_jsonb(r)::text)FROM public.union_pnl_cash_outcome_link_resolutions r WHERE hand_id=md5('hand100')::uuid")
   hand_plan=json.loads(q("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)SELECT *FROM public.union_pnl_cash_outcome_link_resolutions WHERE hand_id=md5('hand100')::uuid"))[0];assert any(n.get('Index Name')=='union_pnl_cash_outcome_link_resolutions_hand_id_key'for n in nodes(hand_plan['Plan']));assert point_source;cases.append('original_hand_id_lookup_uses_surviving_unique_constraint_index')
   q(statement+';');q(body);assert q("SELECT jsonb_build_array(md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure)),smarter_private.original_inventory_proof_sources_match(),smarter_private.original_inventory_basis_generation(),(SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions))")==seal;cases.append('exact_CCI_replay_catalog_source65_GEN_rows_unchanged')
   q("DO $null_union$DECLARE x public.union_pnl_cash_outcome_link_resolutions;BEGIN SELECT*INTO x FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 1;x.table_id:=md5('null-union-table')::uuid;x.hand_id:=md5('null-union-hand')::uuid;x.hand_number:=99997;x.game_scope:=x.game_scope||jsonb_build_object('game_union_id',NULL);x.evidence:=x.evidence||jsonb_build_object('game_scope',x.game_scope);x.proof:=x.proof||jsonb_build_object('table_id',x.table_id,'hand_id',x.hand_id,'hand_number',x.hand_number,'game_scope',x.game_scope,'evidence',x.evidence);x.proof_md5:=md5(x.proof::text);INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT(x).*;END$null_union$;");assert q("SELECT count(*)FROM public.fn_union_pnl_linked_cash_outcomes(NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z')")=='0';assert q("SELECT md5(to_jsonb(r)::text)FROM public.union_pnl_cash_outcome_link_resolutions r WHERE hand_id=md5('hand100')::uuid")==point_source;cases.append('NULL_union_key_valid_row_preserved_and_original_strict_null_parameter_empty')
   for label,setup,error in [('operator',"SET LOCAL request.jwt.claims='{}';",'operator_refused'),('override',"SET LOCAL ca.break_window_migration_override='forbidden';",'operator_refused'),('source65',"SET LOCAL fixture.source65='false';",'source65_required'),('generation',"SET LOCAL fixture.gen_null='true';",'generation_required'),('freeze',"SET LOCAL fixture.frozen='true';",'window_refused'),('break',"SET LOCAL fixture.break='break';",'window_refused'),('boundary',"SET LOCAL fixture.boundary='boundary';",'window_refused'),('ACL',"GRANT INSERT ON public.union_pnl_cash_outcomes TO service_role;",'original_tables_required'),('new_invalid',"UPDATE pg_index SET indisvalid=false WHERE indexrelid='public.union_pnl_cash_links_valid_union_hash'::regclass;",'original_tables_required'),('shape',"DROP INDEX public.union_pnl_cash_links_valid_union_hash;CREATE INDEX union_pnl_cash_links_valid_union_hash ON public.union_pnl_cash_outcome_link_resolutions(hand_id);",'exact_catalog_required')]:
    q(body.replace('BEGIN;','BEGIN;'+setup,1),'cash_link_proof_index_'+error);q(body);cases.append('installer_'+label+'_refusal_atomic_rollback')
   for sql,error in [("UPDATE public.union_pnl_cash_outcome_link_resolutions SET proof_md5='invalid'WHERE hand_number=100",'violates check constraint'),("UPDATE public.union_pnl_cash_outcome_link_resolutions SET proof=NULL WHERE hand_number=100",'not-null constraint'),("UPDATE public.union_pnl_cash_outcome_link_resolutions SET hand_id=NULL WHERE hand_number=100",'not-null constraint'),('INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT*FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 1','duplicate key')]:q(sql,error);cases.append('actual_original_constraint_refusal_'+str(len(cases)))
   q('SET ROLE anon;SELECT*FROM public.union_pnl_cash_outcome_link_resolutions','permission denied');cases.append('original_anon_ACL_refusal')
   point="SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions WHERE proof_md5=md5(proof::text)"
   reader=subprocess.Popen(list(map(str,[pg/'psql','-XAtq','-v','ON_ERROR_STOP=1'])),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
   try:
    reader.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'+point+';\n');reader.stdin.flush();first=reader.stdout.readline().strip();assert first.isdigit()
    q("DO $write$DECLARE x public.union_pnl_cash_outcome_link_resolutions;BEGIN SELECT*INTO x FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 1;x.table_id:=md5('snapshot-table')::uuid;x.hand_id:=md5('snapshot-hand')::uuid;x.hand_number:=99998;x.proof:=x.proof||jsonb_build_object('table_id',x.table_id,'hand_id',x.hand_id,'hand_number',x.hand_number);x.proof_md5:=md5(x.proof::text);INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT(x).*;END$write$;")
    reader.stdin.write(point+';ROLLBACK;\n');reader.stdin.close();second=reader.stdout.readline().strip();reader.wait(timeout=10);assert reader.returncode==0 and first==second and int(q(point))==int(first)+1;cases.append('real_two_backend_RR_snapshot_index_maintained_valid_write')
   finally:
    if reader.poll()is None:reader.kill();reader.wait()
   result={'qualification':'passed','cases':cases,'case_count':len(cases),'candidate_sha256':hashlib.sha256(M.read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'plans':plans,'build_cost':build_cost,'native_oid_mapping':{'only_delta':'two actual fixture index OID constants','production_failed_oid':'275975891','production_retired_oid':'271236984','fixture_observed_oid':observed,'fixture_retired_oid':retire_observed},'limits':(FX/'README.md').read_text()};a.out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='plans'}))
  finally:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],capture_output=True)
if __name__=='__main__':main()
