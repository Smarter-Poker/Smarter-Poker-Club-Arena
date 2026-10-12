from pathlib import Path
import subprocess,json,os
P=Path(__file__).parent
OUT=Path(os.environ['PROBE_OUT'])
PSQL=[str(Path(os.environ['PGBIN'])/'psql'),'-X','-h',os.environ['PROBE_SOCKET'],'-p',os.environ['PROBE_PORT'],'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At']
def sql(s,ok=True):
 r=subprocess.run(PSQL,input=s,text=True,capture_output=True)
 if ok and r.returncode: raise RuntimeError(r.stderr)
 return r
def scalar(s): return sql(s).stdout.strip().splitlines()[-1]
def log(s): print(s,flush=True)
schema='''
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE union_pnl_inventory_capture(singleton boolean,captured_at timestamptz);
CREATE TABLE union_pnl_inventory_checkpoints(boundary timestamptz PRIMARY KEY,base_boundary timestamptz,max_event_id bigint,row_count bigint,issue_count bigint,rows_md5 text,issues_md5 text,result_md5 text,legacy_verified boolean,seal_ms bigint);
CREATE TABLE union_pnl_inventory_checkpoint_rows(boundary timestamptz,source_name text,row_id uuid,latest_event_id bigint,first_operation text,after_row jsonb,PRIMARY KEY(boundary,source_name,row_id));
CREATE TABLE union_pnl_inventory_checkpoint_issues(boundary timestamptz,source_name text,row_id uuid,event_id bigint,PRIMARY KEY(boundary,source_name,row_id,event_id));
CREATE UNLOGGED TABLE union_pnl_inventory_seal_layers(boundary timestamptz,layer_end timestamptz,layer_start timestamptz,base_boundary timestamptz,row_count bigint,issue_count bigint,layer_ms bigint,PRIMARY KEY(boundary,layer_end));
CREATE UNLOGGED TABLE union_pnl_inventory_seal_layer_rows(boundary timestamptz,source_name text,row_id uuid,layer_end timestamptz,latest_event_id bigint,first_operation text,after_row jsonb,PRIMARY KEY(boundary,source_name,row_id,layer_end));
CREATE UNLOGGED TABLE union_pnl_inventory_seal_layer_issues(boundary timestamptz,source_name text,row_id uuid,layer_end timestamptz,event_id bigint,PRIMARY KEY(boundary,source_name,row_id,layer_end,event_id));
CREATE TABLE fixture_rows(i int PRIMARY KEY,source_name text,row_id uuid);
INSERT INTO fixture_rows SELECT i,('source_'||(i%5))::text,md5(i::text)::uuid FROM generate_series(1,34002)i;
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' +interval '7 hours'$$;
CREATE FUNCTION fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'no-base branch outside this finite harness'; END$$;
CREATE FUNCTION fn_union_pnl_inventory_population(timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('issues',COALESCE((SELECT jsonb_agg(jsonb_build_object('source',source_name,'row',row_id,'event',event_id) ORDER BY source_name,row_id,event_id) FROM union_pnl_inventory_checkpoint_issues WHERE boundary=$1),'[]'::jsonb),'rows',(SELECT count(*) FROM union_pnl_inventory_checkpoint_rows WHERE boundary=$1))$$;
CREATE FUNCTION fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) RETURNS TABLE(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) LANGUAGE sql AS $$
SELECT 'row',source_name,row_id,100000+i+extract(epoch FROM $4-$1)::bigint,'UPDATE',CASE WHEN i%17=0 THEN NULL ELSE jsonb_build_object('i',i,'layer',$4) END FROM fixture_rows WHERE i%4=0 AND $4<=$1+interval '18 hours'
UNION ALL SELECT 'issue',source_name,row_id,200000+i+extract(epoch FROM $4-$1)::bigint,NULL,NULL FROM fixture_rows WHERE i%68=0 AND $4<=$1+interval '18 hours'
$$;
'''
sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS anon; DROP ROLE IF EXISTS authenticated; DROP ROLE IF EXISTS service_role;')
sql(schema)
pre=(P/'preimage.sql').read_text();mig=Path(os.environ['PROBE_MIGRATION']).read_text()
sql(pre)
log('preimage_md5='+scalar("SELECT md5(pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))"))
assert scalar("SELECT md5(pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))")=='6deca79658f44ffb149316167441b2bf'
reset='''TRUNCATE union_pnl_inventory_capture,union_pnl_inventory_checkpoints,union_pnl_inventory_checkpoint_rows,union_pnl_inventory_checkpoint_issues,union_pnl_inventory_seal_layers,union_pnl_inventory_seal_layer_rows,union_pnl_inventory_seal_layer_issues;
INSERT INTO union_pnl_inventory_capture VALUES(true,'2026-09-28 08:00+00');
INSERT INTO union_pnl_inventory_checkpoints(boundary,row_count) VALUES('2026-10-05 07:00+00',34002);
INSERT INTO union_pnl_inventory_checkpoint_rows SELECT '2026-10-05 07:00+00',source_name,row_id,i,'INSERT',CASE WHEN i%19=0 THEN NULL ELSE jsonb_build_object('i',i,'base',true) END FROM fixture_rows;
INSERT INTO union_pnl_inventory_checkpoint_issues SELECT '2026-10-05 07:00+00',source_name,row_id,50000+i FROM fixture_rows WHERE i%31=0;
'''
call="SELECT fn_union_pnl_inventory_seal_advance('2026-10-12 07:00+00',false)"
digest="""SELECT jsonb_build_object('checkpoint',(SELECT to_jsonb(c)-'seal_ms' FROM union_pnl_inventory_checkpoints c WHERE boundary='2026-10-12 07:00+00'),'rows',(SELECT md5(string_agg(row_to_json(r)::text,E'\\n' ORDER BY source_name,row_id)) FROM union_pnl_inventory_checkpoint_rows r WHERE boundary='2026-10-12 07:00+00'),'issues',(SELECT md5(string_agg(row_to_json(r)::text,E'\\n' ORDER BY source_name,row_id,event_id)) FROM union_pnl_inventory_checkpoint_issues r WHERE boundary='2026-10-12 07:00+00'))"""
sql(reset);log('old_result='+scalar(call));old=scalar(digest);(OUT/'old-digest.json').write_text(old)
# Fresh bootstrap state for installation, including no mid-seal layers.
sql(reset);sql(mig)
assert scalar("SELECT md5(pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))")=='47b1a3a80eec9fc6a593e99ebef27c27'
log('exact_postimage_md5=47b1a3a80eec9fc6a593e99ebef27c27')
log('new_result='+scalar(call));new=scalar(digest);(OUT/'new-digest.json').write_text(new)
log('exact_old_new_equal='+str(json.loads(old)==json.loads(new)))
assert json.loads(old)==json.loads(new),'old/new digest mismatch'
verify=scalar("SELECT fn_union_pnl_inventory_seal_advance('2026-10-12 07:00+00',true)");log('verify='+verify);assert json.loads(verify)['status']=='verified'
log('already='+scalar(call));assert json.loads(scalar(call))['status']=='already_sealed'
replay=sql(mig,False);log('replay_refused='+str(replay.returncode!=0)+' '+replay.stderr.strip());assert replay.returncode!=0
# Diagnostic row threshold only is lowered: exact full code above was qualified separately.
post=scalar("SELECT pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure)") if False else sql("SELECT pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure)").stdout.strip()
assert post.count('n_tick>=400000')==1
diag=post.replace('n_tick>=400000','n_tick>=3000');(OUT/'diagnostic-3000.sql').write_text(diag);sql(diag)
sql(reset);sql('TRUNCATE union_pnl_inventory_seal_buckets')
for n in range(1,30):
 result=json.loads(scalar(call));log('diagnostic_call_'+str(n)+'='+json.dumps(result,sort_keys=True))
 if result['status']=='sealed':break
 # Partial checkpoint must remain absent to ordinary consumers.
 assert scalar("SELECT count(*) FROM union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00+00'")=='0'
