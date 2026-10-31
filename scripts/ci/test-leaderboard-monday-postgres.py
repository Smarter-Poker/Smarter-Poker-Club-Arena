#!/usr/bin/env python3
"""Install exact owners and exercise their real entry/advance paths on PG17."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args();root=Path(__file__).resolve().parents[2]
a.scratch.mkdir(parents=True,exist_ok=True);base=Path(tempfile.mkdtemp(prefix='lm-',dir=a.scratch));started=False
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
 # Use a short socket directory even when the task's source path is long.
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f"-h '' -k {base}",'-w','start']);started=True
 q("""CREATE ROLE service_role;CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigint,jobname text,command text,active boolean,schedule text);
 INSERT INTO cron.job VALUES(190,'leaderboard-payout-waterfall-daily','SELECT public.fn_settle_due_leaderboards();',true,'20 0 * * *');
 CREATE FUNCTION cron.alter_job(job_id bigint,schedule text,command text)RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET schedule=$2,command=$3 WHERE jobid=$1$$;
 CREATE TABLE leaderboard_reward_program_versions(club_id uuid,weekly_effective_from date,monthly_effective_from date);
 CREATE TABLE leaderboard_payout_batches(club_id uuid,period text,period_start date,UNIQUE(club_id,period,period_start));
 CREATE TABLE leaderboard_payout_failures(club_id uuid,period text,period_start date,error_message text,error_code text,failed_at timestamptz,first_failed_at timestamptz,attempt_count int,resolved_at timestamptz,resolution text,UNIQUE(club_id,period,period_start));
 CREATE TABLE fixture_clock(at timestamptz);INSERT INTO fixture_clock VALUES('2026-11-02 07:59:59Z');
 CREATE FUNCTION fixture_now()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT at FROM fixture_clock$$;
 CREATE TABLE fixture_calls(period text,period_start date);
 CREATE FUNCTION fn_get_leaderboard_reward_plan(uuid,text,date)RETURNS jsonb LANGUAGE sql AS $$SELECT '{"rewards_enabled":true,"payout_metric":"hands_played"}'::jsonb$$;
 CREATE FUNCTION fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO fixture_calls VALUES($2,($4 AT TIME ZONE 'UTC')::date);INSERT INTO leaderboard_payout_batches VALUES($1,$2,($4 AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING;RETURN '{"already_settled":false}'::jsonb;END$$;
 """)
 calendar=(root/'supabase/migrations/20260831000500_leaderboard_canonical_period_windows.sql').read_text()
 start=calendar.index('CREATE OR REPLACE FUNCTION public.fn_leaderboard_period_window')
 end=calendar.index('$function$;',start)+len('$function$;')
 q(calendar[start:end])
 original=(root/'scripts/ci/fixtures/leaderboard-monday/fn_settle_due_leaderboards.sql').read_text();q(original)
 assert q("SELECT md5(pg_get_functiondef('fn_settle_due_leaderboards()'::regprocedure))")=='d0d452a2d2c96400743972370d0f6ece'
 migration=(root/'supabase/migrations/20261028162924_leaderboard_monday_chicago_payout_time.sql').read_text()
 before=q("SELECT jsonb_build_array(oid,proowner,proacl,prosecdef,provolatile,proconfig) FROM pg_proc WHERE oid='fn_settle_due_leaderboards()'::regprocedure")
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_rollback';END$$;COMMIT;"),'forced_rollback')
 assert q("SELECT schedule FROM cron.job WHERE jobid=190")=='20 0 * * *'
 q(migration)
 assert q("SELECT jsonb_build_array(oid,proowner,proacl,prosecdef,provolatile,proconfig) FROM pg_proc WHERE oid='fn_settle_due_leaderboards()'::regprocedure")==before
 assert q("SELECT schedule FROM cron.job WHERE jobid=190")=='0 7,8 * * 1'
 cases=[('weekly','2026-10-25','2026-10-26 07:00:00+00'),('weekly','2026-11-01','2026-11-02 08:00:00+00'),('monthly','2026-11-01','2026-11-02 08:00:00+00'),('monthly','2026-06-01','2026-06-01 07:00:00+00'),('monthly','2027-01-01','2027-01-04 08:00:00+00'),('weekly','2026-03-08','2026-03-09 07:00:00+00')]
 for period,end,expected in cases:
  assert q(f"SET timezone='UTC';SELECT fn_leaderboard_payout_due_at('{period}','{end}')")==expected
 q("SELECT fn_leaderboard_payout_due_at('daily','2026-11-01')",'Unsupported Leaderboard Payout Period')
 assert q("SELECT has_function_privilege('service_role','fn_leaderboard_payout_due_at(text,date)','EXECUTE')")=='t'
 changed=q("SELECT pg_get_functiondef('fn_settle_due_leaderboards()'::regprocedure)")
 # Clock substitution only in the disposable installed worker: all candidate,
 # program, duplicate-batch and exception logic remains the exact real body.
 q(changed.replace('now()','public.fixture_now()'))
 q("INSERT INTO leaderboard_reward_program_versions VALUES(md5('club')::uuid,'2026-10-25','2026-10-01')")
 # Period calendar must use the same fixture reference as the worker.
 cal=q("SELECT pg_get_functiondef('fn_leaderboard_period_window(text,integer,timestamptz)'::regprocedure)")
 q(cal.replace('DEFAULT now()','DEFAULT public.fixture_now()'))
 early=json.loads(q('SELECT fn_settle_due_leaderboards()'));assert early['settled']==0
 q("UPDATE fixture_clock SET at='2026-11-02 08:00:00Z'")
 due=json.loads(q('SELECT fn_settle_due_leaderboards()'));assert due['settled']==2,due
 assert q('SELECT count(*) FROM fixture_calls')=='2'
 replay=json.loads(q('SELECT fn_settle_due_leaderboards()'));assert replay['settled']==0,(replay,q('TABLE leaderboard_payout_batches'),q('TABLE leaderboard_payout_failures'))
 assert q('SELECT count(*) FROM fixture_calls')=='2'
 command=q('SELECT command FROM cron.job WHERE jobid=190')
 # Execute both UTC ticks with the actual installed scheduler command.
 for at,expect_call in [('2026-11-02 07:00Z',False),('2026-11-02 08:00Z',True),('2026-10-26 07:00Z',True),('2026-10-26 08:00Z',False),('2026-11-03 08:00Z',False)]:
  q("TRUNCATE fixture_calls;UPDATE fixture_clock SET at='"+at+"'")
  # Replace worker in isolation with call recording to test trigger wiring.
  q("CREATE OR REPLACE FUNCTION fn_settle_due_leaderboards()RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO fixture_calls VALUES('tick',NULL);RETURN '{}'::jsonb;END$$")
  q(command.replace('now()','public.fixture_now()'))
  assert int(q('SELECT count(*) FROM fixture_calls'))==int(expect_call),(at,expect_call)
 print(json.dumps({'qualification':'passed','calendar_cases':len(cases),'weekly_monthly_due_gate':True,'duplicate_noop':True,'dst_twin_tick_guard':True,'rollback_atomic':True,'worker_metadata_preserved':True,'production_money':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
