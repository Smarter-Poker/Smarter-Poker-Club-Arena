#!/usr/bin/env python3
"""A repeat delivery addresses an operational alert row recorded unaddressed.

Regression test for migration
20260927160533_operational_alert_redelivery_addresses_an_unaddressed_row.sql.

On 2026-09-27 alertmanager rows first recorded on 2026-09-17 (before the
World Hub writer added payload.target_task_id) had been re-delivered 39 and 58
times with a payload that names the fleet, and the stored rows still named
nobody: fn_record_operational_alert's ON CONFLICT branch only bumped
last_received_at and delivery_count. OperationalAlertMissingTargetTaskId fired
on exactly those rows.

This builds an isolated PostgreSQL cluster behind a Unix socket (no TCP, so it
can never reach a real database), installs the EXACT production preimages
(the recorder, md5 36601e20..., and fn_ca_cash_failed_run_intake rebuilt from
supabase/components/cash-failed-run-intake.sql, md5 b1b3aa4e...), proves the
defect reproduces, applies the migration file unchanged, and proves:

  1. a redelivery that names a destination addresses a row that named none;
  2. evidence is never rewritten and an existing destination never replaced;
  3. the cash intake trigger now pins the new recorder and nothing else moved.

Run:  PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-operational-alert-redelivery-addressing.py
Exit 0 pass, 1 fail, 3 COULD NOT TELL (no PostgreSQL binaries).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260927160533_operational_alert_redelivery_addresses_an_unaddressed_row.sql'
INTAKE_COMPONENT = ROOT / 'supabase/components/cash-failed-run-intake.sql'
FLEET = '01a09b86-5ba8-7290-8657-1041f13dd3ca'
OLD_MD5 = '36601e205494e8768f5a1dce09f4a186'
NEW_MD5 = '4bab2581b3dff1e09b22d0df46c68df8'
INTAKE_MD5 = 'b1b3aa4e571504d1fa68b1baab72e8ba'
# Postimage md5 of the re-pinned intake: the closure proof names it.
INTAKE_POST_MD5 = '3ef722e8990b508b8741ee2e558f19c1'

# The production recorder as pg_get_functiondef printed it on 2026-09-27.
RECORDER_PREIMAGE = (
    "CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, "
    "p_alertname text, p_status text, p_severity text, p_payload jsonb)\n"
    " RETURNS bigint\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'public'\n"
    "AS $function$\nDECLARE v_id bigint;\nBEGIN\n"
    "  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)\n"
    "  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)\n"
    "  ON CONFLICT (source,event_key) DO UPDATE\n"
    "  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1\n"
    "  RETURNING id INTO v_id;\n  RETURN v_id;\nEND;\n$function$\n"
)

INTAKE_HEADER = (
    "CREATE OR REPLACE FUNCTION public.fn_ca_cash_failed_run_intake()\n RETURNS trigger\n"
    " LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n"
    " SET \"TimeZone\" TO 'UTC'\n SET lock_timeout TO '1s'\n"
)

SCHEMA = """
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA cron;
CREATE TABLE cron.job_run_details (jobid bigint, runid bigint, command text, status text,
  return_message text, start_time timestamptz, end_time timestamptz, database text, username text);
CREATE TABLE public.ca_cash_failed_run_outcomes (jobid bigint, runid bigint, snapshot_md5 text,
  run_snapshot jsonb, outcome text, receipt_id bigint, receipt_source text, receipt_key text,
  receipt_payload jsonb, intake_sqlstate text, intake_message text);
CREATE TABLE public.operational_alert_events (
  id bigserial PRIMARY KEY, source text NOT NULL, event_key text NOT NULL, alertname text NOT NULL,
  status text NOT NULL, severity text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_count integer NOT NULL DEFAULT 1,
  investigation_status text NOT NULL DEFAULT 'new', investigation jsonb,
  UNIQUE (source, event_key));
