#!/usr/bin/env python3
"""Native parity of the original statement-trigger reporter and its set rebuild."""
import argparse,os,socket,tempfile,subprocess,json
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args();root=Path(__file__).resolve().parents[2]
b=Path(tempfile.mkdtemp(prefix='reporting-',dir=a.scratch.resolve()));pg=a.pg_bin
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={**os.environ,'TMPDIR':str(b)}
def run(argv,sql=None):
 r=subprocess.run([str(x)for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=90);assert r.returncode==0,r.stderr;return r.stdout.strip()
def q(s):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],s)
started=False
try:
 run([pg/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',b/'d','-l',b/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q("CREATE TABLE ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,cutoff_at timestamptz,undone_at timestamptz);CREATE TABLE rake_records(id uuid PRIMARY KEY,created_at timestamptz);CREATE TABLE rake_attributions(id uuid PRIMARY KEY,rake_record_id uuid,club_id uuid,player_id uuid,created_at timestamptz,rake_amount numeric);CREATE TABLE ca_club_rake_daily_user(club_id uuid,day date,user_id uuid,rake_cents bigint,hands bigint,updated_at timestamptz,PRIMARY KEY(club_id,day,user_id));CREATE INDEX ON rake_attributions(player_id,created_at);")
 q((root/'scripts/ci/fixtures/daily-reporting-original-owners.sql').read_text())
 q("CREATE TRIGGER report_change AFTER UPDATE ON rake_attributions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_user_change();")
 q("INSERT INTO rake_records SELECT md5(n::text)::uuid,CASE WHEN n%13=0 THEN NULL ELSE '2026-10-24 00:00Z'::timestamptz+(n%172800)*interval '1 second' END FROM generate_series(1,12000)n;INSERT INTO rake_attributions SELECT md5(n::text)::uuid,CASE WHEN n%17=0 THEN NULL ELSE md5(n::text)::uuid END,CASE WHEN n%23=0 THEN NULL ELSE md5(('club'||n%3)::text)::uuid END,CASE WHEN n%29=0 THEN NULL ELSE md5(('player'||n%40)::text)::uuid END,'2026-10-24 00:00Z'::timestamptz+(n%172800)*interval '1 second',CASE WHEN n%31=0 THEN NULL WHEN n%19=0 THEN -.01 ELSE (n%301)::numeric/1000 END FROM generate_series(1,12000)n;INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club0')::uuid,'2026-10-24 01:00Z',NULL),('club',md5('club1')::uuid,'2026-10-24 02:00Z',now());")
 original=q("SELECT pg_get_functiondef('trg_ca_club_rake_daily_user_change()'::regprocedure)")
 candidate=(root/'supabase/migrations/20261026212454_historical_club_corrections_rebuild_daily_reporting_once.sql').read_text()+(root/'supabase/migrations/20261026213150_daily_reporting_reads_hand_time_only_for_a_cutoff.sql').read_text()
 statements=["UPDATE rake_attributions SET club_id=md5('club2')::uuid WHERE id IN(SELECT id FROM rake_attributions ORDER BY id LIMIT 4000)","UPDATE rake_attributions SET player_id=md5('player41')::uuid,created_at=created_at+interval '1 day' WHERE id IN(SELECT id FROM rake_attributions ORDER BY id LIMIT 100)","UPDATE rake_attributions SET rake_amount=0 WHERE id IN(SELECT id FROM rake_attributions ORDER BY id LIMIT 100)","UPDATE rake_attributions SET club_id=NULL,player_id=NULL WHERE id IN(SELECT id FROM rake_attributions ORDER BY id LIMIT 50)","UPDATE rake_attributions SET rake_amount=rake_amount WHERE false"]
 def snapshot():return q("SELECT coalesce(jsonb_agg(to_jsonb(d)-'updated_at' ORDER BY club_id,day,user_id),'[]'::jsonb) FROM ca_club_rake_daily_user d")
 cases=0
 for zone in ['UTC','America/Los_Angeles']:
  for statement in statements:
   q('BEGIN;SET LOCAL TIME ZONE '+"'"+zone+"';"+statement+';CREATE TEMP TABLE expected_report AS SELECT * FROM ca_club_rake_daily_user;ROLLBACK;')
   expected=q('BEGIN;SET LOCAL TIME ZONE '+"'"+zone+"';"+statement+";SELECT coalesce(jsonb_agg(to_jsonb(d)-'updated_at' ORDER BY club_id,day,user_id),'[]'::jsonb) FROM ca_club_rake_daily_user d;ROLLBACK;")
   q(candidate)
   actual=q('BEGIN;SET LOCAL TIME ZONE '+"'"+zone+"';"+statement+";SELECT coalesce(jsonb_agg(to_jsonb(d)-'updated_at' ORDER BY club_id,day,user_id),'[]'::jsonb) FROM ca_club_rake_daily_user d;ROLLBACK;")
   assert json.loads(actual)==json.loads(expected),(zone,statement);q(original);cases+=1
 q(candidate)
 before=snapshot();q('BEGIN;'+statements[0]+';ROLLBACK;');assert snapshot()==before
 q("CREATE FUNCTION refuse_report() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'report_fixture_refusal';END$$;CREATE TRIGGER refuse_report BEFORE INSERT ON ca_club_rake_daily_user FOR EACH ROW EXECUTE FUNCTION refuse_report();")
 q('BEGIN;'+statements[0]+';ROLLBACK;');assert snapshot()==before
 print(json.dumps({'passed':True,'parity_cases':cases,'rows':12000,'rollback':True,'null_missing_records_and_cutoffs':True,'existing_warning_atomicity':True}))
finally:
 if started:run([pg/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
