#!/usr/bin/env python3
"""Finite native PG17 proof for bounded inventory seal publication; SSD scratch only."""
import json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path
root=Path(__file__).resolve().parents[2]
fx=root/'tests/fixtures/inventory-seal-committed-pages'
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
scratch=Path(os.environ['INVENTORY_SEAL_SCRATCH'])
scratch.mkdir(parents=True,exist_ok=True)
work=Path(tempfile.mkdtemp(prefix='native-',dir=scratch))
sock=work/'s';sock.mkdir()
port='55742'
env=dict(os.environ,LC_ALL='C',LANG='C',PGTZ='UTC')
started=False
rows=int(os.environ.get('INVENTORY_SEAL_ROWS','60000'))
database='postgres'
if not 1<=rows<=3400000:raise SystemExit('Finite fixture accepts1..3400000 rows')
def storage_guard():
 if shutil.disk_usage(scratch).free<8*1024**3:raise RuntimeError('Native qualification stops with less than8GiB free; no internal fallback')
storage_guard()
def command(args):
 r=subprocess.run(args,capture_output=True,text=True,env=env)
 if r.returncode:raise RuntimeError(r.stderr[-6000:])
 return r.stdout
def sql(q='',files=(),ok=True):
 args=[str(pg/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(sock),'-p',port,'-U','postgres',database,'-c','SET check_function_bodies=off;']
 for f in files:args+=['-f',str(f)]
 if q:args+=['-f','-']
 r=subprocess.run(args,input=q,capture_output=True,text=True,env=env)
 if ok and r.returncode:raise RuntimeError(r.stderr[:2000]+'\n'+r.stderr[-500:])
 return r
def start():
 command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-l',str(work/'server.log'),'-w','start','-o',f"-k {sock} -p {port} -h '' -c shared_buffers=128MB -c work_mem=64MB -c max_parallel_workers_per_gather=0"])
def seed(n):
 storage_guard()
 sql(f"""
 INSERT INTO public.union_pnl_inventory_capture VALUES(true,'2026-09-27 07:00Z',1,'{{}}');
 INSERT INTO public.union_pnl_inventory_checkpoints VALUES('2026-10-05 07:00Z',NULL,{n},{n},1,repeat('0',32),repeat('0',32),repeat('0',32),false,0,'fixture',now());
 INSERT INTO public.union_pnl_inventory_checkpoint_rows
 SELECT '2026-10-05 07:00Z','fixture',md5(g::text)::uuid,g,'baseline',
 jsonb_build_object('id',md5(g::text),'tournament_id',null,'value',g,'padding',repeat('x',350))
 FROM generate_series(1,{n}) g;
 INSERT INTO public.union_pnl_inventory_checkpoint_issues VALUES('2026-10-05 07:00Z','fixture',md5('1')::uuid,1);
 INSERT INTO public.union_pnl_inventory_seal_layers
 SELECT '2026-10-12 07:00Z',s+interval '6 hours',s,'2026-10-05 07:00Z',0,0,1,now()
 FROM generate_series('2026-10-05 07:00Z'::timestamptz,'2026-10-11 19:00Z',interval '6 hours') s;
 """)
def bootstrap_installed(install_bucketed=True):
 sql(files=[fx/'bootstrap.sql',*sorted((fx/'preimage').glob('*.sql')),root/'supabase/migrations/20261012134146_the_weekly_close_never_holds_replication.sql'])
 sql("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[]); CREATE TABLE freeze_fixture(singleton boolean PRIMARY KEY,active boolean NOT NULL); INSERT INTO freeze_fixture VALUES(true,false); CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT active FROM public.freeze_fixture WHERE singleton$$;")
 for version,filename in [('20261012134146','20261012134146_the_weekly_close_never_holds_replication.sql'),('20261012135622','20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql')]:
  raw=(root/'supabase/migrations'/filename).read_text().replace("'","''")
  sql("INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"',ARRAY['"+raw+"']);")
 if install_bucketed:sql(files=[fx/'original-6762.sql'])
# Successors installed over the candidate in every scenario that installs it:
# 20261019151632 proves the build bucket by bucket instead of one EXCEPT ALL.
SUCCESSORS=[root/'supabase/migrations/20261019151632_the_inventory_seal_proves_its_build_bucket_by_bucket.sql']
def install_candidate(candidate):
 sql(files=[candidate])
 sql("CREATE SCHEMA IF NOT EXISTS auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$; CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql AS $$SELECT NULL::text$$; CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;")
 for f in SUCCESSORS:sql(files=[f])
def advance():
 storage_guard()
 return json.loads(sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);").stdout.strip())
try:
 command([str(pg/'initdb'),'-D',str(work/'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 start();started=True
 sql('CREATE DATABASE broken;')
 database='broken'
 bootstrap_installed()
 seed(430000)
 refused=sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);",ok=False)
 assert refused.returncode!=0 and 'foreign key constraint' in refused.stderr,refused.stderr
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
 print('Original6762 native partial commit refused by deferred header FK',flush=True)
 database='postgres'
 bootstrap_installed(False)
 seed(rows)
 # A real original seal must perform the whole logged copy in one call.
 before_lsn=sql('SELECT pg_current_wal_insert_lsn();').stdout.strip()
 old=advance()
 old_wal=int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{before_lsn}')::bigint;").stdout)
 if rows==3400000:assert old_wal>1.5*1024**3
 print(f'Original whole-copy baseline: rows={rows}, transaction_WAL={old_wal}',flush=True)
 assert old['status']=='sealed'
 sql(files=[fx/'original-6762.sql'])
 expected=sql("SELECT row_count,issue_count,rows_md5,issues_md5,result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout
 # Isolated fixture cleanup; real immutable source migrations are never edited/replayed in production.
 sql("DELETE FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary='2026-10-12 07:00Z';DELETE FROM public.union_pnl_inventory_checkpoint_issues WHERE boundary='2026-10-12 07:00Z';DELETE FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';")
 sql("ALTER DATABASE postgres SET statement_timeout='240s';")
 candidate=root/'supabase/migrations/20261012200734_inventory_seal_pages_commit_before_their_immutable_header.sql'
 sql("UPDATE freeze_fixture SET active=true;")
 assert 'inventory_installation_requires_thawed_platform' in sql(files=[candidate],ok=False).stderr
 sql("UPDATE freeze_fixture SET active=false;")
 sql("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['drift'] WHERE version='20261012135622';")
 assert 'inventory_exact_installed_predecessor_history_required' in sql(files=[candidate],ok=False).stderr
 raw=(root/'supabase/migrations/20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql').read_text().replace("'","''")
 sql("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['"+raw+"'] WHERE version='20261012135622';")
 # Original writer owns the same advisory boundary: admission must refuse immediately.
 args=[str(pg/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',str(sock),'-p',port,'-U','postgres',database,'-f','-']
 holder=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 holder.stdin.write("BEGIN; SET application_name='inventory-original-install-owner'; SELECT pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0)); SELECT pg_sleep(60); ROLLBACK;")
 holder.stdin.close()
 try:
  deadline=time.monotonic()+10
  while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='inventory-original-install-owner' AND wait_event='PgSleep';").stdout.strip()!='1':
   if time.monotonic()>deadline:raise AssertionError('original writer did not acquire admission lock')
   time.sleep(.05)
  blocked=sql(files=[candidate],ok=False)
  assert blocked.returncode and 'inventory_original_writer_owns_installation_boundary' in blocked.stderr,blocked.stderr
 finally:
  sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='inventory-original-install-owner';")
  holder.wait(timeout=10)
 # A changed actual deferred FK is not an admitted predecessor; rollback restores it.
 fk=sql("SELECT quote_ident(conname) FROM pg_constraint WHERE conrelid='public.union_pnl_inventory_checkpoint_rows'::regclass AND contype='f';").stdout.strip()
 drift=sql('BEGIN; ALTER TABLE public.union_pnl_inventory_checkpoint_rows DROP CONSTRAINT '+fk+';'+candidate.read_text(),ok=False)
 assert drift.returncode and 'inventory_original_deferred_header_constraints_required' in drift.stderr,drift.stderr
 assert sql("SELECT count(*) FROM pg_constraint WHERE conrelid='public.union_pnl_inventory_checkpoint_rows'::regclass AND contype='f' AND condeferrable AND condeferred;").stdout.strip()=='1'
 install_candidate(candidate)
 definitions=json.loads(sql("SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN ('fn_union_pnl_inventory_state','fn_union_pnl_inventory_layer_state','fn_union_pnl_inventory_seal_advance','fn_union_pnl_inventory_checkpoint_seal','fn_union_pnl_prove_opening_registrations','fn_union_pnl_inventory_checkpoint_due','fn_union_pnl_inventory_seal_in_progress','fn_union_pnl_inventory_build_population','fn_union_pnl_inventory_build_transition','fn_union_pnl_inventory_seal_write_page','fn_union_pnl_inventory_build_state','fn_union_pnl_inventory_snapshot_restore','fn_union_pnl_inventory_snapshot_save');").stdout)
 repeated=sql(files=[candidate],ok=False)
 assert repeated.returncode!=0
 wals=[]
 before=sql('SELECT pg_current_wal_insert_lsn();').stdout.strip()
 out=advance();assert out['status']=='sealing'
 wals.append(int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{before}')::bigint;").stdout))
 saved_cursor=sql('SELECT last_kind,last_source,last_row,last_event FROM public.union_pnl_inventory_seal_builds;').stdout
 saved_rows=sql('SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;').stdout
 sql("BEGIN;SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);ROLLBACK;")
 assert sql('SELECT last_kind,last_source,last_row,last_event FROM public.union_pnl_inventory_seal_builds;').stdout==saved_cursor
 assert sql('SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;').stdout==saved_rows
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
 saved=sql("SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;").stdout.strip()
 command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-m','immediate','stop']);started=False
 start();started=True
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;").stdout.strip()==saved
 # Crash clears the unlogged layers, so the real advance regenerates them from original inputs.
 for i in range((rows//10000)+20):
  before=sql('SELECT pg_current_wal_insert_lsn();').stdout.strip()
  out=advance()
  wals.append(int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{before}')::bigint;").stdout))
  if (i+1)%32==0:print(f'Committed bounded pages={i+2}, max_transaction_WAL={max(wals)}',flush=True)
  if out['status']=='sealed':break
  assert out['status']=='sealing'
 else:raise AssertionError('finite fixture did not publish')
 actual=sql("SELECT row_count,issue_count,rows_md5,issues_md5,result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout
 assert expected==actual,(expected,actual)
 assert advance()['status']=='already_sealed'
 assert json.loads(sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',true);").stdout)['status']=='verified'
 assert int(sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip())==rows
 assert int(sql("SELECT count(*) FROM public.fn_union_pnl_inventory_state('2026-10-12 07:00Z','2026-10-12 07:00Z') WHERE o_kind='row';").stdout.strip())==rows
 assert sql("SELECT md5(public.fn_union_pnl_inventory_population('2026-10-12 07:00Z','2026-10-12 07:00Z')::text)=result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='t'
 sql(f"INSERT INTO public.union_pnl_inventory_events SELECT {rows+1},'fixture',row_id,'2026-10-12 08:00Z',pg_current_xact_id(),'UPDATE',after_row,jsonb_set(after_row,'{{value}}','99999999') FROM public.union_pnl_inventory_seal_build_rows WHERE boundary='2026-10-12 07:00Z' AND row_id=md5('1')::uuid;")
 assert sql("SELECT count(*)=2 AND count(*) FILTER(WHERE o_kind='row' AND o_first_operation='baseline' AND o_after_row->>'value'='99999999')=1 FROM public.fn_union_pnl_inventory_layer_state('2026-10-12 07:00Z','2026-10-12 13:00Z','2026-10-12 07:00Z','2026-10-12 13:00Z');").stdout.strip()=='t'
 assert max(wals)<old_wal and max(wals)<128*1024*1024
 for table in ('union_pnl_inventory_seal_build_rows','union_pnl_inventory_seal_build_issues'):
  refused=sql(f"DELETE FROM public.{table};",ok=False);assert refused.returncode!=0
 for role in ('anon','authenticated','service_role'):
  refused=sql(f"SET ROLE {role}; SELECT * FROM public.union_pnl_inventory_published_rows;",ok=False);assert refused.returncode!=0
 sql('CREATE DATABASE mismatch;')
 database='mismatch'
 bootstrap_installed()
 seed(30000);install_candidate(candidate);assert advance()['status']=='sealing'
 # Fault only the isolated disposable cache, ahead of the committed cursor.
 # A new durable page will copy the altered value; its independent original checksum must refuse publication.
 sql("UPDATE public.union_pnl_inventory_seal_snapshot SET o_after_row=jsonb_set(o_after_row,'{value}','77777777') WHERE o_kind='row' AND o_row_id=(SELECT max(o_row_id::text)::uuid FROM public.union_pnl_inventory_seal_snapshot WHERE o_kind='row');")
 for i in range(10):
  refused=sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);",ok=False)
  if refused.returncode:break
 else:raise AssertionError('A corrupted source cache was incorrectly published')
 assert 'inventory_build_checksum_disagrees_with_original_source' in refused.stderr,refused.stderr
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
 # A cache changed AFTER its row was copied: the build still equals the original
 # assembly, but the bucket proof must refuse publication (20261019151632).
 sql('CREATE DATABASE cachedrift;');database='cachedrift'
 bootstrap_installed()
 seed(30000);install_candidate(candidate)
 for i in range(20):
  advance()
  if int(sql("SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;").stdout.strip())==30000:break
 else:raise AssertionError('cachedrift pages did not complete')
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
 sql("UPDATE public.union_pnl_inventory_seal_snapshot SET o_after_row=jsonb_set(o_after_row,'{value}','66666666') WHERE o_kind='row' AND o_row_id=(SELECT min(o_row_id::text)::uuid FROM public.union_pnl_inventory_seal_snapshot WHERE o_kind='row');")
 refused=sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);",ok=False)
 assert refused.returncode and 'inventory_build_disagrees_with_assembled_source' in refused.stderr,refused.stderr
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
 print('Bucket proof refuses a cache that drifted after its rows were copied',flush=True)
 sql('CREATE DATABASE concurrent;');database='concurrent'
 bootstrap_installed()
 seed(50000);install_candidate(candidate)
 from concurrent.futures import ThreadPoolExecutor
 with ThreadPoolExecutor(max_workers=2) as pool:
  receipts=list(pool.map(lambda _:advance(),range(2)))
 assert all(r['status']=='sealing' for r in receipts),receipts
 for i in range(10):
  if advance()['status']=='sealed':break
 else:raise AssertionError('Concurrent pages did not complete')
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='50000'
 sql('CREATE DATABASE backlog;');database='backlog'
 bootstrap_installed()
 seed(35000);install_candidate(candidate)
 assert advance()['status']=='sealing'
 retained=sql("SELECT last_kind,last_source,last_row,last_event FROM public.union_pnl_inventory_seal_builds WHERE boundary='2026-10-12 07:00Z';").stdout
 # A past empty boundary switches the single source cache while current build pages remain durable.
 pending=json.loads(sql("SELECT public.fn_union_pnl_inventory_checkpoint_due();").stdout)
 assert pending['status']=='sealing' and len(pending['sealed'])==1 and pending['progress']['stage']=='pending_boundary',pending
 assert sql("SELECT last_kind,last_source,last_row,last_event FROM public.union_pnl_inventory_seal_builds WHERE boundary='2026-10-12 07:00Z';").stdout==retained
 # THE BUDGET IS DERIVED FROM THE BOUNDARIES DUE, NEVER A CONSTANT (2026-10-26).
 # fn_union_pnl_inventory_checkpoint_due walks every closed week from the fixed
 # 2026-10-12 build to this Monday, so the number of boundaries it must seal
 # grows by one every week while this fixture stands still. Each boundary takes
 # a bounded number of chunked calls (measured 2026-10-26 on this fixture: one
 # pending_boundary answer and three committed_build_page answers). A constant
 # budget of ten covered two boundaries (seven calls) through 2026-10-25 and
 # refused three (eleven calls) from Monday 2026-10-26 07:00 UTC, failing every
 # shard 3/4 on main and every pull request behind it. The loop below asks the
 # database how many boundaries are due and allows five calls for each.
 due_boundaries=int(sql("WITH RECURSIVE w(b) AS (SELECT '2026-10-12 07:00Z'::timestamptz UNION ALL SELECT public.fn_union_week_start(b+interval '8 days') FROM w WHERE public.fn_union_week_start(b+interval '8 days')<=clock_timestamp()) SELECT count(*) FROM w;").stdout.strip())
 assert due_boundaries>=2,due_boundaries
 budget=5*due_boundaries
 for i in range(budget):
  due=json.loads(sql("SELECT set_config('app.weekly_accounting_chunked','on',false);SELECT public.fn_union_pnl_inventory_checkpoint_due();").stdout.splitlines()[-1])
  if due['status']=='ready':break
  assert due['status']=='sealing',due
 else:raise AssertionError(f'Backlog never reached truthful readiness: {due_boundaries} boundaries due, {budget} chunked calls allowed')
 # Readiness is truthful only when every due week carries its checkpoint.
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_checkpoints WHERE boundary>='2026-10-12 07:00Z';").stdout.strip()==str(due_boundaries),due_boundaries
 assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='35000'
 # Actual population source names must prove nonempty consumer equivalence.
 sql('CREATE DATABASE population;');database='population'
 bootstrap_installed()
 seed(1);sql(files=[fx/'population.sql'])
 original_population=json.loads(sql("SELECT public.fn_union_pnl_inventory_population('2026-10-05 07:00Z','2026-10-12 07:00Z');").stdout)
 expected_population_counts={name:1 for name in ('union_clubs','tables','table_seats','tournaments','tournament_players')}
 assert {k:len(v) for k,v in original_population['population'].items()}==expected_population_counts,original_population
 for name,eid in {'union_clubs':1,'tables':3,'table_seats':6,'tournaments':9,'tournament_players':13}.items():
  row=original_population['population'][name][0]
  assert row['source_event_id']==eid and row['row']['id']==f'00000000-0000-0000-0000-{eid:012x}',row
 assert len(original_population['issues'])==2,original_population
 assert {i['reason'] for i in original_population['issues']}=={'active_row_original_population_missing','original_inventory_chain_disagrees'}
 assert advance()['status']=='sealed'
 original_population_header=sql("SELECT row_count,issue_count,rows_md5,issues_md5,result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout
 assert json.loads(sql("SELECT public.fn_union_pnl_inventory_population('2026-10-12 07:00Z','2026-10-12 07:00Z');").stdout)==original_population
 sql("DELETE FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary='2026-10-12 07:00Z';DELETE FROM public.union_pnl_inventory_checkpoint_issues WHERE boundary='2026-10-12 07:00Z';DELETE FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';")
 install_candidate(candidate);assert advance()['status']=='sealing'
 # Complete only the private marker in a rolled-back transaction: private readback
 # must equal the original while ordinary consumers still see no unpublished rows.
 private_receipt=json.loads(sql("BEGIN;SELECT public.fn_union_pnl_inventory_snapshot_restore('2026-10-12 07:00Z','2026-10-05 07:00Z');SELECT public.fn_union_pnl_inventory_seal_write_page('2026-10-12 07:00Z','2026-10-05 07:00Z');SELECT jsonb_build_object('private',public.fn_union_pnl_inventory_build_population('2026-10-12 07:00Z','2026-10-12 07:00Z'),'public',public.fn_union_pnl_inventory_population('2026-10-12 07:00Z','2026-10-12 07:00Z'));ROLLBACK;").stdout.splitlines()[-1])
 assert private_receipt['private']==original_population,private_receipt
 assert private_receipt['public']=={'population':{},'issues':[]},private_receipt
 assert advance()['status']=='sealed'
 published_population=json.loads(sql("SELECT public.fn_union_pnl_inventory_population('2026-10-12 07:00Z','2026-10-12 07:00Z');").stdout)
 assert published_population==original_population
 assert sql("SELECT row_count,issue_count,rows_md5,issues_md5,result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout==original_population_header
 assert sql("SELECT md5(public.fn_union_pnl_inventory_build_population('2026-10-12 07:00Z','2026-10-12 07:00Z')::text)=result_md5 FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='t'
 print('Nonempty original/private/published population parity: five source keys, five active rows, two original issues',flush=True)
 # Highly compressible TOAST values must still consume their full encoded budget.
 for name,size,oversized in (('compressed',5*1024*1024,False),('oversized',9*1024*1024,True)):
  sql(f'CREATE DATABASE {name};');database=name
  bootstrap_installed()
  seed(2)
  sql(f"UPDATE public.union_pnl_inventory_checkpoint_rows SET after_row=jsonb_build_object('padding',repeat('x',{size}));")
  assert sql("SELECT bool_and(pg_column_size(after_row)<octet_length(after_row::text)/10) FROM public.union_pnl_inventory_checkpoint_rows;").stdout.strip()=='t'
  install_candidate(candidate)
  if oversized:
   for i in range(3):
    refused=sql("SELECT public.fn_union_pnl_inventory_seal_advance('2026-10-12 07:00Z',false);",ok=False)
    if refused.returncode:break
   assert refused.returncode and 'inventory_build_row_exceeds_bounded_page' in refused.stderr,refused.stderr
   assert sql('SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;').stdout.strip()=='0'
  else:
   assert advance()['status']=='sealing'
   assert int(sql('SELECT count(*) FROM public.union_pnl_inventory_seal_build_rows;').stdout.strip())<=1
   assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='0'
   for i in range(8):
    if advance()['status']=='sealed':break
   else:raise AssertionError('Compressible rows did not complete')
   assert sql("SELECT count(*) FROM public.union_pnl_inventory_published_rows WHERE boundary='2026-10-12 07:00Z';").stdout.strip()=='2'
 database='postgres'
 result=dict(status='passed',rows=rows,installation_freeze_history_writer_fk_refusals=True,nonempty_population_parity=True,population_active_counts=expected_population_counts,population_issue_count=2,old_one_transaction_wal=old_wal,bounded_transactions_wal=wals,compressed_budget_verified=True,oversized_refused=True,backlog_truthful=True,concurrency_verified=True,checksum_refused=True,bucket_proof_refused_cache_drift=True,header_equivalent=True,crash_resumed=True,partial_hidden=True,replay_refused=True,definitions=definitions,storage=str(work))
 (work/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'data'),'-m','fast','stop'],capture_output=True,env=env)
 status=subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'data'),'status'],capture_output=True,env=env)
 if status.returncode!=0:shutil.rmtree(work/'data',ignore_errors=True)
