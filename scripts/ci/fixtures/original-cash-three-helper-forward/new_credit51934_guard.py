"""Native exact protected51934 dependency predicates. No producer is called."""
import json,re,hashlib,copy

def run(must,call,F,s):
    b=json.loads((F/'credit51934-provenance.json').read_text());protected=(F/'credit51934-protected-source.sql').read_text();assert hashlib.sha256(protected.encode()).hexdigest()==b['protected_source_sha256']=='6fddc6234e646ced9164a0ca8ddd9f8bd2bec19ebc6d2b629816d3c995dd671c'
    actual=b['actual_process'];assert actual['md5']==hashlib.md5(actual['definition'].encode()).hexdigest()=='a68500342f07e0608c6eb69f4cb0739e'
    m=re.search(r'CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting_scope\(p_union_id uuid, p_club_id uuid\).*?AS (\$\w*\$)',protected,re.S);tag=m.group(1);z=protected.index(tag,m.end())+len(tag);assert protected[m.start():z]+'\n'==actual['definition']
    old=json.loads((F/'expected27.json').read_text());oldrow=next(r for r in old['before']if r['metadata']['proname']=='fn_process_weekly_accounting_scope');assert oldrow['definition'].count('a.credit_used>0')==2 and oldrow['definition'].replace('a.credit_used>0','a.credit_limit>0')==actual['definition'];assert {k:v for k,v in oldrow['metadata'].items()if k!='prosrc'}=={k:v for k,v in actual['metadata'].items()if k!='prosrc'}
    # Every operative reader array must exactly match its current 27-owner binding.
    reader_process_rows=[]
    for phase,baseline in [('pre','before'),('post','after')]:
        expected=copy.deepcopy(old[baseline]);row=next(r for r in expected if r['signature']==actual['signature']);row.update({k:v for k,v in actual.items()if k!='md5'})
        reader=(F/(phase+'-NEWFORWARD54822-READONLY15-ROLLBACK60.sql')).read_text();arrays=[json.loads(v)for v in re.findall(r'\$expected27\$(.*?)\$expected27\$',reader,re.S)]
        assert len(arrays)==3 and all(rows==expected for rows in arrays),'operative reader expected27 differs from qualified current strict binding:'+phase
        stale=copy.deepcopy(arrays[0]);stale[next(i for i,r in enumerate(stale)if r['signature']==actual['signature'])]=copy.deepcopy(oldrow);assert stale!=expected,'stale aa771 reader regression must refuse'
        reader_process_rows.extend(next(r for r in rows if r['signature']==actual['signature'])for rows in arrays)
    lit=lambda x:"'"+x.replace("'","''")+"'";columns=b['agent_columns'];assert len(columns)==31 and columns[-1]['position']==32
    parts=[];j=0
    for position in range(1,33):
        if j<len(columns)and columns[j]['position']==position:
            c=columns[j];j+=1;parts.append('"'+c['name']+'" '+c['type']+(' NOT NULL'if c['not_null']else''))
        else:parts.append('__native_dropped_'+str(position)+' text')
    must('ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN name text,ADD COLUMN statements text[],ADD COLUMN rollback jsonb,ADD COLUMN created_by text,ADD COLUMN idempotency_key text;CREATE TABLE public.agents('+','.join(parts)+');ALTER TABLE public.agents DROP COLUMN __native_dropped_27;INSERT INTO supabase_migrations.schema_migrations VALUES(\'20261030051934\',\'credit_line_tracks_funded_agent_chips_and_weekly_wallet_topu\',ARRAY['+lit(protected)+'],NULL,NULL,NULL);')
    guards=re.findall(r'DO \$credit51934_existing_protected_authority\$.*?END\$credit51934_existing_protected_authority\$;',s,re.S);assert len(guards)==2 and guards[0]==guards[1];guard=guards[0];results=[]
    must('BEGIN READ ONLY;'+guard+'ROLLBACK;');results.append('exact_protected51934_history_and_two_relevant_credit_columns_READONLY_positive')
    for label,fault,reason in [('history_missing',"DELETE FROM supabase_migrations.schema_migrations;",'exact_protected_credit51934_history_required'),('history_wrong_bytes',"UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'];",'exact_protected_credit51934_history_required'),('history_extra_metadata',"UPDATE supabase_migrations.schema_migrations SET created_by='unexpected';",'exact_protected_credit51934_history_required'),('legacy_credit_used_removed','ALTER TABLE public.agents DROP COLUMN credit_used;','credit51934_agent_column_contract_changed'),('credit_limit_type_changed','ALTER TABLE public.agents ALTER COLUMN credit_limit TYPE numeric(18,2);','credit51934_agent_column_contract_changed'),('credit_used_nullable','ALTER TABLE public.agents ALTER COLUMN credit_used DROP NOT NULL;','credit51934_agent_column_contract_changed')]:
        r=call('BEGIN;'+fault+guard+'ROLLBACK;');assert r.returncode and reason in r.stdout,(label,r.stdout[-1500:]);must('BEGIN READ ONLY;'+guard+'ROLLBACK;');results.append(label+'_refused')
    # Native OIDs adapted ONLY; actual full canonical body, ACL and allother metadata retained.
    metadata=json.loads(must("SELECT to_jsonb(p)FROM pg_proc p WHERE oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;").stdout);metadata['prosrc']=actual['metadata']['prosrc'];payload=json.dumps(metadata,separators=(',',':'))
    predicate="DO $native_process$DECLARE p pg_proc;BEGIN SELECT*INTO STRICT p FROM pg_proc WHERE oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;IF md5(pg_get_functiondef(p.oid))<>'a68500342f07e0608c6eb69f4cb0739e'OR to_jsonb(p)IS DISTINCT FROM "+lit(payload)+"::jsonb THEN RAISE EXCEPTION 'native_exact_credit51934_process_authority_required';END IF;END$native_process$;"
    for row in reader_process_rows:
        assert row['definition']==actual['definition']and row['metadata']==actual['metadata'];must('BEGIN;SET LOCAL check_function_bodies=off;'+row['definition']+';'+predicate+'ROLLBACK;')
    results.append('all_six_current_reader_arrays_exact27_binding_and_native_a685_authority_positive');results.append('stale_aa771_reader_array_regression_refused')
    for label,setup in [('legacy_aa771_not_accepted',''),('new_authority_ACL_drift',actual['definition']+';GRANT EXECUTE ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid)TO PUBLIC;')]:
        r=call('BEGIN;SET LOCAL check_function_bodies=off;'+setup+predicate+'ROLLBACK;');assert r.returncode and'native_exact_credit51934_process_authority_required'in r.stdout,(label,r.stdout[-1500:]);results.append(label+'_refused')
    return {'passed':True,'source_only_native_dependency_controls':True,'synthetic_history_and_native_OIDs_explicit_NOT_actual_install_proof':True,'all_protected51934_source_bytes_qualified':True,'actual_two_line_delta_only':True,'all_nonprosrc_metadata_same':True,'case_count':len(results),'cases':results,'business_functions_NOT_invoked':True}
