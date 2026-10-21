#!/usr/bin/env python3
"""Qualify daily observation on isolated PostgreSQL; no production writes."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
MIGRATION=next((ROOT/'supabase/migrations').glob('*_daily_maintenance_circulation_marks_follow_chicago_boundarie.sql'))
with tempfile.TemporaryDirectory(prefix='marks-pg-') as folder:
    temp=Path(folder)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    def run(args,**kw):
        return subprocess.run([str(a) for a in args],text=True,capture_output=True,timeout=45,**kw)
    def sql(source,ok=True):
        r=run([PG/'psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],input=source)
        if ok and r.returncode: raise AssertionError(r.stderr)
        return r
    r=run([PG/'initdb','-D',temp/'data','-A','trust','-U','postgres','--no-locale']); assert r.returncode==0,r.stderr
    r=run([PG/'pg_ctl','-D',temp/'data','-l',temp/'log','-o',f"-h 127.0.0.1 -p {port} -k ''",'-w','start']); assert r.returncode==0,r.stderr
    try:
        original=(ROOT/'supabase/migrations/20260902211500_engine_restart_phase1_review_fixes.sql').read_text()
        original=original[original.index('CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark'):original.index('-- (3)')]
        sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE ca_freeze_circulation_marks(window_hour timestamptz,kind text,member_wallets numeric,on_the_felt numeric,total numeric,mark_at timestamptz DEFAULT now(),PRIMARY KEY(window_hour,kind));
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION fn_ca_circulation_total() RETURNS TABLE(member_wallets numeric,on_the_felt numeric,total numeric) LANGUAGE sql AS $$SELECT 900::numeric,100::numeric,1000::numeric$$;
CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text PRIMARY KEY,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN INSERT INTO cron.job VALUES($1,$2,$3) ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command; RETURN 1; END$$;
'''+original)
        migration=MIGRATION.read_text()
        sql(migration)
        replay=sql(migration,False); assert replay.returncode!=0 and 'preimage changed' in replay.stderr
        # Only the wall clock is injected into the exact installed function body.
        # Persistence, role grants, guards, duplicate behavior and cron SQL are real.
        start=migration.index('CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark')
        end=migration.index('END $function$;',start)+len('END $function$;')
        body=migration[start:end].replace('clock_timestamp()',"current_setting('test.at')::timestamptz")
        sql(body+'''DO $test$ DECLARE result timestamptz; BEGIN
  PERFORM set_config('test.at','2026-10-21 16:00Z',false);
  IF fn_ca_capture_freeze_mark('pre') IS NOT NULL THEN RAISE EXCEPTION 'ordinary hour sampled'; END IF;
  PERFORM set_config('test.at','2026-10-21 09:00Z',false);
  result:=fn_ca_capture_freeze_mark('pre');
  IF result IS DISTINCT FROM '2026-10-21 09:05Z'::timestamptz THEN RAISE EXCEPTION 'CDT key'; END IF;
  PERFORM set_config('test.at','2026-10-21 09:05Z',false);
  PERFORM fn_ca_capture_freeze_mark('post');
  IF (SELECT count(*) FROM ca_freeze_circulation_marks WHERE window_hour=result)<>2 THEN RAISE EXCEPTION 'missing pair'; END IF;
  PERFORM set_config('test.at','2026-10-21 09:05:20Z',false);
  PERFORM fn_ca_capture_freeze_mark('post');
  IF (SELECT mark_at FROM ca_freeze_circulation_marks WHERE window_hour=result AND kind='post') IS DISTINCT FROM '2026-10-21 09:05Z'::timestamptz THEN RAISE EXCEPTION 'duplicate overwrote actual edge'; END IF;
  IF (SELECT count(*) FROM ca_freeze_circulation_marks)<>2 THEN RAISE EXCEPTION 'duplicate changed pair'; END IF;
  PERFORM set_config('test.at','2026-11-01 09:00Z',false);
  IF fn_ca_capture_freeze_mark('pre') IS NOT NULL THEN RAISE EXCEPTION 'unused DST twin sampled'; END IF;
  PERFORM set_config('test.at','2026-11-01 10:00Z',false);
  IF fn_ca_capture_freeze_mark('pre') IS DISTINCT FROM '2026-11-01 10:05Z'::timestamptz THEN RAISE EXCEPTION 'CST key'; END IF;
  PERFORM set_config('test.at','2026-03-08 09:00Z',false);
  IF fn_ca_capture_freeze_mark('pre') IS DISTINCT FROM '2026-03-08 09:05Z'::timestamptz THEN RAISE EXCEPTION 'spring DST key'; END IF;
  PERFORM set_config('test.at','2026-10-22 09:05Z',false);
  IF fn_ca_capture_freeze_mark('post') IS NOT NULL THEN RAISE EXCEPTION 'orphan post accepted'; END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname='ca-freeze-mark-pre')<>'0 9,10 * * *' OR (SELECT schedule FROM cron.job WHERE jobname='ca-freeze-mark-post')<>'5 9,10 * * *' THEN RAISE EXCEPTION 'cron drift'; END IF;
  IF has_function_privilege('anon','fn_ca_capture_freeze_mark(text)','execute') OR has_function_privilege('authenticated','fn_ca_capture_freeze_mark(text)','execute') THEN RAISE EXCEPTION 'browser callable'; END IF;
END $test$;''')
        # Freeze never engages: refuse rather than fabricate pre evidence.
        no_wait=body.replace('i < 25','i < 0')
        sql('CREATE OR REPLACE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;'+no_wait+"SET test.at='2026-10-23 09:00Z'; DO $$BEGIN IF fn_ca_capture_freeze_mark('pre') IS NOT NULL THEN RAISE EXCEPTION 'missing freeze invented'; END IF; END$$;")
        print('PASS: exact migration, Chicago/DST marks, absent freeze, missing pre, replay refusal, ACL and existing cron wiring; production_writes=False')
    finally:
        r=run([PG/'pg_ctl','-D',temp/'data','-m','immediate','-w','stop']); assert r.returncode==0,r.stderr