"""


def pg_bin():
    for candidate in (os.environ.get('PG_BIN'), '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin'):
        if candidate and Path(candidate, 'initdb').exists():
            return candidate
    return None


def intake_preimage():
    source = INTAKE_COMPONENT.read_text()
    ddl = re.search(r"v_handler_ddl constant text := \$ddl\$(CREATE OR REPLACE FUNCTION "
                    r"public\.fn_ca_cash_failed_run_intake\(\).*?\$body\$;)\$ddl\$", source, re.S)
    body = re.search(r"AS \$body\$(.*)\$body\$;", ddl.group(1), re.S).group(1)
    return INTAKE_HEADER + 'AS $function$' + body + '$function$\n'


class Cluster:
    def __init__(self, bin_dir):
        self.bin = bin_dir
        self.dir = tempfile.mkdtemp(prefix='oa-redelivery-')
        self.data = os.path.join(self.dir, 'data')
        subprocess.run([f'{self.bin}/initdb', '-D', self.data, '-A', 'trust', '-U', 'postgres'],
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run([f'{self.bin}/pg_ctl', '-D', self.data, '-w', '-l', os.path.join(self.dir, 'log'),
                        '-o', f"-p 5439 -k {self.dir} -c listen_addresses=''", 'start'],
                       check=True, stdout=subprocess.DEVNULL)

    def psql(self, sql, *, file=None):
        args = [f'{self.bin}/psql', '-h', self.dir, '-p', '5439', '-U', 'postgres', '-d', 'postgres',
                '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1']
        args += ['-f', str(file)] if file else ['-c', sql]
        env = dict(os.environ, PGOPTIONS='-c check_function_bodies=off')
        done = subprocess.run(args, capture_output=True, text=True, env=env)
        if done.returncode:
            raise RuntimeError(done.stderr.strip())
        return done.stdout.strip()

    def stop(self):
        subprocess.run([f'{self.bin}/pg_ctl', '-D', self.data, '-m', 'immediate', 'stop'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(self.dir, ignore_errors=True)


def record(db, key, payload):
    return db.psql("SELECT public.fn_record_operational_alert('alertmanager', '%s', 'OpenClawJobsHaveGoneSilent',"
                   " 'firing', 'warning', '%s'::jsonb)" % (key, json.dumps(payload)))


def stored(db, key):
    return json.loads(db.psql("SELECT json_build_object('payload', payload, 'deliveries', delivery_count)"
                              " FROM public.operational_alert_events WHERE event_key = '%s'" % key))


def main():
    bin_dir = pg_bin()
    if not bin_dir:
        print('COULD NOT TELL  no PostgreSQL binaries (set PG_BIN)')
        return 3
    failures = []

    def check(name, ok):
        print(('ok    ' if ok else 'FAIL  ') + name)
        if not ok:
            failures.append(name)

    intake = intake_preimage()
    check('fixture: recorder preimage is the production definition',
          hashlib.md5(RECORDER_PREIMAGE.encode()).hexdigest() == OLD_MD5)
    check('fixture: cash intake preimage is the production definition',
          hashlib.md5(intake.encode()).hexdigest() == INTAKE_MD5)

    db = Cluster(bin_dir)
    try:
        db.psql(SCHEMA)
        db.psql(RECORDER_PREIMAGE)
        db.psql("REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC;"
                " GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;")
        db.psql(intake)
        db.psql("REVOKE ALL ON FUNCTION public.fn_ca_cash_failed_run_intake() FROM PUBLIC;")
        check('installed preimages carry the production md5s',
              db.psql("SELECT md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))"
                      " || ',' || md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure))")
              == f'{OLD_MD5},{INTAKE_MD5}')

        evidence = {'alert': {'labels': {'alertname': 'OpenClawJobsHaveGoneSilent'}, 'startsAt': '2026-09-17T19:01:00Z'}}
        record(db, 'before-fix', evidence)
        record(db, 'before-fix', {**evidence, 'target_task_id': FLEET})
        check('defect reproduces on the preimage: redelivery leaves the row unaddressed',
              'target_task_id' not in stored(db, 'before-fix')['payload'])

        db.psql('', file=MIGRATION)
        check('migration installs the reviewed recorder',
              db.psql("SELECT md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))") == NEW_MD5)

        record(db, 'before-fix', {**evidence, 'target_task_id': FLEET})
        row = stored(db, 'before-fix')
        check('a redelivery that names the fleet addresses the stored row',
              row['payload'].get('target_task_id') == FLEET and row['deliveries'] == 3)
        check('evidence is kept exactly; only the destination is added',
              {k: v for k, v in row['payload'].items() if k != 'target_task_id'} == evidence)

        record(db, 'before-fix', {**evidence, 'target_task_id': 'another-task'})
        check('a destination the row already names is never replaced',
              stored(db, 'before-fix')['payload'].get('target_task_id') == FLEET)

        record(db, 'still-unaddressed', evidence)
        record(db, 'still-unaddressed', {**evidence, 'summary': 'a later value'})
        check('a redelivery without a destination changes nothing',
              stored(db, 'still-unaddressed')['payload'] == evidence)

        record(db, 'addressed', {**evidence, 'target_task_id': FLEET})
        record(db, 'addressed', {'rewritten': True, 'target_task_id': FLEET})
        check('an addressed row keeps its first evidence',
              stored(db, 'addressed')['payload'] == {**evidence, 'target_task_id': FLEET})

        intake_after = db.psql("SELECT pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure)")
        check('cash intake now pins the new recorder and nothing else changed',
              intake_after == intake.replace(OLD_MD5, NEW_MD5).strip())
        check('cash intake postimage carries the md5 the live proof names',
              db.psql("SELECT md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure))")
              == INTAKE_POST_MD5)
        check('cash intake keeps owner, SECURITY DEFINER, settings and ACL',
              db.psql("SELECT pg_get_userbyid(proowner) || '|' || prosecdef || '|' || proconfig::text || '|' || proacl::text"
                      " FROM pg_proc WHERE oid = 'public.fn_ca_cash_failed_run_intake()'::regprocedure")
              == 'postgres|true|{"search_path=pg_catalog, public",TimeZone=UTC,lock_timeout=1s}|{postgres=X/postgres}')

        try:
            db.psql('', file=MIGRATION)
            check('the migration refuses a second run (preimage guard)', False)
        except RuntimeError as error:
            check('the migration refuses a second run (preimage guard)', 'expected preimage' in str(error))
    finally:
        db.stop()

    print(f'{len(failures)} failure(s)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
