#!/usr/bin/env python3
"""Local PG17 owned-pause protocol qualification.
Controlled clock and lease rows only. This suite does NOT yet qualify original
financial stages, whole fleet runtime parking or production timing.
"""
import argparse,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2]
a=argparse.ArgumentParser();a.add_argument('--scratch',required=True);args=a.parse_args()
P=Path(args.scratch).resolve()
if sys.platform=='darwin' and not P.is_relative_to('/Volumes/SmarterWork/agent-work'):raise RuntimeError('owned SSD scratch required')
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database forbidden')
P.mkdir(parents=True,exist_ok=True)
pg=Path('/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else '/usr/lib/postgresql/17/bin')
W=Path(tempfile.mkdtemp(prefix='weekly-pause-',dir=P));D=W/'data';started=False
E=dict(os.environ,LC_ALL='C',LANG='C',PGTZ='UTC')
def run(argv,s=None,error=None):
 q=subprocess.run(list(map(str,argv)),input=s,text=True,capture_output=True,env=E,timeout=60)
 if error:assert q.returncode and error in q.stderr,(error,q.stdout,q.stderr)
 else:assert q.returncode==0,q.stdout+q.stderr
 return q.stdout.strip()
def sql(s,error=None):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',W,'-U','postgres','-d','postgres'],s,error)
def function_from_migration(version,name):
 t=next((R/'supabase/migrations').glob(version+'_*')).read_text();start=t.index('CREATE OR REPLACE FUNCTION public.'+name+'(');end=t.index('$function$;',start)+len('$function$;');return t[start:end]
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (D/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(W)+"'\n")
 try:
  run([pg/'pg_ctl','-D',D,'-l',W/'server.log','-w','start']);started=True
 except Exception:
  print((W/'server.log').read_text() if (W/'server.log').exists() else 'startup log absent');raise
 sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SCHEMA extensions;CREATE PUBLICATION supabase_realtime;")
 sql((R/'tests/fixtures/weekly-close-scale/preimage/fn_union_week_start.sql').read_text())
 sql(function_from_migration('20260907044041','fn_union_prev_week_start'))
 sql(function_from_migration('20260914110557','fn_union_accounting_run_at'))
 # Captured original function postimages can be parsed without pretending
 # that these three declaration-only relation shapes qualify money execution.
 schema=(R/'tests/fixtures/weekly-close-scale/schema-tables.sql').read_text()
 for name in ['accounting_routed_settlement_runs','accounting_rakeback_period_calculations']:
  start=schema.index('CREATE TABLE public.'+name+'(');end=schema.index(';',start)+1;sql(schema[start:end])
 sql("CREATE TABLE public.union_wallets(union_id uuid,chip_balance numeric,rake_wallet numeric);")
 authorities=json.loads((R/'scripts/ci/fixtures/weekly-payout-owned-phase/owner-authority.json').read_text())
 for owner in authorities:
  sig=owner['signature']
  sql('SET check_function_bodies=false;'+owner['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+
   ('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'if any(a.startswith('service_role=X')for a in owner['acl'])else''))
 sql("""CREATE FUNCTION public.fn_caller_is_engine()RETURNS boolean LANGUAGE sql AS $$SELECT current_user='postgres'$$;
 CREATE TABLE public.engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);
 CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);
 SET check_function_bodies=true;
 """+next((R/'supabase/migrations').glob('20261028162126_*')).read_text())
 sql("""CREATE TABLE fixture_clock(n timestamptz);INSERT INTO fixture_clock VALUES('2026-11-02 09:58:00Z');
 UPDATE smarter_private.weekly_payout_phase_configuration SET cutover_period_end='2026-11-02 08:00Z';
 CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_clock()RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$SELECT n FROM public.fixture_clock$$;
 INSERT INTO public.engine_table_leases VALUES('cae00000-0000-0000-0000-000000000001','fixture-engine','fixture',now(),'2026-11-02 09:58:00Z','cae00000-0000-0000-0000-000000000002',2);
 INSERT INTO public.weekly_accounting_payout_pauses(run_id,ownership_token,period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES('cae00000-0000-0000-0000-000000000003','cae00000-0000-0000-0000-000000000004','2026-10-26 07:00Z','2026-11-02 08:00Z','2026-11-02 09:58Z','2026-11-02 10:00Z','2026-11-02 10:04Z','2026-11-02 10:05Z','[{"kind":"union","id":"cae00000-0000-0000-0000-000000000005","period_start":"2026-10-26T07:00:00Z","period_end":"2026-11-02T08:00:00Z"}]');
 """)
 # The exact original engine's eight-second probe must still defer before
 # touching the financial helper or any expensive original scope owner.
 probe=json.loads(sql("SET statement_timeout='8s';SELECT public.fn_union_settlement_cascade_due();"))
 assert probe['deferred_to']=='union-weekly-rakeback-close' and probe['checked']==0
 sql("SELECT smarter_private.weekly_payout_execute('cae00000-0000-0000-0000-000000000003');",'weekly_payout_original_240s_tick_required')
 sql("SET ROLE service_role;SELECT smarter_private.weekly_payout_execute(NULL);",'permission denied')
 guard="SELECT smarter_private.weekly_payout_require_round('union','cae00000-0000-0000-0000-000000000005','2026-10-26 07:00Z','2026-11-02 08:00Z',2);"
 sql("SET app.freeze_bypass='on';"+guard,'weekly_payout_original_owned_phase_required')
 sql("""CREATE FUNCTION public.fn_weekly_accounting_deadline_check()RETURNS void LANGUAGE sql AS $$SELECT NULL::void$$;
 BEGIN;
 UPDATE fixture_clock SET n='2026-11-02 10:00Z';
 UPDATE public.weekly_accounting_payout_pauses SET phase='paying',acknowledged_at='2026-11-02 09:59Z';
 INSERT INTO smarter_private.weekly_payout_owned_transactions VALUES(pg_backend_pid(),txid_current(),'cae00000-0000-0000-0000-000000000003','union','cae00000-0000-0000-0000-000000000005','2026-10-26 07:00Z','2026-11-02 08:00Z',2);
 """+guard+"ROLLBACK;")
 assert sql("SELECT count(*)FROM smarter_private.weekly_payout_owned_transactions;")=='0'
 claims='[{"scope":"cash","table_id":"cae00000-0000-0000-0000-000000000001","tournament_id":null,"lease_generation":"cae00000-0000-0000-0000-000000000002"}]'
 call="SELECT public.fn_weekly_accounting_payout_pause_ack('cae00000-0000-0000-0000-000000000003','cae00000-0000-0000-0000-000000000004','fixture-engine',$claims$"+claims+"$claims$);"
 assert json.loads(sql(call))['boundary']['phase']=='ready'
 assert json.loads(sql(call))['boundary']['phase']=='ready'
 for bad in ['[]',claims.replace('000000000002','000000000099'),claims.replace('"tournament_id":null','"tournament_id":"cae00000-0000-0000-0000-000000000099"')]:
  sql(call.replace(claims,bad),'weekly_payout_complete_original_fleet_required')
 sql("SET ROLE authenticated;SELECT public.fn_weekly_accounting_payout_pause_ack(NULL,NULL,'x','[]');",'permission denied')
 assert json.loads(sql("UPDATE fixture_clock SET n='2026-11-02 10:00Z';UPDATE public.engine_table_leases SET heartbeat_at='2026-11-02 10:00Z';"+call))['boundary']['phase']=='ready'
 sql("UPDATE fixture_clock SET n='2026-11-02 10:04Z';UPDATE public.engine_table_leases SET heartbeat_at='2026-11-02 10:04Z';"+call,'weekly_payout_ack_outside_original_deadline')
 sql("UPDATE fixture_clock SET n='2026-11-02 10:05Z';")
 state=json.loads(sql("SELECT public.fn_weekly_accounting_payout_pause_state('cae00000-0000-0000-0000-000000000003','cae00000-0000-0000-0000-000000000004');"))
 assert state['boundary']['phase']=='released'
 assert sql("SELECT phase FROM public.weekly_accounting_payout_pauses;")=='ready','expiry must not forge financial completion'
 print('PASS owned protocol: whole draft parses; real calendar DST; complete fresh lease census; duplicate and at-four ACK; missing/foreign/shape/operator refusal; original money deadline refuses; expiry never marks paid. FINANCIAL/RUNTIME QUALIFICATION PENDING.')
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(W)
