#!/usr/bin/env python3
"""Isolated PG17 unchanged linked-query partial-index/source-contract qualification."""
from pathlib import Path
import argparse,subprocess,tempfile,os,json,hashlib,socket
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
   statement=parts['indexes'][0]['statement'];body=parts['body'];fixture=(FX/'native-fixture.sql').read_text().replace('-- INSTALL_EXACT_CCI_AND_BODY',statement+';\n'+body);out=q(fixture);a.out.with_suffix('.log').write_text(out)
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
    ns=list(nodes(plan['Plan']));assert any(n.get('Index Name')=='union_pnl_cash_links_valid_union_hash'for n in ns);assert not any(n.get('Node Type')=='Seq Scan'and n.get('Relation Name')=='union_pnl_cash_outcome_link_resolutions'for n in ns)
   cases+=['original_all4field_60rows_fullbag_unchanged','natural_custom_and_GENERIC_PLAN_union_hash_index_selected','6000_actual_constraints_large_JSON_sources_retained','valid_16KB_payload_and_foreign_union_text_accepted_hash_index']
   seal=q("SELECT jsonb_build_array(md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure)),smarter_private.original_inventory_proof_sources_match(),smarter_private.original_inventory_basis_generation(),(SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions))")
   q(statement+';');q(body);assert q("SELECT jsonb_build_array(md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure)),smarter_private.original_inventory_proof_sources_match(),smarter_private.original_inventory_basis_generation(),(SELECT count(*)FROM public.union_pnl_cash_outcome_link_resolutions))")==seal;cases.append('exact_CCI_replay_catalog_source65_GEN_rows_unchanged')
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
   result={'qualification':'passed','cases':cases,'case_count':len(cases),'candidate_sha256':hashlib.sha256(M.read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'plans':plans,'limits':(FX/'README.md').read_text()};a.out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='plans'}))
  finally:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],capture_output=True)
if __name__=='__main__':main()
