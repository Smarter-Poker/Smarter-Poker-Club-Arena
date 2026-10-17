#!/usr/bin/env python3
"""Exact candidate index/access-path qualification on disposable PostgreSQL 17.
No production connection. All cluster, socket and transient files use --scratch.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path


def main():
    default_root=Path(__file__).resolve().parents[2]
    if not(default_root/'scripts/ci/migration-concurrent-preamble.mjs').is_file():default_root=Path.cwd()
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--migrationfile','--migration',dest='migrationfile',type=Path,
        default=default_root/'supabase/migrations/20261017083951_weekly_bank_receipts_read_their_exact_correlation_legs.sql')
    ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')))
    ap.add_argument('--scratch',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    a=ap.parse_args()
    if not __debug__:raise ValueError('optimized qualification forbidden')
    migration=a.migrationfile.resolve();candidate=migration.read_bytes()
    repo=migration.parents[2];parser=repo/'scripts/ci/migration-concurrent-preamble.mjs'
    assert a.scratch.is_dir(),'provided scratch directory must already exist'
    assert not a.output.exists(),'new qualification output only'
    a.output.parent.mkdir(parents=True,exist_ok=True)
    root=Path(tempfile.mkdtemp(prefix='cidx-',dir=a.scratch.resolve()))
    if len(str(root).encode())>=85:
        shutil.rmtree(root)
        raise ValueError('provide a shorter SSD scratch path for native UNIX socket')
    data=root/'d';log=root/'server.log';started=False;commands=[];cases=[]
    env={**os.environ,'TMPDIR':str(root),'TEMP':str(root),'TMP':str(root)}
    # No inherited production endpoint is used: all psql calls specify own socket/db/user.
    psql=[a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']

    def run(args,sql=None,error=None):
        result=subprocess.run([str(x)for x in args],input=sql,text=True,capture_output=True,env=env,timeout=120)
        commands.append({'command':str(args[0]),'returncode':result.returncode})
        if error:
            assert result.returncode and error in result.stderr,result.stdout+result.stderr
        else:assert result.returncode==0,result.stdout+result.stderr
        return result.stdout.strip()

    def q(sql,error=None):return run(psql,sql,error)
    def record(name):cases.append(name)
    def nodes(n):
        yield n
        for child in n.get('Plans',[]):yield from nodes(child)
    def fingerprint():
        return q("""SELECT jsonb_build_object('rows',(SELECT md5(string_agg(md5(to_jsonb(l)::text),''ORDER BY id))FROM public.chip_ledger l),
         'table',(SELECT jsonb_build_array(relowner,relacl,relrowsecurity,relforcerowsecurity,reloptions)FROM pg_class WHERE oid='public.chip_ledger'::regclass),
         'functions',(SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid,p.prosrc,p.proowner,p.proacl,p.prosecdef,p.proconfig)ORDER BY p.oid),'[]'::jsonb)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private')))""")

    try:
        # Invoke the SAME parser as the maintained installer, by absolute module URL.
        js="import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const{splitConcurrentPreamble}=await import(pathToFileURL(process.argv[2]));process.stdout.write(JSON.stringify(splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'))));"
        shape=json.loads(run(['node','--input-type=module','-e',js,migration,parser]))
        assert shape['ok']and len(shape['indexes'])==1,shape
        ix=shape['indexes'][0]
        assert ix['schema']=='public'and ix['table']=='chip_ledger'and ix['name']=='idx_chip_ledger_correlation_id',ix
        record('maintained_concurrent_preamble_parser_exact_candidate')
        assert ' 17.'in run([a.pg_bin/'postgres','--version'])
        run([a.pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
        with(data/'postgresql.conf').open('a')as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root).replace("'","''")+"'\nshared_buffers='16MB'\nwork_mem='4MB'\nmaintenance_work_mem='16MB'\nallow_system_table_mods=on\n")
        run([a.pg_bin/'pg_ctl','-D',data,'-l',log,'-w','start']);started=True
        q("""CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY,correlation_id uuid,category text,scope_id uuid,amount numeric(20,2),payload text,created_at timestamptz NOT NULL);
         INSERT INTO public.chip_ledger SELECT md5('filler-'||g)::uuid,CASE WHEN g%5=0 THEN NULL ELSE md5('corr-'||g)::uuid END,
          CASE WHEN g%3=0 THEN 'club_bank_claim'ELSE'other'END,md5('scope-'||(g%7))::uuid,g::numeric/100,repeat(md5('payload-'||g),32),'2026-10-17 00:00Z'::timestamptz FROM generate_series(1,20000)g;
         INSERT INTO public.chip_ledger SELECT md5('target-'||g)::uuid,
          CASE WHEN g<=5 THEN '11111111-1111-1111-1111-111111111111'::uuid ELSE '22222222-2222-2222-2222-222222222222'::uuid END,
          CASE WHEN g%2=0 THEN 'club_bank_claim'ELSE'unrelated_category'END,md5('other-scope-'||(g%2))::uuid,12.34,repeat('all-full-fields-preserved-',48),'2026-10-17 00:00Z'::timestamptz FROM generate_series(1,8)g;
         ANALYZE public.chip_ledger;""")
        before_state=fingerprint()
        op_a='11111111-1111-1111-1111-111111111111';op_b='22222222-2222-2222-2222-222222222222'
        missing='33333333-3333-3333-3333-333333333333'
        cohorts=[[],[op_a],[op_b],[op_a,op_b,op_a],[None],[op_a,None,missing]]

        def query(values):
            literal='ARRAY['+','.join('NULL::uuid'if x is None else"'"+x+"'::uuid"for x in values)+']::uuid[]'
            return "WITH requested AS MATERIALIZED(SELECT operation_id,ord FROM unnest("+literal+")WITH ORDINALITY x(operation_id,ord)), op_ids AS MATERIALIZED(SELECT coalesce(array_agg(DISTINCT operation_id),ARRAY[]::uuid[])ids FROM requested), matching_legs AS MATERIALIZED(SELECT l.* FROM op_ids operation_set CROSS JOIN LATERAL(SELECT receipt_leg.* FROM public.chip_ledger receipt_leg WHERE cardinality(operation_set.ids)>0 AND receipt_leg.correlation_id=ANY(operation_set.ids) OFFSET 0)l) SELECT coalesce(jsonb_agg(jsonb_build_object('request_no',r.ord,'row',to_jsonb(l))ORDER BY r.ord,l.id),'[]'::jsonb)FROM requested r JOIN matching_legs l ON l.correlation_id=r.operation_id"

        def oracle(values):
            return sorted((i+1,hashlib.md5(('target-'+str(g)).encode()).hexdigest())for i,op in enumerate(values)for g in range(1,9)if op==(op_a if g<=5 else op_b))

        before=[]
        for values in cohorts:
            rows=json.loads(q(query(values)))
            actual=sorted((x['request_no'],x['row']['id'].replace('-',''))for x in rows)
            assert actual==oracle(values),(values,actual,oracle(values))
            before.append(rows)
        record('independent_all_rows_null_empty_multi_leg_duplicate_request_oracle_before')
        plan_query=query([op_a,op_b])
        old_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+plan_query))[0]
        assert any(n.get('Node Type')=='Seq Scan'and n.get('Relation Name')=='chip_ledger'for n in nodes(old_plan['Plan'])),old_plan
        assert not any(n.get('Index Name')==ix['name']for n in nodes(old_plan['Plan']))
        record('before_fails_required_narrow_access_no_correlation_index')
        # This exact statement is sent ALONE, outside a transaction, as production does.
        q(ix['statement']);q(shape['body'])
        predicate=q("SELECT pg_get_expr(indpred,indrelid)FROM pg_index WHERE indexrelid='public.idx_chip_ledger_correlation_id'::regclass")
        assert predicate=='(correlation_id IS NOT NULL)',predicate
        record('actual_concurrent_candidate_and_exact_guard_body_pass')
        record('actual_pg17_predicate_postimage_captured')
        after=[]
        for values,old_rows in zip(cohorts,before):
            rows=json.loads(q(query(values)));assert rows==old_rows,(values,rows,old_rows);after.append(rows)
        assert fingerprint()==before_state,'index/body changed rows, table security or public/private function authority'
        record('whole_full_rowsets_duplicate_multiplicity_and_authority_unchanged')
        new_plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+plan_query))[0]
        index_nodes=[n for n in nodes(new_plan['Plan'])if n.get('Index Name')==ix['name']]
        assert index_nodes and all('correlation_id'in n.get('Index Cond','')for n in index_nodes),new_plan
        old_blocks=old_plan['Plan'].get('Shared Hit Blocks',0)+old_plan['Plan'].get('Shared Read Blocks',0)
        new_blocks=new_plan['Plan'].get('Shared Hit Blocks',0)+new_plan['Plan'].get('Shared Read Blocks',0)
        assert old_blocks>new_blocks,(old_blocks,new_blocks)
        record('actual_narrow_index_plan_and_fewer_shared_blocks')
        q(shape['body']);record('guard_body_metadata_replay_is_idempotent_not_installer_replay')
        # Wrong shape and catalog flags are changed ONLY inside this disposable fixture.
        for label,ddl in[
            ('wrong_key',"CREATE INDEX idx_chip_ledger_correlation_id ON public.chip_ledger(id)WHERE correlation_id IS NOT NULL;"),
            ('wrong_predicate',"CREATE INDEX idx_chip_ledger_correlation_id ON public.chip_ledger(correlation_id)WHERE correlation_id IS NULL;")]:
            q('DROP INDEX public.idx_chip_ledger_correlation_id;'+ddl)
            q(shape['body'],'weekly_bank_correlation_index_shape_changed');record(label+'_guard_refused')
            q('DROP INDEX public.idx_chip_ledger_correlation_id;');q(ix['statement']);q(shape['body'])
        for flag,value in[('indisunique','true'),('indisvalid','false'),('indisready','false'),('indislive','false')]:
            prior=q("SELECT "+flag+" FROM pg_index WHERE indexrelid='public.idx_chip_ledger_correlation_id'::regclass")
            try:
                q("UPDATE pg_index SET "+flag+'='+value+" WHERE indexrelid='public.idx_chip_ledger_correlation_id'::regclass")
                q(shape['body'],'weekly_bank_correlation_index_shape_changed');record(flag+'_guard_refused')
            finally:q("UPDATE pg_index SET "+flag+'='+('true'if prior=='t'else'false')+" WHERE indexrelid='public.idx_chip_ledger_correlation_id'::regclass")
        q('DROP INDEX public.idx_chip_ledger_correlation_id;');q(shape['body'],'weekly_bank_correlation_index_missing');record('missing_index_guard_refused')
        q(ix['statement']);q(shape['body'])
        assert fingerprint()==before_state
        result={'qualification':'passed','migrationfile':str(migration),'migration_bytes':len(candidate),'migration_sha256':hashlib.sha256(candidate).hexdigest(),
            'maintained_parser_sha256':hashlib.sha256(parser.read_bytes()).hexdigest(),'cases':cases,'case_count':len(cases),
            'fixture_rows':20008,'actual_predicate':predicate,'before_shared_blocks':old_blocks,'after_shared_blocks':new_blocks,
            'before_plan':old_plan,'after_plan':new_plan,'unchanged_whole_row_oracle':True,'actual_concurrent_statement_executed':True,
            'catalog_flag_changes_disposable_only':True,'production_or_full_week_financial_qualification':False,
            'installer_tls_history_window_source40_generation_live_boundaries':'Not simulated or certified by this index/access-path fixture; maintained installer and actual production readback own these controls.'}
        a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    except BaseException:
        if log.exists():a.output.with_suffix(a.output.suffix+'.server.log').write_bytes(log.read_bytes())
        raise
    finally:
        try:
            if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','fast','-w','stop'])
        finally:shutil.rmtree(root)


if __name__=='__main__':main()
