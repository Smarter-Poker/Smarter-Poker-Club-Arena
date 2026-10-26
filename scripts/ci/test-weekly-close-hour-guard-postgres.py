#!/usr/bin/env python3
"""Install exact owners and exercise their real entry/advance paths on PG17."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args();root=Path(__file__).resolve().parents[2]
a.scratch.mkdir(parents=True,exist_ok=True);base=Path(tempfile.mkdtemp(prefix='hour-',dir=a.scratch));started=False
S='public.fn_process_weekly_accounting_scope(uuid,uuid)';W='public.fn_accounting_close_windows_advance_due()'
def run(args,s=None,error=None):
 r=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,timeout=90,env={**os.environ,'TMPDIR':str(base)})
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',base,'-U','postgres','-d','postgres'],s,error)
try:
 assert ' 17.' in run([a.pg_bin/'postgres','--version'])
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f"-h '' -k {base}",'-w','start']);started=True
 q("""CREATE TABLE fixture_control(frozen boolean,allowed boolean,at timestamptz);INSERT INTO fixture_control VALUES(false,true,'2026-10-26 14:46Z');
 CREATE FUNCTION fixture_clock()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT at FROM fixture_control$$;
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT allowed FROM fixture_control$$;
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM fixture_control$$;
 CREATE FUNCTION fn_union_week_start(timestamptz)RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1)$$;
 CREATE FUNCTION fn_accounting_close_seal_held(timestamptz)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION fn_accounting_split_advance_due()RETURNS jsonb LANGUAGE sql AS $$SELECT '{"advanced":true}'::jsonb$$;
 CREATE TABLE unions(id uuid);CREATE TABLE clubs(id uuid,is_union boolean);
 CREATE TABLE union_accounting_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,status text,result jsonb);
 CREATE TABLE accounting_routed_settlement_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,round_no int);
 CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,computed_at timestamptz);
 INSERT INTO union_accounting_runs VALUES('union',md5('union')::uuid,'2026-10-19','2026-10-26','running','{"chunk_committed":true,"stage":"prepared"}');
 CREATE FUNCTION fn_accounting_close_windows(timestamptz,timestamptz)RETURNS TABLE(window_start timestamptz,window_end timestamptz)LANGUAGE sql AS $$SELECT $1,$2$$;
 CREATE FUNCTION fn_accounting_close_proof_lifetime()RETURNS interval LANGUAGE sql AS $$SELECT interval '12 hours'$$;
 CREATE FUNCTION fn_settle_accounting_commission_advance(text,uuid,timestamptz,timestamptz)RETURNS void LANGUAGE sql AS $$INSERT INTO accounting_close_partials VALUES('round2_'||$1||'_window',$2,$3,$4,$3,$4,fixture_clock())$$;
 """)
 fixture=root/'scripts/ci/fixtures/weekly-close-hour-guard'
 originals={S:(fixture/'fn_process_weekly_accounting_scope.sql').read_text(),W:(fixture/'fn_accounting_close_windows_advance_due.sql').read_text()}
 for sig,s in originals.items():q(s)
 meta="SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict) ORDER BY oid) FROM pg_proc WHERE oid IN('"+S+"'::regprocedure,'"+W+"'::regprocedure)"
 before=q(meta);migration=(root/'supabase/migrations/20261026144155_weekly_close_uses_the_actual_maintenance_freeze.sql').read_text()
 q(migration.replace('BEGIN;','BEGIN;UPDATE fixture_control SET frozen=true;',1),'weekly_hour_guard_install_frozen')
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_rollback';END$$;COMMIT;"),'forced_rollback')
 assert q("SELECT md5(pg_get_functiondef('"+S+"'::regprocedure))")=='e5065fedd05b476e16bf9a0393f8bc05'
 q(migration);assert q(meta)==before
 changed={sig:q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)") for sig in originals}
 q(migration,'weekly_hour_guard_preimage_changed')
 # Substitute the clock only in the disposable exact definitions. Original
 # and changed functions otherwise execute their maintained entry paths.
 prefix="SET statement_timeout='20min';SET app.weekly_accounting_chunked='on';"
 def exercise(definitions,minute,frozen):
  for s in definitions.values():q(s.replace('clock_timestamp()','public.fixture_clock()'))
  q("UPDATE fixture_control SET at='2026-10-26 14:"+str(minute).zfill(2)+"Z',frozen="+str(frozen).lower()+";TRUNCATE accounting_close_partials;")
  scope=json.loads(q(prefix+'SELECT fn_process_weekly_accounting_scope(NULL,NULL)'))
  window=q(prefix+'SELECT fn_accounting_close_windows_advance_due()')
  parts=int(q('SELECT count(*) FROM accounting_close_partials'))
  return scope,window,parts
 for minute in [0,44,45,50,59]:
  old=exercise(originals,minute,False);new=exercise(changed,minute,False)
  assert new[0]['split_advance']['advanced'] is True and new[2]==1,(minute,new)
  if minute<45:assert old==new,(minute,old,new)
  else:assert old[0]['reason']=='maintenance_window' and old[2]==0,(minute,old)
  frozen=exercise(changed,minute,True);assert frozen[0]['reason']=='maintenance_window' and frozen[2]==0
 q('UPDATE fixture_control SET allowed=false;')
 q(prefix+'SELECT fn_process_weekly_accounting_scope(NULL,NULL)','not_authorised')
 print(json.dumps({'qualification':'passed','exact_owners':2,'removed_hour_guards':7,'minutes':[0,44,45,50,59],'original_refusal_reproduced':True,'scope_and_window_advance_verified':True,'daily_freeze_preserved':True,'authorization_preserved':True,'metadata_unchanged':True,'rollback_and_replay_refusal_verified':True,'production_money':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