else:raise AssertionError('not sealed within29 calls')
multi=scalar(digest);assert json.loads(old)==json.loads(multi);log('diagnostic_multicall_equal=True calls='+str(n));(OUT/'multi-digest.json').write_text(multi)
# Simulate unlogged staging loss after committed partial buckets. The source owner
# must discard partial permanent rows and rebuild them; no duplicate final row.
sql(reset);sql('TRUNCATE union_pnl_inventory_seal_buckets')
assert json.loads(scalar(call))['status']=='sealing'
assert int(scalar("SELECT count(*) FROM union_pnl_inventory_checkpoint_rows WHERE boundary='2026-10-12 07:00+00'"))>0
sql('TRUNCATE union_pnl_inventory_seal_layers,union_pnl_inventory_seal_layer_rows,union_pnl_inventory_seal_layer_issues,union_pnl_inventory_seal_buckets')
for j in range(30):
 if json.loads(scalar(call))['status']=='sealed':break
else:raise AssertionError('restart did not finish')
assert json.loads(scalar(digest))==json.loads(old);log('lost_unlogged_staging_restart_equal=True')
# All NULL images: untouched base and every latest touched image are still rows.
sql('ALTER FUNCTION fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) RENAME TO layer_fixture_with_images')
sql('''CREATE FUNCTION fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) RETURNS TABLE(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) LANGUAGE sql AS $$SELECT o_kind,o_source_name,o_row_id,o_event_id,o_first_operation,NULL::jsonb FROM layer_fixture_with_images($1,$2,$3,$4)$$''')
sql(pre);sql(reset);sql('UPDATE union_pnl_inventory_checkpoint_rows SET after_row=NULL');scalar(call);nullold=scalar(digest)
sql(reset);sql('UPDATE union_pnl_inventory_checkpoint_rows SET after_row=NULL');sql('DROP TABLE union_pnl_inventory_seal_buckets');sql(mig);scalar(call)
assert json.loads(nullold)==json.loads(scalar(digest));assert scalar("SELECT count(*) FROM union_pnl_inventory_checkpoint_rows WHERE boundary='2026-10-12 07:00+00' AND after_row IS NOT NULL")=='0';log('all_NULL_images_old_new_equal=True rows=34002')
# Installation mid-seal must roll back even CREATE TABLE preceding its guard.
sql(pre);sql(reset);sql('DROP TABLE union_pnl_inventory_seal_buckets')
sql("INSERT INTO union_pnl_inventory_seal_layers(boundary,layer_end,base_boundary) VALUES('2026-10-12 07:00+00','2026-10-05 13:00+00','2026-10-05 07:00+00')")
refused=sql(mig,False);assert refused.returncode!=0 and 'an inventory seal is in progress' in refused.stderr
assert scalar("SELECT to_regclass('union_pnl_inventory_seal_buckets') IS NULL")=='t'
assert scalar("SELECT md5(pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))")=='6deca79658f44ffb149316167441b2bf';log('mid_seal_install_refused_atomic_rollback=True')
sql(reset)
trial=mig.replace('\nCOMMIT;','\nROLLBACK;');sql(trial)
assert scalar("SELECT to_regclass('union_pnl_inventory_seal_buckets') IS NULL")=='t'
assert scalar("SELECT md5(pg_get_functiondef('fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))")=='6deca79658f44ffb149316167441b2bf';log('rolled_back_trial_preserves_preimage=True')
sql(mig)
for bad,expected in [("SELECT fn_union_pnl_inventory_seal_advance(NULL,false)",'closed_original_week_boundary_required'),("BEGIN ISOLATION LEVEL REPEATABLE READ; "+call,'inventory_requires_fresh_read_committed_snapshot')]:
 r=sql(bad,False);assert r.returncode and expected in r.stderr
log('invalid_boundary_and_wrong_isolation_refused=True')
# An existing transaction holding the exact advisory key serializes the caller.
holder=subprocess.Popen(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0)); SELECT 'held'; SELECT pg_sleep(2); COMMIT;\n");holder.stdin.close()
while True:
 line=holder.stdout.readline()
 if line.strip()=='held':break
 if not line:raise AssertionError('concurrent lock holder exited before admission')
blocked=sql("SET statement_timeout='300ms'; "+call,False)
assert blocked.returncode and 'statement timeout' in blocked.stderr
holder.wait();assert holder.returncode==0;log('same_week_concurrent_advisory_admission_serializes=True')
log('PASS exact native equivalence;verify;duplicate;replay;multicall;NULLimages;stagingrestart;midseal refusal;rollback trial')
