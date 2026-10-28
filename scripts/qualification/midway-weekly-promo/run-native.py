#!/usr/bin/env python3
"""Native PG17 weekly promo: actual disbursement, ledger and close trigger.
Only the due-time dependency is controlled to exercise future weekly closes.
No remote connection, production players or production writes.
"""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
P=pathlib.Path(__file__).resolve().parent
L=P/'lock-order'
R=P.parents[2]
a=argparse.ArgumentParser();a.add_argument('--output',type=pathlib.Path,required=True);args=a.parse_args()
O=args.output.resolve();O.mkdir(parents=True,exist_ok=True)
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database input forbidden')
if sys.platform=='darwin' and not str(O).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('owned SSD output required')
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(pathlib.Path(shutil.which('psql')).parent)))
assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
ENV={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C','PGCONNECT_TIMEOUT':'3','TMPDIR':str(O.parent)}
C=pathlib.Path(tempfile.mkdtemp(prefix='midway-pg-',dir=O.parent));S=C/'s';S.mkdir();port='56743';started=False
q=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',port,'-U','postgres','-d','r46_mtt_midway_promo']
def run(cmd,name,input=None,expect=None,timeout=180):
 r=subprocess.run([str(x) for x in cmd],input=input,text=True,capture_output=True,timeout=timeout,env=ENV)
 (O/(name+'.stdout')).write_text(r.stdout);(O/(name+'.stderr')).write_text(r.stderr)
 if expect:assert r.returncode!=0 and expect in r.stderr,(name,r.stderr[-3000:])
 else:assert r.returncode==0,(name,r.stderr[-3000:])
 return r.stdout.strip()
def sql(s,name,expect=None):return run(q,name,s,expect)
try:
 run([pg/'initdb','-D',C/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init')
 run([pg/'pg_ctl','-D',C/'d','-l',C/'server.log','-o',f"-k {S} -p {port} -h ''",'-w','start'],'start');started=True
 run([pg/'createdb','-h',S,'-p',port,'-U','postgres','r46_mtt_midway_promo'],'createdb')
 foundation=(R/'scripts/qualification/retained18-correction/fixtures/foundation.sql').read_text()
 # Load the complete captured financial base and its catalog assertions.
 # Its later tournament-only supplements and synthetic venue are unrelated.
 foundation=foundation[:foundation.index('SET LOCAL session_replication_role=replica;')]+ 'COMMIT;\n'
 sql(foundation,'actual-financial-foundation')
 # Current weekly coordinator added standalone scope after the captured base.
 sql('ALTER TABLE union_accounting_runs ADD COLUMN standalone_club_id uuid;','current-weekly-run-shape')
 stores=json.loads((P/'store-coverage.json').read_text())
 sql("INSERT INTO ca_chip_store_coverage SELECT * FROM jsonb_populate_recordset(NULL::ca_chip_store_coverage,$coverage$"+json.dumps(stores)+"$coverage$) ON CONFLICT(store) DO NOTHING;",'actual-store-coverage')
 auth=json.loads((P/'authorities.json').read_text())+json.loads((P/'ledger-authorities.json').read_text())+json.loads((P/'weekly-tick-authority.json').read_text())
 for row in auth:
  assert hashlib.md5(row['definition'].encode()).hexdigest()==row['definition_md5']
  signature='public.'+row['signature']
  grants='REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;'
  for role in ['PUBLIC','anon','authenticated','service_role']:
   if row['acl'] is None and role=='PUBLIC' or row['acl'] and (('=X/' in row['acl'] and role=='PUBLIC' and '{=X/' in row['acl']) or role+'=X/' in row['acl']):
    grants+='GRANT EXECUTE ON FUNCTION '+signature+' TO '+role+';'
  sql(row['definition']+';'+grants,row['signature'].split('(')[0]+'-captured-authority')
  assert sql("SELECT md5(pg_get_functiondef('public."+row['signature']+"'::regprocedure));",row['signature'].split('(')[0]+'-pin')==row['definition_md5']
 migration=(R/'supabase/migrations/20261016132743_midway_weekly_horse_promo_distribution.sql').read_text()
 sql(migration.replace('COMMIT;','ROLLBACK;'),'exact-installer-rollback')
 assert sql("SELECT to_regclass('union_weekly_horse_promo_runs') IS NULL;",'rollback-absence')=='t'
 sql(migration,'exact-installer')
 sql(migration,'installer-replay','midway_promo_install_replay')
 lock_migration=(R/'supabase/migrations/20261028012516_midway_promo_orders_player_keys_before_wallet_rows.sql').read_text()
 sql(lock_migration.replace('COMMIT;','ROLLBACK;'),'lock-installer-rollback')
 assert sql("SELECT md5(pg_get_functiondef('fn_midway_weekly_horse_promo(timestamptz,timestamptz)'::regprocedure));",'lock-rollback-original')=='3e159a80564f2860bed8041dbcd55263'
 # Source, full metadata and privilege drift refuse before any replacement.
 sql('ALTER FUNCTION public.fn_midway_weekly_horse_promo(timestamptz,timestamptz) COST 101;','lock-metadata-drift')
 sql(lock_migration,'lock-metadata-drift-refused','midway_promo_lock_order_owner_or_authority_changed')
 sql('ALTER FUNCTION public.fn_midway_weekly_horse_promo(timestamptz,timestamptz) COST 100;','lock-metadata-restore')
 sql((L/'core-original.sql').read_text().replace('v_i integer:=0','v_i integer:=1')+';','lock-source-drift')
 sql(lock_migration,'lock-source-drift-refused','midway_promo_lock_order_owner_or_authority_changed')
 sql((L/'core-original.sql').read_text()+';','lock-source-restore')
 sql('GRANT EXECUTE ON FUNCTION public.fn_midway_weekly_horse_promo(timestamptz,timestamptz) TO service_role;','lock-authority-drift')
 sql(lock_migration,'lock-authority-drift-refused','midway_promo_lock_order_owner_or_authority_changed')
 sql('REVOKE EXECUTE ON FUNCTION public.fn_midway_weekly_horse_promo(timestamptz,timestamptz) FROM service_role;','lock-authority-restore')
 sql(lock_migration,'lock-installer')
 sql(lock_migration,'lock-installer-replay','midway_promo_lock_order_owner_or_authority_changed')
 sql((P/'fixture.sql').read_text(),'fixture')
 # Complementary lock scenarios have their own copy of the real financial
 # fixture; their committed local setup cannot alter the legacy money cases.
 run([pg/'createdb','-h',S,'-p',port,'-U','postgres','--template','r46_mtt_midway_promo','promo_lock_doors'],'lock-fixture-copy')
 lock_q=q[:-1]+['promo_lock_doors']
 def lock_sql(source,name,expect=None):return run(lock_q,'locks-'+name,source,expect)
 import importlib.util
 spec=importlib.util.spec_from_file_location('promo_lock_cases',L/'cohort-concurrency.py');locks=importlib.util.module_from_spec(spec);spec.loader.exec_module(locks)
 locks.qualify(lock_sql,lock_q,O,ENV,L)
 run([pg/'dropdb','-h',S,'-p',port,'-U','postgres','promo_lock_doors'],'lock-fixture-drop')
 due_start=migration.index('CREATE FUNCTION public.fn_midway_weekly_horse_promo_due(')
 due_end=migration.index('END $function$;',due_start)+len('END $function$;')
 due_source=migration[due_start:due_end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
 sql(due_source.replace('p_period_end timestamptz DEFAULT NULL',"p_period_end timestamptz DEFAULT '2026-10-19 07:00Z'::timestamptz"),'future-clock-default-only')
 sql((P/'weekly-tick.sql').read_text(),'weekly-tick')
 sql(due_source,'restore-production-clock-default')
 sql((P/'regression.sql').read_text(),'regression')
 import time,importlib.util
 began=time.monotonic();sql((P/'scale.sql').read_text(),'scale')
 (O/'scale-duration.json').write_text(json.dumps({'wallets':2003,'seconds':time.monotonic()-began}))
 spec=importlib.util.spec_from_file_location('midway_concurrency',P/'concurrency.py');race=importlib.util.module_from_spec(spec);spec.loader.exec_module(race);race.qualify(sql,q,O,ENV)
 # Restore the authentic due-time dependency and verify premature payment refusal.
 calendar=next(x for x in auth if x['signature'].startswith('fn_union_accounting_run_at'))
 sql(calendar['definition']+';','authentic-due-time-restored')
 sql("SELECT public.fn_midway_weekly_horse_promo('2099-01-05 08:00Z','2099-01-12 08:00Z');",'premature-future-close','midway_promo_invalid_completed_week')
 sql("SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(oid)),'acl',proacl::text,'security_definer',prosecdef,'config',proconfig,'owner',pg_get_userbyid(proowner))) FROM pg_proc WHERE oid IN('fn_midway_weekly_horse_promo_close()'::regprocedure,'fn_midway_weekly_horse_promo(timestamptz,timestamptz)'::regprocedure,'fn_midway_weekly_horse_promo_due(timestamptz)'::regprocedure,'fn_union_settlement_cascade_due()'::regprocedure,'fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure);",'qualified-postimages')
 print('PASS native PG17 weekly promo installer, actual money/ledger path and regression')
 (O/'result.json').write_text(json.dumps({'status':'passed','migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'lock_migration_sha256':hashlib.sha256(lock_migration.encode()).hexdigest(),'production_writes':False,'controlled_dependency':'financial fixture: weekly due-time only; future weekly close simulation','lock_fixture_boundaries':'launch/fact readers and typed contributor accrual producer; actual batch/process/apply/profile/MFA/projector plus real promo/disburser/ledger retained; see lock-order README','source_authorities':{x['signature']:x['definition_md5'] for x in auth}},indent=2))
finally:
 if started:run([pg/'pg_ctl','-D',C/'d','-m','immediate','-w','stop'],'stop')
 if (C/'server.log').exists():shutil.copyfile(C/'server.log',O/'server.log')
 shutil.rmtree(C)
